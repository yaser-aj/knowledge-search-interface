import { getWriter, type LangGraphRunnableConfig } from "@langchain/langgraph";

import type { LlmUsage } from "../llm";
import type { AskEvent, StageName, StageStatus } from "../types";

/** Pushes a typed event onto LangGraph's "custom" stream for the SSE route. */
export function emit(config: LangGraphRunnableConfig, event: AskEvent): void {
  getWriter(config)?.(event);
}

export function emitUsage(config: LangGraphRunnableConfig, usage: LlmUsage): void {
  emit(config, {
    type: "usage",
    llmCalls: usage.calls,
    models: usage.models,
    degraded: usage.degraded,
    notes: [...usage.notes],
  });
}

export function emitStage(
  config: LangGraphRunnableConfig,
  stage: StageName,
  status: StageStatus,
  extra: { ms?: number; detail?: string } = {},
): void {
  emit(config, { type: "stage", stage, status, ...extra });
}

/** Wraps a node so every stage reports running/done/error with its duration. */
export async function withStage<T>(
  config: LangGraphRunnableConfig,
  stage: StageName,
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  emitStage(config, stage, "running");
  try {
    const result = await run();
    emitStage(config, stage, "done", { ms: Date.now() - started });
    return result;
  } catch (error) {
    emitStage(config, stage, "error", {
      ms: Date.now() - started,
      detail: error instanceof Error ? error.message : "Unexpected failure.",
    });
    throw error;
  }
}
