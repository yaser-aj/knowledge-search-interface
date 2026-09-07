import { getDocument } from "@/lib/db";
import { indexDocument } from "@/lib/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const documentId = Number(id);
  const existing = getDocument(documentId);
  if (!existing) {
    return Response.json({ error: "Document not found" }, { status: 404 });
  }
  void indexDocument(documentId);
  return Response.json({ document: getDocument(documentId) });
}
