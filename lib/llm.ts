import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

import { relaxConnectionRacing } from "./net";

const BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
const DEFAULT_FALLBACKS = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemma-4-31b-it:free",
];

export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

export interface LlmUsage {
  calls: number;
  models: string[];
  /** True once any node had to fall back to a non-LLM path. */
  degraded: boolean;
  notes: string[];
}

export function createUsage(): LlmUsage {
  return { calls: 0, models: [], degraded: false, notes: [] };
}

export function isConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY?.trim());
}

function modelChain(): string[] {
  const primary = process.env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL;
  const fallbacks = (process.env.OPENROUTER_FALLBACK_MODELS ?? DEFAULT_FALLBACKS.join(","))
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  return [...new Set([primary, ...fallbacks])];
}

function createClient(model: string, maxTokens: number, streaming: boolean): ChatOpenAI {
  relaxConnectionRacing();
  return new ChatOpenAI({
    model,
    apiKey: process.env.OPENROUTER_API_KEY,
    temperature: 0.2,
    maxTokens,
    streaming,
    // OpenRouter exposes the chat-completions shape only.
    useResponsesApi: false,
    maxRetries: 0,
    timeout: 90_000,
    configuration: {
      baseURL: BASE_URL,
      defaultHeaders: {
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "Knowledge Search Interface",
      },
    },
  });
}

function statusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { status?: unknown; code?: unknown };
  if (typeof candidate.status === "number") return candidate.status;
  if (typeof candidate.code === "number") return candidate.code;
  return null;
}

/** Rate limits and upstream hiccups are worth trying on another free model. */
function isRetryable(error: unknown): boolean {
  const status = statusOf(error);
  if (status === 429 || status === 408 || (status !== null && status >= 500)) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("rate limit") ||
    message.includes("timeout") ||
    message.includes("fetch failed") ||
    message.includes("temporarily")
  );
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

interface CallOptions {
  system: string;
  user: string;
  usage: LlmUsage;
  maxTokens?: number;
  label: string;
}

async function runWithFallbacks<T>(
  { usage, label, maxTokens = 1200, system, user }: CallOptions,
  streaming: boolean,
  run: (client: ChatOpenAI, messages: [SystemMessage, HumanMessage]) => Promise<T>,
): Promise<T> {
  if (!isConfigured()) {
    throw new LlmUnavailableError("OPENROUTER_API_KEY is not set.");
  }

  const messages: [SystemMessage, HumanMessage] = [
    new SystemMessage(system),
    new HumanMessage(user),
  ];
  const chain = modelChain();
  let lastError: unknown = null;

  for (const model of chain) {
    try {
      const client = createClient(model, maxTokens, streaming);
      usage.calls += 1;
      const result = await run(client, messages);
      if (!usage.models.includes(model)) usage.models.push(model);
      return result;
    } catch (error) {
      lastError = error;
      if (!isRetryable(error)) break;
      usage.notes.push(`${label}: ${model} unavailable (${describe(error)}); trying next model.`);
    }
  }

  throw new LlmUnavailableError(`${label} failed: ${describe(lastError)}`);
}

export async function chatText(options: CallOptions): Promise<string> {
  return runWithFallbacks(options, false, async (client, messages) => {
    const response = await client.invoke(messages);
    return typeof response.content === "string"
      ? response.content
      : response.content
          .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
          .join("");
  });
}

export async function* chatStream(
  options: CallOptions,
): AsyncGenerator<string, void, undefined> {
  const stream = await runWithFallbacks(options, true, async (client, messages) =>
    client.stream(messages),
  );

  for await (const chunk of stream) {
    const { content } = chunk;
    if (typeof content === "string") {
      if (content) yield content;
      continue;
    }
    for (const part of content) {
      if ("text" in part && typeof part.text === "string" && part.text) yield part.text;
    }
  }
}

/* ------------------------------------------------------------- JSON repair */

function stripFences(text: string): string {
  return text
    .replace(/^\s*```(?:json|JSON)?\s*/g, "")
    .replace(/```\s*$/g, "")
    .trim();
}

/** Extracts the outermost balanced JSON object, ignoring braces inside strings. */
function extractObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Free models wrap JSON in prose, fence it, or leave trailing commas. Recover
 * what we can instead of failing the whole run.
 */
export function parseLenientJson(raw: string): unknown {
  const candidates = [raw, stripFences(raw)];
  const extracted = extractObject(stripFences(raw));
  if (extracted) candidates.push(extracted);

  for (const candidate of candidates) {
    const cleaned = candidate.trim();
    if (!cleaned) continue;
    try {
      return JSON.parse(cleaned);
    } catch {
      try {
        return JSON.parse(cleaned.replace(/,\s*([}\]])/g, "$1"));
      } catch {
        // try the next candidate
      }
    }
  }
  return null;
}
