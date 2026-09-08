import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { z } from "zod";

import { embed, embedAll, meanVector } from "../embeddings";
import { chatText, isConfigured, parseLenientJson, type LlmUsage } from "../llm";
import { getLexicalIndex, phraseExists } from "../retrieval/lexical";
import { getCorpus } from "../store";
import { normalizeKey, tokenize } from "../text";
import { nearestVocabTerms } from "../vocab";
import type {
  AnswerShape,
  EntityType,
  ExpansionTerm,
  PlanFacet,
  QueryPlan,
} from "../types";
import { emit, withStage } from "./emit";
import { corpusDigest } from "./prime";
import type { AskStateType } from "./state";

const MAX_FACETS = 4;
const MAX_MODEL_EXPANSIONS = 16;
const MAX_INDEX_EXPANSIONS = 6;
const MAX_SUB_QUERIES_PER_FACET = 3;
const INDEX_EXPANSION_FLOOR = 0.42;

const ENTITY_TYPES = [
  "organization",
  "person",
  "place",
  "event",
  "concept",
  "mixed",
] as const;
const ANSWER_SHAPES = ["short_fact", "list", "explanation", "comparison"] as const;

const RawFacetSchema = z.object({
  label: z.string().min(1),
  intent: z.string().optional(),
  expansions: z.array(z.string()).optional(),
  subQueries: z.array(z.string()).optional(),
});

const RawPlanSchema = z.object({
  interpretation: z.string().optional(),
  entityType: z.string().optional(),
  answerShape: z.string().optional(),
  facets: z.array(RawFacetSchema).min(1),
  mustCover: z.array(z.string()).optional(),
});

export interface RawFacet {
  label: string;
  intent: string;
  expansions: string[];
  subQueries: string[];
}

interface RawPlan {
  interpretation: string;
  entityType: EntityType;
  answerShape: AnswerShape;
  facets: RawFacet[];
  mustCover: string[];
}

const SYSTEM_PROMPT = `You are the planning stage of a retrieval system that searches a fixed, private document library. You never answer the user's question — you decide what to look for.

Documents are found by embedding similarity and keyword matching, so a plan only works if it contains the words that plausibly appear in the text. A question can name a category while the documents only name its members.

Break the question into 1-4 facets. A facet is one independent condition a passage could satisfy on its own. For each facet:
- "expansions": concrete surface forms likely to appear verbatim in a document. Expand categories into their members, acronyms into their full names and vice versa, places into countries and their major cities, roles into job titles, people into aliases, nicknames, surnames and honorifics, and concepts into their common synonyms and near-synonyms. Be generous and specific: 8-16 terms.
- "subQueries": 1-3 sentences phrased the way a document would state the fact, not the way a user would ask for it.

Worked example. Question: "a business headquartered somewhere in the GCC".
One facet covers the corporate side, with expansions like company, firm, group, holding, headquarters, head office, HQ, registered office, incorporated.
Another covers Gulf geography, with expansions like Saudi Arabia, Riyadh, Jeddah, Dammam, United Arab Emirates, UAE, Dubai, Abu Dhabi, Sharjah, Qatar, Doha, Kuwait, Kuwait City, Bahrain, Manama, Oman, Muscat, Gulf Cooperation Council.
The same reasoning applies to any question: never rely on the questioner's wording alone.

An index vocabulary is provided. It lists terms that genuinely occur in the library. Prefer those when they fit the facet, but also add world-knowledge terms that are absent from it — a term missing from the list may still appear in the text.

Reply with JSON only, no prose and no code fences:
{"interpretation":"what the user is really asking, in one sentence","entityType":"organization|person|place|event|concept|mixed","answerShape":"short_fact|list|explanation|comparison","facets":[{"label":"short name","intent":"what a passage satisfying this facet would contain","expansions":["..."],"subQueries":["..."]}],"mustCover":["what a complete answer must state"]}`;

function buildUserPrompt(state: AskStateType): string {
  const shortlist = state.prime?.vocabularyShortlist ?? [];
  const vocabulary =
    shortlist.length > 0
      ? shortlist.map((entry) => `${entry.term} (${entry.documents} docs)`).join(", ")
      : "(no closely related terms indexed yet)";

  return [
    `Question: ${state.question}`,
    "",
    "Library contents:",
    corpusDigest(),
    "",
    "Index vocabulary nearest this question:",
    vocabulary,
  ].join("\n");
}

function coerceEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  const normalized = value?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return allowed.find((option) => option === normalized) ?? fallback;
}

function normalizeRaw(parsed: z.infer<typeof RawPlanSchema>, question: string): RawPlan {
  const facets: RawFacet[] = parsed.facets
    .slice(0, MAX_FACETS)
    .map((facet) => ({
      label: facet.label.trim().slice(0, 60),
      intent: (facet.intent ?? facet.label).trim().slice(0, 240),
      expansions: (facet.expansions ?? [])
        .map((term) => term.trim())
        .filter((term) => term.length > 1 && term.length <= 60),
      subQueries: (facet.subQueries ?? [])
        .map((query) => query.trim())
        .filter((query) => query.length > 3)
        .slice(0, MAX_SUB_QUERIES_PER_FACET),
    }))
    .filter((facet) => facet.expansions.length > 0 || facet.subQueries.length > 0);

  return {
    interpretation: parsed.interpretation?.trim() || question,
    entityType: coerceEnum(parsed.entityType, ENTITY_TYPES, "mixed"),
    answerShape: coerceEnum(parsed.answerShape, ANSWER_SHAPES, "explanation"),
    facets,
    mustCover: (parsed.mustCover ?? [])
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 6),
  };
}

/* ------------------------------------------------------- grounding the plan */

/**
 * Reconciles the planner's world knowledge with what the index actually holds:
 * every model term is checked for presence in the corpus, and the corpus itself
 * contributes extra terms near each facet that the model never proposed.
 */
export async function groundFacets(rawFacets: RawFacet[]): Promise<PlanFacet[]> {
  const corpus = getCorpus();
  const index = getLexicalIndex();

  const texts: string[] = [];
  const facetSlices = rawFacets.map((facet) => {
    const start = texts.length;
    texts.push(facet.intent || facet.label);
    for (const term of facet.expansions.slice(0, MAX_MODEL_EXPANSIONS)) texts.push(term);
    return { start, count: texts.length - start };
  });

  const vectors = await embedAll(texts);

  return rawFacets.map((facet, facetIndex) => {
    const { start, count } = facetSlices[facetIndex];
    const intentVector = vectors[start];
    const termVectors = vectors.slice(start + 1, start + count);
    const terms = facet.expansions.slice(0, MAX_MODEL_EXPANSIONS);

    const expansions: ExpansionTerm[] = [];
    const seen = new Set<string>();

    terms.forEach((term, i) => {
      const key = normalizeKey(term);
      if (!key || seen.has(key)) return;
      seen.add(key);

      const vector = termVectors[i];
      const { present, verbatim } = phraseExists(term, index);
      const nearest = vector ? nearestVocabTerms(vector, corpus.vocab, 1, 0.25)[0] : undefined;

      expansions.push({
        term,
        origin: "model",
        inCorpus: present,
        nearestCorpusTerm: verbatim ? term : (nearest?.term.term ?? null),
        similarity: verbatim ? 1 : nearest ? Number(nearest.similarity.toFixed(3)) : null,
      });
    });

    // The index gets a vote: terms the corpus uses for this facet's meaning.
    const centroid = meanVector(
      [intentVector, ...termVectors].filter((vector): vector is Float32Array => Boolean(vector)),
    );
    let added = 0;
    for (const match of nearestVocabTerms(centroid, corpus.vocab, 24, INDEX_EXPANSION_FLOOR)) {
      if (added >= MAX_INDEX_EXPANSIONS) break;
      const key = normalizeKey(match.term.term);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      added += 1;
      expansions.push({
        term: match.term.term,
        origin: "index",
        inCorpus: true,
        nearestCorpusTerm: match.term.term,
        similarity: Number(match.similarity.toFixed(3)),
      });
    }

    return {
      label: facet.label,
      intent: facet.intent,
      expansions,
      subQueries: facet.subQueries,
    };
  });
}

/* --------------------------------------------------------- fallback planner */

function guessEntityType(question: string): EntityType {
  const lower = question.toLowerCase();
  if (/\bwho\b|\bwhose\b|\bwhom\b/.test(lower)) return "person";
  if (/\bwhere\b|\bcity\b|\bcountry\b|\bheadquarter/.test(lower)) return "place";
  if (/\bwhen\b|\bdate\b|\byear\b/.test(lower)) return "event";
  if (/\bcompany\b|\bbusiness\b|\bfirm\b|\borganisation\b|\borganization\b/.test(lower)) {
    return "organization";
  }
  return "mixed";
}

