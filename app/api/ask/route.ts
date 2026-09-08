import { runAsk } from "@/lib/graph";
import { corpusStats } from "@/lib/store";
import type { AskEvent } from "@/lib/types";

const MAX_QUESTION_LENGTH = 600;

export async function POST(request: Request) {
  let question: string;
  try {
    const body = (await request.json()) as { question?: unknown };
    question = typeof body.question === "string" ? body.question.trim() : "";
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (question.length < 3) {
    return Response.json({ error: "Ask a slightly longer question." }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    question = question.slice(0, MAX_QUESTION_LENGTH);
  }
  if (corpusStats().chunks === 0) {
    return Response.json(
      { error: "The library is empty. Upload a document first." },
      { status: 409 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: AskEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        for await (const event of runAsk(question)) {
          if (request.signal.aborted) break;
          send(event);
        }
      } catch (error) {
        send({
          type: "error",
          message: error instanceof Error ? error.message : "The run failed unexpectedly.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Stops intermediary buffering from batching the token stream.
      "X-Accel-Buffering": "no",
    },
  });
}
