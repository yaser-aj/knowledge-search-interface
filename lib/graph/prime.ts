import type { LangGraphRunnableConfig } from "@langchain/langgraph";

import { embed } from "../embeddings";
import { corpusStats, getCorpus } from "../store";
import { nearestVocabTerms } from "../vocab";
import type { PrimeSummary } from "../types";
import { emit, withStage } from "./emit";
import type { AskStateType } from "./state";

const SHORTLIST_SIZE = 26;
const DIGEST_DOCUMENTS = 14;

/**
 * Compact description of the library handed to the planner. Showing the terms
 * each file actually contains is what stops the planner from inventing
 * expansions that have no chance of matching anything.
 */
export function corpusDigest(): string {
  const documents = getCorpus()
    .documents.filter((document) => document.status === "ready")
    .slice(0, DIGEST_DOCUMENTS);

  if (documents.length === 0) return "The library is empty.";

  return documents
    .map((document) => {
      const terms = document.profile.topTerms.slice(0, 12).join(", ");
      const lede = document.profile.lede.slice(0, 160);
      return [
        `- ${document.filename}`,
        terms ? `  key terms: ${terms}` : null,
        lede ? `  opens with: ${lede}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}

export async function primeNode(
  state: AskStateType,
  config: LangGraphRunnableConfig,
): Promise<Partial<AskStateType>> {
  return withStage(config, "prime", async () => {
    const corpus = getCorpus();
    const questionVector = await embed(state.question);
    const shortlist = nearestVocabTerms(
      questionVector,
      corpus.vocab,
      SHORTLIST_SIZE,
      0.2,
    );

    const prime: PrimeSummary = {
      corpus: corpusStats(),
      vocabularyShortlist: shortlist.map(({ term, similarity }) => ({
        term: term.term,
        similarity: Number(similarity.toFixed(3)),
        documents: term.documentFrequency,
      })),
    };

    emit(config, { type: "prime", prime });
    return { prime };
  });
}
