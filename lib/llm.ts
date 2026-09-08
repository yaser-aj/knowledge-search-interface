import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

import { relaxConnectionRacing } from "./net";

const BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
const DEFAULT_FALLBACKS = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemma-4-31b-it:free",
];

/**
 * Free models are frequently "temporarily overloaded" rather than genuinely
 * unavailable, so the chain is swept twice with a pause in between. Capped so a
 * single node cannot eat the daily request allowance.
 */
const MAX_SWEEPS = 2;
const MAX_ATTEMPTS = 6;
const SWEEP_BACKOFF_MS = 2500;

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

/**
 * Free-tier models queue behind paid traffic, so latency swings from a few
 * seconds to a couple of minutes for the same prompt. Be patient rather than
 * burning a fallback model on what is really just a queue.
 */
const DEFAULT_TIMEOUT_MS = 180_000;

function createClient(
  model: string,
  maxTokens: number,
  streaming: boolean,
  timeout: number,
): ChatOpenAI {
  relaxConnectionRacing();
  return new ChatOpenAI({
    model,
    apiKey: process.env.OPENROUTER_API_KEY,
    temperature: 0.2,
    maxTokens,
    streaming,
    // OpenRouter exposes the chat-completions shape only.
    useResponsesApi: false,
    // The free Nemotron models reason before answering; left unbounded, the
    // reasoning consumes the token budget and the reply comes back with no
    // message at all.
    reasoning: { effort: "low" },
    maxRetries: 0,
    timeout,
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

/**
 * Only credential and billing failures are worth giving up on. Everything else
 * on the free tier — rate limits, overloaded upstreams, empty replies, response
 * shapes the client cannot parse — is worth retrying on another model.
 */
function isFatal(error: unknown): boolean {
  const status = statusOf(error);
  if (status === 401 || status === 402 || status === 403) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("api key") ||
    message.includes("unauthorized") ||
    message.includes("insufficient credit")
  );
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // The client throws this while reading an empty `choices` array, which is how
  // OpenRouter reports a reply that contained reasoning but no answer.
  if (error.message.includes("reading 'message'")) {
    return "model returned no answer (its token budget went on reasoning)";
  }
  return error.message.split("\n")[0];
}

interface CallOptions {
  system: string;
  user: string;
  usage: LlmUsage;
  maxTokens?: number;
  timeoutMs?: number;
  label: string;
}

async function runWithFallbacks<T>(
  {
    usage,
    label,
    maxTokens = 1200,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    system,
    user,
  }: CallOptions,
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
  let attempts = 0;

  for (let sweep = 0; sweep < MAX_SWEEPS; sweep += 1) {
    if (sweep > 0) {
      await new Promise((resolve) => setTimeout(resolve, SWEEP_BACKOFF_MS));
    }

    for (const model of chain) {
      if (attempts >= MAX_ATTEMPTS) break;
      attempts += 1;
      try {
        const client = createClient(model, maxTokens, streaming, timeoutMs);
        usage.calls += 1;
        const result = await run(client, messages);
        if (!usage.models.includes(model)) usage.models.push(model);
        return result;
      } catch (error) {
        lastError = error;
        if (isFatal(error)) {
          throw new LlmUnavailableError(`${label} failed: ${describe(error)}`);
        }
        usage.notes.push(`${label}: ${model} unavailable — ${describe(error)}`);
      }
    }

    if (attempts >= MAX_ATTEMPTS) break;
  }

  throw new LlmUnavailableError(`${label} failed: ${describe(lastError)}`);
}

export async function chatText(options: CallOptions): Promise<string> {
  return runWithFallbacks(options, false, async (client, messages) => {
    const response = await client.invoke(messages);
    const text =
      typeof response.content === "string"
        ? response.content
        : response.content
            .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
            .join("");
    if (!text.trim()) throw new Error("empty response");
    return text;
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
 * Rebuilds valid JSON from a reply that was cut off at the token limit: keeps
 * everything up to the last complete element and closes the open containers.
 */
function repairTruncated(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let lastComplete = -1;

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

    if (char === "{" || char === "[") {
      stack.push(char);
    } else if (char === "}" || char === "]") {
      stack.pop();
      // A closed container nested inside another one is a safe cut point.
      if (stack.length > 0) lastComplete = i;
      else if (stack.length === 0) return text.slice(start, i + 1);
    }
  }

  if (lastComplete === -1) return null;

  // Recompute the open containers at the cut point so they can be closed.
  const kept = text.slice(start, lastComplete + 1);
  const open: string[] = [];
  inString = false;
  escaped = false;
  for (const char of kept) {
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
    if (char === "{" || char === "[") open.push(char);
    else if (char === "}" || char === "]") open.pop();
  }

  const closers = open
    .reverse()
    .map((char) => (char === "{" ? "}" : "]"))
    .join("");
  return `${kept}${closers}`;
}

/**
 * Free models wrap JSON in prose, fence it, leave trailing commas, or run out
 * of tokens mid-object. Recover what we can instead of failing the whole run.
 */
export function parseLenientJson(raw: string): unknown {
  const candidates = [raw, stripFences(raw)];
  const extracted = extractObject(stripFences(raw));
  if (extracted) candidates.push(extracted);
  const repaired = repairTruncated(stripFences(raw));
  if (repaired) candidates.push(repaired);

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
