import { END, START, StateGraph, type LangGraphRunnableConfig } from "@langchain/langgraph";

import { createUsage, isConfigured } from "../llm";
import type { AskEvent } from "../types";
import { emit } from "./emit";
import { planNode } from "./plan";
import { primeNode } from "./prime";
import { retrieveNode } from "./retrieve";
import { AskState, MAX_RETRIEVAL_LOOPS, type AskStateType } from "./state";
import { verifyNode } from "./verify";
import { writeNode } from "./write";

/** Spends the verifier's gap queries on one more retrieval pass. */
function refineNode(
  state: AskStateType,
  config: LangGraphRunnableConfig,
): Partial<AskStateType> {
  const gaps = state.verification?.retrievalGaps ?? [];
  emit(config, {
    type: "stage",
    stage: "retrieve",
    status: "running",
    detail: `Verification found gaps; retrieving again for: ${gaps.join("; ")}`,
  });
  return { loops: (state.loops ?? 0) + 1, extraQueries: gaps };
}

function afterVerify(state: AskStateType): "refine" | typeof END {
  const verification = state.verification;
  if (!verification) return END;
  if ((state.loops ?? 0) >= MAX_RETRIEVAL_LOOPS) return END;
  // Without a model, a second pass would repeat identical deterministic work.
  if (!isConfigured()) return END;
  if (verification.retrievalGaps.length === 0) return END;

  const unsupported = verification.claims.some((claim) => claim.verdict === "unsupported");
  const uncovered = verification.coverage.some((item) => !item.covered);
  return unsupported || uncovered ? "refine" : END;
}

function buildGraph() {
  return new StateGraph(AskState)
    .addNode("prime", primeNode)
    .addNode("plan", planNode)
    .addNode("retrieve", retrieveNode)
    .addNode("write", writeNode)
    .addNode("verify", verifyNode)
    .addNode("refine", refineNode)
    .addEdge(START, "prime")
    .addEdge("prime", "plan")
    .addEdge("plan", "retrieve")
    .addEdge("retrieve", "write")
    .addEdge("write", "verify")
    .addConditionalEdges("verify", afterVerify, ["refine", END])
    .addEdge("refine", "retrieve")
    .compile();
}

type CompiledAskGraph = ReturnType<typeof buildGraph>;

const globalCache = globalThis as unknown as { __ksiGraph?: CompiledAskGraph };

export function getAskGraph(): CompiledAskGraph {
  globalCache.__ksiGraph ??= buildGraph();
  return globalCache.__ksiGraph;
}

/** Runs the graph and yields every event its nodes emit, in order. */
export async function* runAsk(question: string): AsyncGenerator<AskEvent> {
  const started = Date.now();

  try {
    const stream = await getAskGraph().stream(
      {
        question,
        prime: null,
        plan: null,
        passages: [],
        stats: null,
        answer: "",
        verification: null,
        loops: 0,
        extraQueries: [],
        usage: createUsage(),
      },
      { streamMode: "custom", recursionLimit: 30 },
    );

    for await (const chunk of stream) {
      yield chunk as AskEvent;
    }

    yield { type: "done", ms: Date.now() - started };
  } catch (error) {
    yield {
      type: "error",
      message: error instanceof Error ? error.message : "The run failed unexpectedly.",
    };
  }
}
