import { embedAll } from "../embeddings";
import { getCorpus } from "../store";
import { normalizeKey, snippetOf } from "../text";
import type { QueryPlan, RetrievalStats, RetrievedPassage } from "../types";
import { searchDense } from "./dense";
import { fuse, type RankedList } from "./fuse";
import { getLexicalIndex, searchLexical } from "./lexical";
import { selectDiverse } from "./mmr";

const PER_LIST_LIMIT = 30;
const MAX_SUB_QUERIES = 10;
const DEFAULT_LIMIT = 8;
const QUESTION_FACET = "question";

/** Below these, a passage is dense-similarity noise rather than evidence. */
const WEAK_DENSE_SCORE = 0.35;
const MIN_PASSAGES = 3;

export interface RetrievalRequest {
  question: string;
  plan: QueryPlan;
  pass: number;
  limit?: number;
  /** Follow-up queries proposed by the verifier on a second pass. */
  extraQueries?: string[];
}

interface PlannedQuery {
  kind: "dense" | "lexical";
  facet: string;
  query: string;
  phrases: string[];
}

function buildQueries(request: RetrievalRequest): PlannedQuery[] {
  const { question, plan, extraQueries = [] } = request;
  const queries: PlannedQuery[] = [
    { kind: "dense", facet: QUESTION_FACET, query: question, phrases: [] },
    { kind: "lexical", facet: QUESTION_FACET, query: question, phrases: [] },
  ];

  let subQueryBudget = MAX_SUB_QUERIES;
  for (const facet of plan.facets) {
    const grounded = facet.expansions.filter((expansion) => expansion.inCorpus);
    const usable = grounded.length > 0 ? grounded : facet.expansions;
    const terms = usable.map((expansion) => expansion.term);
    const phrases = terms.filter((term) => term.includes(" "));

    // One lexical probe per facet: BM25 over every grounded term at once.
    if (terms.length > 0) {
      queries.push({
        kind: "lexical",
        facet: facet.label,
        query: [facet.label, ...terms].join(" "),
        phrases,
      });
    }

    // Entity-style expansions deserve their own probe so a single mention wins.
    for (const phrase of phrases.slice(0, 4)) {
      queries.push({ kind: "lexical", facet: facet.label, query: phrase, phrases: [phrase] });
    }

    queries.push({
      kind: "dense",
      facet: facet.label,
      query: `${facet.intent} ${terms.slice(0, 8).join(", ")}`.trim(),
      phrases: [],
    });

    for (const subQuery of facet.subQueries) {
      if (subQueryBudget <= 0) break;
      subQueryBudget -= 1;
      queries.push({ kind: "dense", facet: facet.label, query: subQuery, phrases: [] });
    }
  }

  for (const extra of extraQueries.slice(0, 4)) {
    queries.push({ kind: "dense", facet: "follow-up", query: extra, phrases: [] });
    queries.push({ kind: "lexical", facet: "follow-up", query: extra, phrases: [] });
  }

  return queries.filter((query) => normalizeKey(query.query).length > 1);
}

/** Prefers a window of text that actually contains one of the matched terms. */
function focusedSnippet(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= 260) return flat;

  const haystack = flat.toLowerCase();
  let position = -1;
  for (const term of terms) {
    const found = haystack.indexOf(term.toLowerCase());
    if (found !== -1 && (position === -1 || found < position)) position = found;
  }
  if (position <= 0) return snippetOf(flat);

  const start = Math.max(0, position - 90);
  const window = flat.slice(start, start + 300);
  const prefix = start > 0 ? "..." : "";
  return `${prefix}${snippetOf(window, 260)}`;
}

export async function retrievePassages(
  request: RetrievalRequest,
): Promise<{ passages: RetrievedPassage[]; stats: RetrievalStats }> {
  const started = Date.now();
  const chunks = getCorpus().chunks;
  const limit = request.limit ?? DEFAULT_LIMIT;

  if (chunks.length === 0) {
    return {
      passages: [],
      stats: {
        pass: request.pass,
        candidates: 0,
        denseQueries: 0,
        lexicalQueries: 0,
        returned: 0,
        ms: Date.now() - started,
      },
    };
  }

  const queries = buildQueries(request);
  const denseQueries = queries.filter((query) => query.kind === "dense");
  const lexicalQueries = queries.filter((query) => query.kind === "lexical");

  const denseVectors = await embedAll(denseQueries.map((query) => query.query));
  const lists: RankedList[] = [];

  denseQueries.forEach((query, i) => {
    const vector = denseVectors[i];
    if (!vector) return;
    lists.push({
      kind: "dense",
      query: query.query,
      facet: query.facet,
      hits: searchDense(vector, PER_LIST_LIMIT),
    });
  });

  const index = getLexicalIndex();
  for (const query of lexicalQueries) {
    lists.push({
      kind: "lexical",
      query: query.query,
      facet: query.facet,
      hits: searchLexical(query.query, query.phrases, PER_LIST_LIMIT, index),
    });
  }

  const fused = fuse(lists.filter((list) => list.hits.length > 0));
  const selected = selectDiverse(fused, { limit });

  // Drop passages that satisfied no facet and matched no term: in a small corpus
  // everything is weakly similar to everything, and that noise misleads the writer.
  const strong = selected.filter(
    (candidate) =>
      candidate.facets.size > 0 ||
      candidate.lexicalScore > 0 ||
      candidate.denseScore >= WEAK_DENSE_SCORE,
  );
  const kept = strong.length >= Math.min(MIN_PASSAGES, selected.length)
    ? strong
    : selected.slice(0, MIN_PASSAGES);

  const passages: RetrievedPassage[] = kept.map((candidate) => {
    const chunk = chunks[candidate.chunk];
    const matchedTerms = [...candidate.matchedTerms].slice(0, 12);
    const facetHits = [...candidate.facets].filter((facet) => facet !== QUESTION_FACET);

    return {
      chunkId: chunk.id,
      documentId: chunk.documentId,
      filename: chunk.filename,
      index: chunk.index,
      page: chunk.page,
      heading: chunk.heading,
      text: chunk.text,
      snippet: focusedSnippet(chunk.text, matchedTerms),
      denseScore: Number(candidate.denseScore.toFixed(4)),
      lexicalScore: Number(candidate.lexicalScore.toFixed(4)),
      fusedScore: Number(candidate.fused.toFixed(5)),
      facetHits,
      matchedTerms,
      origins: candidate.origins
        .sort((a, b) => a.rank - b.rank)
        .filter(
          (origin, i, all) =>
            all.findIndex((other) => other.query === origin.query && other.kind === origin.kind) === i,
        )
        .slice(0, 6),
    };
  });

  return {
    passages,
    stats: {
      pass: request.pass,
      candidates: fused.length,
      denseQueries: denseQueries.length,
      lexicalQueries: lexicalQueries.length,
      returned: passages.length,
      ms: Date.now() - started,
    },
  };
}
