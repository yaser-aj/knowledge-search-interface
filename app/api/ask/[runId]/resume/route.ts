import { resumeAsk } from "@/lib/pipeline";
import { sseResponse } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const id = Number(runId);
  if (!Number.isFinite(id)) {
    return Response.json({ error: "Invalid run id" }, { status: 400 });
  }
  return sseResponse((send) => resumeAsk(id, send));
}
