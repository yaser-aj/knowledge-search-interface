import { startAsk } from "@/lib/pipeline";
import { sseResponse } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const body = (await request.json()) as { question?: string };
  const question = body.question?.trim() ?? "";
  if (!question) {
    return Response.json({ error: "Ask a question about your documents." }, { status: 400 });
  }
  return sseResponse((send) => startAsk(question, send));
}
