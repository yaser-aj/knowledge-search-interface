import { deleteDocument, getDocument } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const documentId = Number(id);
  if (!Number.isFinite(documentId)) {
    return Response.json({ error: "Invalid document id" }, { status: 400 });
  }
  const existing = getDocument(documentId);
  if (!existing) {
    return Response.json({ error: "Document not found" }, { status: 404 });
  }
  deleteDocument(documentId);
  return Response.json({ ok: true });
}
