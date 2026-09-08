import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { z } from "zod";

import { chatText, isConfigured, parseLenientJson, type LlmUsage } from "../llm";
import { tokenize } from "../text";
import type {
  ClaimCheck,
  CoverageCheck,
  Verdict,
  Verification,
} from "../types";
import { emit, withStage } from "./emit";
import { formatSources } from "./write";
import type { AskStateType } from "./state";

const VERDICTS = ["supported", "partial", "unsupported"] as const;

const RawVerificationSchema = z.object({
  claims: z
    .array(
      z.object({
        claim: z.string().min(1),
        verdict: z.string().optional(),
        sources: z.array(z.union([z.number(), z.string()])).optional(),
        reason: z.string().optional(),
      }),
    )
    .optional(),
  coverage: z
    .array(
      z.object({
        item: z.string().min(1),
        covered: z.union([z.boolean(), z.string()]).optional(),
      }),
    )
    .optional(),
  confidence: z.string().optional(),
  retrievalGaps: z.array(z.string()).optional(),
  summary: z.string().optional(),
});

const SYSTEM_PROMPT = `You audit a drafted answer against the numbered source passages it was written from. You are checking evidence, not style, and you never rewrite the answer.

For every factual claim in the answer, decide:
- "supported": a cited passage states it.
- "partial": a passage implies it or supports only part of it.
- "unsupported": no passage states it, or the citation points somewhere that does not back it.

A claim that resolves a category to a specific member is supported when the passage names that member. For example, an answer saying a firm is in the GCC is supported by a passage naming its Doha office.

Also check the coverage checklist, and when something is missing, propose the retrieval queries that would find it.

Reply with JSON only, no prose and no code fences:
{"claims":[{"claim":"...","verdict":"supported|partial|unsupported","sources":[1],"reason":"one short sentence"}],"coverage":[{"item":"...","covered":true}],"confidence":"high|medium|low","retrievalGaps":["query to run next"],"summary":"one sentence overall"}`;

function buildUserPrompt(state: AskStateType): string {
  const mustCover = state.plan?.mustCover ?? [];
  return [
    `Question: ${state.question}`,
    mustCover.length > 0
      ? `Coverage checklist:\n${mustCover.map((item) => `- ${item}`).join("\n")}`
      : null,
    "",
    "Answer under audit:",
    state.answer ?? "",
    "",
    "Sources:",
    formatSources(state.passages ?? []),
  ]
    .filter(Boolean)
    .join("\n");
}

function coerceVerdict(value: string | undefined): Verdict {
  const normalized = value?.trim().toLowerCase();
  return VERDICTS.find((verdict) => verdict === normalized) ?? "partial";
}

function coerceBoolean(value: boolean | string | undefined): boolean {
  if (typeof value === "boolean") return value;
  const normalized = value?.trim().toLowerCase();
  return normalized === "true" || normalized === "yes" || normalized === "covered";
}

function coerceSources(values: (number | string)[] | undefined): number[] {
  if (!values) return [];
  const out: number[] = [];
  for (const value of values) {
    const parsed =
      typeof value === "number" ? value : Number(String(value).replace(/[^\d]/g, ""));
    if (Number.isFinite(parsed) && parsed > 0) out.push(Math.trunc(parsed));
  }
  return [...new Set(out)];
}

/* --------------------------------------------------- heuristic verification */

function splitSentences(text: string): string[] {
  return text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 12);
}

function overlapRatio(claim: string, evidence: string): number {
  const claimTokens = new Set(tokenize(claim));
  if (claimTokens.size === 0) return 0;
  const evidenceTokens = new Set(tokenize(evidence));
  let hits = 0;
  for (const token of claimTokens) if (evidenceTokens.has(token)) hits += 1;
  return hits / claimTokens.size;
}

/**
 * Citation-overlap check used when no model is available. Weaker than the model
 * audit, but it still catches uncited sentences and citations that point at
 * passages with nothing in common.
 */
