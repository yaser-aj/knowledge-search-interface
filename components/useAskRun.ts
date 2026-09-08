"use client";

import { useCallback, useRef, useState } from "react";

import type {
  AskEvent,
  PrimeSummary,
  QueryPlan,
  RetrievalStats,
  RetrievedPassage,
  StageName,
  StageStatus,
  Verification,
} from "@/lib/types";

export const STAGE_ORDER: StageName[] = ["prime", "plan", "retrieve", "write", "verify"];

export interface StageState {
  status: StageStatus | "pending";
  ms?: number;
  detail?: string;
}

export interface RunState {
  status: "idle" | "running" | "done" | "error";
  question: string;
  stages: Record<StageName, StageState>;
  prime: PrimeSummary | null;
  plan: QueryPlan | null;
  passages: RetrievedPassage[];
  stats: RetrievalStats | null;
  answer: string;
  streaming: boolean;
  verification: Verification | null;
  usage: { llmCalls: number; models: string[]; degraded: boolean };
  /** Set when the verifier sent the graph back for another retrieval pass. */
  refined: string | null;
  error: string | null;
  ms: number | null;
}

function blankStages(): Record<StageName, StageState> {
  return {
    prime: { status: "pending" },
    plan: { status: "pending" },
    retrieve: { status: "pending" },
    write: { status: "pending" },
    verify: { status: "pending" },
  };
}

export function idleRun(): RunState {
  return {
    status: "idle",
    question: "",
    stages: blankStages(),
    prime: null,
    plan: null,
    passages: [],
    stats: null,
    answer: "",
    streaming: false,
    verification: null,
    usage: { llmCalls: 0, models: [], degraded: false },
    refined: null,
    error: null,
    ms: null,
  };
}

function reduce(state: RunState, event: AskEvent): RunState {
  switch (event.type) {
    case "stage": {
      const stages = {
        ...state.stages,
        [event.stage]: { status: event.status, ms: event.ms, detail: event.detail },
      };
      // A second write pass replaces the previous draft rather than appending.
      const resetAnswer = event.stage === "write" && event.status === "running";
      return {
        ...state,
        stages,
        answer: resetAnswer ? "" : state.answer,
        streaming: resetAnswer ? true : state.streaming,
        refined: event.detail?.startsWith("Verification found gaps")
          ? event.detail
          : state.refined,
      };
    }
    case "prime":
      return { ...state, prime: event.prime };
    case "plan":
      return { ...state, plan: event.plan };
    case "retrieval":
      return { ...state, passages: event.passages, stats: event.stats };
    case "token":
      return { ...state, answer: state.answer + event.text, streaming: true };
    case "answer":
      return { ...state, answer: event.text, streaming: false };
    case "verification":
      return { ...state, verification: event.verification };
    case "usage":
      return {
        ...state,
        usage: {
          llmCalls: event.llmCalls,
          models: event.models,
          degraded: event.degraded,
        },
      };
    case "done":
      return { ...state, status: "done", streaming: false, ms: event.ms };
    case "error":
      return { ...state, status: "error", streaming: false, error: event.message };
    default:
      return state;
  }
}

/** Consumes the SSE stream from /api/ask and folds it into one run state. */
export function useAskRun() {
  const [run, setRun] = useState<RunState>(idleRun());
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRun((current) =>
      current.status === "running" ? { ...current, status: "done", streaming: false } : current,
    );
  }, []);

  const ask = useCallback(async (question: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setRun({ ...idleRun(), status: "running", question });

    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const detail = await response
          .json()
          .then((body: { error?: string }) => body.error)
          .catch(() => null);
        setRun((current) => ({
          ...current,
          status: "error",
          error: detail ?? "The request failed.",
        }));
        return;
      }

      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;

        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const line = frame.split("\n").find((part) => part.startsWith("data: "));
          if (!line) continue;
          try {
            const event = JSON.parse(line.slice(6)) as AskEvent;
            setRun((current) => reduce(current, event));
          } catch {
            // Ignore a partial frame rather than killing the stream.
          }
        }
      }

      setRun((current) =>
        current.status === "running" ? { ...current, status: "done", streaming: false } : current,
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      setRun((current) => ({
        ...current,
        status: "error",
        error: error instanceof Error ? error.message : "The request failed.",
      }));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  return { run, ask, cancel, reset: () => setRun(idleRun()) };
}
