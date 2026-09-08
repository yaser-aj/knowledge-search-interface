import type { LangGraphRunnableConfig } from "@langchain/langgraph";

import { retrievePassages } from "../retrieval/engine";
import { emit, withStage } from "./emit";
import type { AskStateType } from "./state";

export async function retrieveNode(
  state: AskStateType,
  config: LangGraphRunnableConfig,
): Promise<Partial<AskStateType>> {
  return withStage(config, "retrieve", async () => {
    if (!state.plan) throw new Error("Retrieval ran before a plan existed.");

    const { passages, stats } = await retrievePassages({
      question: state.question,
      plan: state.plan,
      pass: (state.loops ?? 0) + 1,
      extraQueries: state.extraQueries ?? [],
    });

    emit(config, { type: "retrieval", passages, stats });
    return { passages, stats };
  });
}