function guessAnswerShape(question: string): AnswerShape {
  const lower = question.toLowerCase();
  if (/\bcompare\b|\bversus\b|\bvs\.?\b|\bdifference\b/.test(lower)) return "comparison";
  if (/\blist\b|\bwhich\b|\ball\b|\bevery\b|\bwhat are\b/.test(lower)) return "list";
  if (/^(who|when|where|how many|how much)\b/.test(lower)) return "short_fact";
  return "explanation";
}

/**
 * Builds a usable plan with no LLM at all: the question's own terms plus the
 * corpus vocabulary nearest to it. Keeps the app working when the free tier is
 * exhausted or no key is configured.
 */
export async function corpusOnlyPlan(question: string): Promise<QueryPlan> {
  const corpus = getCorpus();
  const index = getLexicalIndex();
  const questionVector = await embed(question);
  const tokens = tokenize(question);

  const literal = [...new Set(tokens.filter((token) => token.length >= 3))].slice(0, 12);
  const bigrams: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    const bigram = `${tokens[i]} ${tokens[i + 1]}`;
    if (phraseExists(bigram, index).verbatim) bigrams.push(bigram);
  }

  const neighbours = nearestVocabTerms(questionVector, corpus.vocab, 14, 0.3);

  const rawFacets: RawFacet[] = [
    {
      label: "asked terms",
      intent: `passages using the wording of the question: ${question}`,
      expansions: [...new Set([...bigrams.slice(0, 4), ...literal])],
      subQueries: [question],
    },
  ];

  if (neighbours.length > 0) {
    rawFacets.push({
      label: "related index terms",
      intent: `terms the library itself uses near this question`,
      expansions: neighbours.map((match) => match.term.term),
      subQueries: neighbours
        .slice(0, 2)
        .map((match) => `${question} ${match.term.term}`),
    });
  }

  const facets = await groundFacets(rawFacets);

  return {
    interpretation: `Planned without the language model: matched the question's own wording and the corpus terms closest to it.`,
    entityType: guessEntityType(question),
    answerShape: guessAnswerShape(question),
    facets,
    mustCover: [`a direct answer to: ${question}`],
    source: "fallback",
    notes: [],
  };
}

/* ------------------------------------------------------------------- node */

async function llmPlan(
  state: AskStateType,
  usage: LlmUsage,
): Promise<QueryPlan | null> {
  const raw = await chatText({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(state),
    usage,
    maxTokens: 1400,
    label: "plan",
  });

  const parsed = RawPlanSchema.safeParse(parseLenientJson(raw));
  if (!parsed.success) return null;

  const normalized = normalizeRaw(parsed.data, state.question);
  if (normalized.facets.length === 0) return null;

  return {
    interpretation: normalized.interpretation,
    entityType: normalized.entityType,
    answerShape: normalized.answerShape,
    facets: await groundFacets(normalized.facets),
    mustCover:
      normalized.mustCover.length > 0
        ? normalized.mustCover
        : [`a direct answer to: ${state.question}`],
    source: "llm",
    notes: [],
  };
}

export async function planNode(
  state: AskStateType,
  config: LangGraphRunnableConfig,
): Promise<Partial<AskStateType>> {
  return withStage(config, "plan", async () => {
    const usage = state.usage;
    let plan: QueryPlan | null = null;

    if (isConfigured()) {
      try {
        plan = await llmPlan(state, usage);
        if (!plan) {
          usage.notes.push("plan: model reply was not usable JSON; used the corpus-only planner.");
        }
      } catch (error) {
        usage.notes.push(
          `plan: ${error instanceof Error ? error.message : "planner call failed"}; used the corpus-only planner.`,
        );
      }
    } else {
      usage.notes.push("plan: no OPENROUTER_API_KEY, so the corpus-only planner ran.");
    }

    if (!plan) {
      usage.degraded = true;
      plan = await corpusOnlyPlan(state.question);
      plan.notes = [...usage.notes];
    }

    emit(config, { type: "plan", plan });
    emit(config, {
      type: "usage",
      llmCalls: usage.calls,
      models: usage.models,
      degraded: usage.degraded,
    });
    return { plan, usage };
  });
}
