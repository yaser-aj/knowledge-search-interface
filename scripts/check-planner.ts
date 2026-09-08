import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const match = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (match) process.env[match[1]] ??= match[2].replace(/^["']|["']$/g, "");
}

const { chatText, createUsage, parseLenientJson } = await import("@/lib/llm");
const { PLANNER_SYSTEM_PROMPT, buildPlannerUserPrompt } = await import("@/lib/graph/plan");
const { embed } = await import("@/lib/embeddings");
const { getCorpus } = await import("@/lib/store");
const { nearestVocabTerms } = await import("@/lib/vocab");

const question = process.argv[2] ?? "Which business is headquartered somewhere in the GCC?";
const vector = await embed(question);
const shortlist = nearestVocabTerms(vector, getCorpus().vocab, 26, 0.2).map((match) => ({
  term: match.term.term,
  similarity: match.similarity,
  documents: match.term.documentFrequency,
}));

const usage = createUsage();
const user = buildPlannerUserPrompt({
  question,
  prime: { corpus: { documents: 0, chunks: 0, words: 0, vocabTerms: 0 }, vocabularyShortlist: shortlist },
} as Parameters<typeof buildPlannerUserPrompt>[0]);

const started = Date.now();
const raw = await chatText({
  system: PLANNER_SYSTEM_PROMPT,
  user,
  usage,
  maxTokens: 2200,
  label: "plan-probe",
});

console.log(`--- ${Date.now() - started}ms · ${raw.length} chars · calls=${usage.calls} ---`);
console.log(raw);
console.log("--- parsed ---");
console.log(JSON.stringify(parseLenientJson(raw), null, 1)?.slice(0, 1200));
console.log("notes:", usage.notes.join(" | ") || "(none)");
