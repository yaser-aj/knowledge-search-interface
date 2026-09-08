import { Annotation } from "@langchain/langgraph";

import type { LlmUsage } from "../llm";
import type {
  PrimeSummary,
  QueryPlan,
  RetrievalStats,
  RetrievedPassage,
  Verification,
} from "../types";

export const MAX_RETRIEVAL_LOOPS = 1;

export const AskState = Annotation.Root({
  question: Annotation<string>,
  prime: Annotation<PrimeSummary | null>,
  plan: Annotation<QueryPlan | null>,
  passages: Annotation<RetrievedPassage[]>,
  stats: Annotation<RetrievalStats | null>,
  answer: Annotation<string>,
  verification: Annotation<Verification | null>,
  /** Number of extra retrieval passes already spent. */
  loops: Annotation<number>,
  /** Gap queries handed back by the verifier for a second pass. */
  extraQueries: Annotation<string[]>,
  usage: Annotation<LlmUsage>,
});

export type AskStateType = typeof AskState.State;