function heuristicVerification(state: AskStateType): Verification {
  const passages = state.passages ?? [];
  const answer = state.answer ?? "";
  const claims: ClaimCheck[] = [];

  for (const sentence of splitSentences(answer)) {
    const cited = coerceSources(sentence.match(/\[S(\d+)\]/g)?.map((tag) => tag) ?? []);
    if (cited.length === 0) {
      claims.push({
        claim: sentence,
        verdict: "unsupported",
        sources: [],
        reason: "No source is cited for this sentence.",
      });
      continue;
    }

    const evidence = cited
      .map((number) => passages[number - 1]?.text ?? "")
      .join(" ");
    const ratio = overlapRatio(sentence.replace(/\[S\d+\]/g, ""), evidence);
    claims.push({
      claim: sentence,
      verdict: ratio >= 0.5 ? "supported" : ratio >= 0.25 ? "partial" : "unsupported",
      sources: cited,
      reason: `${Math.round(ratio * 100)}% of the sentence's terms appear in the cited passage.`,
    });
  }

  const coverage: CoverageCheck[] = (state.plan?.mustCover ?? []).map((item) => {
    const itemTokens = tokenize(item);
    const answerTokens = new Set(tokenize(answer));
    const hits = itemTokens.filter((token) => answerTokens.has(token)).length;
    return { item, covered: itemTokens.length > 0 && hits / itemTokens.length >= 0.5 };
  });

  const supported = claims.filter((claim) => claim.verdict === "supported").length;
  const ratio = claims.length > 0 ? supported / claims.length : 0;

  return {
    claims,
    coverage,
    confidence: ratio >= 0.75 ? "high" : ratio >= 0.4 ? "medium" : "low",
    retrievalGaps: coverage.filter((item) => !item.covered).map((item) => item.item),
    summary: `Checked by term overlap against the cited passages: ${supported} of ${claims.length} sentences matched their citation closely.`,
    source: "heuristic",
  };
}

async function llmVerification(
  state: AskStateType,
  usage: LlmUsage,
): Promise<Verification | null> {
  const raw = await chatText({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(state),
    usage,
    maxTokens: 1200,
    label: "verify",
  });

  const parsed = RawVerificationSchema.safeParse(parseLenientJson(raw));
  if (!parsed.success) return null;

  const claims: ClaimCheck[] = (parsed.data.claims ?? [])
    .map((claim) => ({
      claim: claim.claim.trim(),
      verdict: coerceVerdict(claim.verdict),
      sources: coerceSources(claim.sources),
      reason: claim.reason?.trim() || "",
    }))
    .filter((claim) => claim.claim.length > 0)
    .slice(0, 20);

  if (claims.length === 0) return null;

  const checklist = state.plan?.mustCover ?? [];
  const reported = new Map(
    (parsed.data.coverage ?? []).map((entry) => [
      entry.item.trim().toLowerCase(),
      coerceBoolean(entry.covered),
    ]),
  );
  const coverage: CoverageCheck[] = checklist.map((item) => ({
    item,
    covered: reported.get(item.trim().toLowerCase()) ?? false,
  }));

  const confidence = ["high", "medium", "low"].includes(
    parsed.data.confidence?.trim().toLowerCase() ?? "",
  )
    ? (parsed.data.confidence!.trim().toLowerCase() as Verification["confidence"])
    : "medium";

  return {
    claims,
    coverage,
    confidence,
    retrievalGaps: (parsed.data.retrievalGaps ?? [])
      .map((gap) => gap.trim())
      .filter(Boolean)
      .slice(0, 4),
    summary: parsed.data.summary?.trim() || "",
    source: "llm",
  };
}

export async function verifyNode(
  state: AskStateType,
  config: LangGraphRunnableConfig,
): Promise<Partial<AskStateType>> {
  return withStage(config, "verify", async () => {
    const usage = state.usage;
    let verification: Verification | null = null;

    if (isConfigured() && (state.passages ?? []).length > 0) {
      try {
        verification = await llmVerification(state, usage);
        if (!verification) {
          usage.notes.push("verify: model reply was not usable JSON; used the overlap check.");
        }
      } catch (error) {
        usage.notes.push(
          `verify: ${error instanceof Error ? error.message : "verifier call failed"}; used the overlap check.`,
        );
      }
    }

    if (!verification) {
      verification = heuristicVerification(state);
    }

    emit(config, { type: "verification", verification });
    emit(config, {
      type: "usage",
      llmCalls: usage.calls,
      models: usage.models,
      degraded: usage.degraded,
    });
    return { verification, usage };
  });
}
