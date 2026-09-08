import { reindexVocabulary } from "@/lib/ingest";
import { isConfigured } from "@/lib/llm";
import { corpusStats, deleteDocument, listDocuments } from "@/lib/store";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const removed = await deleteDocument(id);
  if (!removed) {
    return Response.json({ error: "That document is not in the library." }, { status: 404 });
  }

  // The vocabulary is corpus-wide, so it has to be rebuilt without this file.
  await reindexVocabulary();

  return Response.json({
    documents: listDocuments(),
    stats: corpusStats(),
    llmConfigured: isConfigured(),
  });
}
