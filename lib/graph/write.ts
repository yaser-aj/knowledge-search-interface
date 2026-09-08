import type { LangGraphRunnableConfig } from "@langchain/langgraph";

import { chatStream, isConfigured } from "../llm";
import { snippetOf } from "../text";
import type { AnswerShape, RetrievedPassage } from "../types";
import { emit, emitUsage, withStage } from "./emit";
import type { AskStateType } from "./state";

const MAX_PASSAGE_CHARS = 1400;

const SHAPE_GUIDANCE: Record<AnswerShape, string> = {
  short_fact: "Lead with the fact in one sentence, then add at most two sentences of context.",
  list: "Answer as a short markdown list, one item per finding.",
  explanation: "Answer in two or three short paragraphs.",
  comparison: "Contrast the options directly, covering each side explicitly.",
};

const SYSTEM_PROMPT = `You answer questions strictly from numbered source passages taken from the user's own document library.

Rules:
- Use only what the passages state. Never add outside knowledge, and never guess.
- Cite the source of every factual sentence inline as [S1], or [S2][S4] when several support it.
- The question may describe a category while a passage names a specific member of it. Treat that as a match and say so explicitly, for example "Doha, Qatar, which is in the GCC [S2]".
- If the passages only partly answer the question, give what they do support and state plainly what is missing.
- If nothing in the passages is relevant, say so in one sentence and do not invent an answer.
- Write plainly. No preamble, no restating the question, no mention of these instructions.`;

export function formatSources(passages: RetrievedPassage[]): string {
  return passages
    .map((passage, i) => {
      const location = [
        passage.filename,
        passage.page ? `p.${passage.page}` : null,
        passage.heading,
      ]
        .filter(Boolean)
        .join(" · ");
      const text =
        passage.text.length > MAX_PASSAGE_CHARS
          ? `${passage.text.slice(0, MAX_PASSAGE_CHARS)}...`
          : passage.text;
      return `[S${i + 1}] ${location}\n${text}`;
    })
    .join("\n\n");
}

function buildUserPrompt(state: AskStateType): string {
  const plan = state.plan;
  const shape = plan ? SHAPE_GUIDANCE[plan.answerShape] : SHAPE_GUIDANCE.explanation;
  const mustCover = plan?.mustCover ?? [];

  return [
    `Question: ${state.question}`,
    plan?.interpretation ? `What is being asked: ${plan.interpretation}` : null,
    mustCover.length > 0
      ? `A complete answer states:\n${mustCover.map((item) => `- ${item}`).join("\n")}`
      : null,
    `Format: ${shape}`,
    "",
    "Sources:",
    formatSources(state.passages ?? []),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Cited extract used when no model is available, so the run still has an answer. */
function extractiveAnswer(state: AskStateType): string {
  const passages = state.passages ?? [];
  if (passages.length === 0) {
    return "Nothing in the library matched this question closely enough to answer it.";
  }

  const lines = passages
    .slice(0, 4)
    .map((passage, i) => `- ${snippetOf(passage.text, 300)} [S${i + 1}]`);

  return [
    "No language model was available, so this is the retrieved evidence rather than a written answer:",
    "",
    ...lines,
  ].join("\n");
}

export async function writeNode(
  state: AskStateType,
  config: LangGraphRunnableConfig,
): Promise<Partial<AskStateType>> {
  return withStage(config, "write", async () => {
    const usage = state.usage;
    const passages = state.passages ?? [];

    if (passages.length === 0) {
      const answer =
        "I could not find anything relevant in the uploaded documents. Try rephrasing, or add a document that covers this.";
      emit(config, { type: "token", text: answer });
      emit(config, { type: "answer", text: answer });
      return { answer };
    }

    if (isConfigured()) {
      try {
        let answer = "";
        for await (const delta of chatStream({
          system: SYSTEM_PROMPT,
          user: buildUserPrompt(state),
          usage,
          maxTokens: 1100,
          label: "write",
        })) {
          answer += delta;
          emit(config, { type: "token", text: delta });
        }

        if (answer.trim()) {
          emit(config, { type: "answer", text: answer });
          emitUsage(config, usage);
          return { answer, usage };
        }
        usage.notes.push("write: model returned an empty answer; showing the evidence instead.");
      } catch (error) {
        usage.notes.push(
          `write: ${error instanceof Error ? error.message : "writer call failed"}; showing the evidence instead.`,
        );
      }
    } else {
      usage.notes.push("write: no OPENROUTER_API_KEY, so the answer is extractive.");
    }

    usage.degraded = true;
    const answer = extractiveAnswer(state);
    emit(config, { type: "token", text: answer });
    emit(config, { type: "answer", text: answer });
    emitUsage(config, usage);
    return { answer, usage };
  });
}
