import { getChunksByIds, nodeByType, recordIntentFeedback, updateRun } from "@/lib/db";
import { tokenize } from "@/lib/tokenize";
import type { WriteOutput } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    runId?: number;
    question?: string;
    chunkIds?: number[];
  };
  const runId = Number(body.runId);
  const question = body.question?.trim() ?? "";
  const chunkIds = Array.isArray(body.chunkIds) ? body.chunkIds.map(Number) : [];

  if (!Number.isFinite(runId) || !question) {
    return Response.json({ error: "runId and question are required" }, { status: 400 });
  }

  let documentIds = getChunksByIds(chunkIds).map((c) => c.documentId);
  if (documentIds.length === 0) {
    const write = nodeByType(runId, "write");
    const output = write.output as WriteOutput | null;
    documentIds = output?.sources.map((s) => s.documentId) ?? [];
  }

  const uniqueDocs = [...new Set(documentIds)];
  if (uniqueDocs.length === 0) {
    return Response.json({ error: "No cited documents to remember." }, { status: 400 });
  }

  recordIntentFeedback(tokenize(question), uniqueDocs);
  updateRun(runId, { helpful: 1 });
  return Response.json({ ok: true });
}
