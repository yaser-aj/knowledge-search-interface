export const DEFAULT_MODEL =
  process.env.OPENROUTER_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b:free";

export const FALLBACK_MODELS = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "openrouter/free",
];

export class OpenRouterError extends Error {
  status: number;
  retryable: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
    this.retryable = status === 429 || status >= 500;
  }
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type ChatOptions = {
  messages: ChatMessage[];
  json?: boolean;
};

function headers() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new OpenRouterError(
      "OPENROUTER_API_KEY is missing. Add it to .env.local.",
      401,
    );
  }
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "http://localhost:3000",
    "X-Title": "Knowledge Search Interface",
  };
}

function bodyOf(options: ChatOptions, stream: boolean) {
  return {
    model: DEFAULT_MODEL,
    models: FALLBACK_MODELS,
    messages: options.messages,
    stream,
    temperature: 0.2,
    ...(options.json ? { response_format: { type: "json_object" } } : {}),
  };
}

async function requestOnce(options: ChatOptions, stream: boolean): Promise<Response> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(bodyOf(options, stream)),
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const payload = (await response.json()) as { error?: { message?: string } };
      if (payload.error?.message) detail = payload.error.message;
    } catch {
      // keep status text
    }
    if (response.status === 429) {
      throw new OpenRouterError(
        "Free-tier limit reached. Wait a bit, or resume this run — failed attempts still count toward the daily quota.",
        429,
      );
    }
    throw new OpenRouterError(detail || "OpenRouter request failed", response.status);
  }
  return response;
}

async function withRetry(options: ChatOptions, stream: boolean): Promise<Response> {
  try {
    return await requestOnce(options, stream);
  } catch (error) {
    if (error instanceof OpenRouterError && error.retryable) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return requestOnce(options, stream);
    }
    throw error;
  }
}

export function parseJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced?.[1] ?? text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("The model did not return JSON.");
  }
  return JSON.parse(raw.slice(start, end + 1));
}

export async function chatJson(options: ChatOptions): Promise<{ text: string; model: string | null }> {
  const response = await withRetry(options, false);
  const payload = (await response.json()) as {
    model?: string;
    choices?: { message?: { content?: string } }[];
  };
  const text = payload.choices?.[0]?.message?.content ?? "";
  return { text, model: payload.model ?? null };
}

export async function chatStream(
  options: ChatOptions,
  onDelta: (text: string) => void,
): Promise<{ text: string; model: string | null }> {
  const response = await withRetry(options, true);
  const reader = response.body?.getReader();
  if (!reader) throw new OpenRouterError("OpenRouter returned an empty stream", 502);

  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let model: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const chunk = JSON.parse(data) as {
          model?: string;
          choices?: { delta?: { content?: string } }[];
        };
        if (chunk.model) model = chunk.model;
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          onDelta(delta);
        }
      } catch {
        // ignore partial JSON
      }
    }
  }

  return { text, model };
}
