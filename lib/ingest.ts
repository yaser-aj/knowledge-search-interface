import fs from "node:fs";
import path from "node:path";
import { embedText } from "./embed";
import { parseAndChunk } from "./parse";
import { paths } from "./paths";
import { getDocument, replaceChunks, updateDocument } from "./db";

export async function indexDocument(documentId: number): Promise<void> {
  const doc = getDocument(documentId);
  if (!doc) throw new Error(`Document ${documentId} not found`);

  updateDocument(documentId, { status: "indexing", error: null });

  try {
    const filePath = path.join(paths.uploads, doc.storedName);
    const bytes = fs.readFileSync(filePath);
    const pieces = await parseAndChunk(doc.filename, bytes);
    if (pieces.length === 0) {
      throw new Error("No extractable text in this file.");
    }

    const chunks = [];
    for (const piece of pieces) {
      chunks.push({
        chunkIndex: piece.chunkIndex,
        page: piece.page,
        text: piece.text,
        embedding: await embedText(piece.text),
      });
    }

    replaceChunks(documentId, chunks);
    updateDocument(documentId, { status: "ready", error: null, chunkCount: chunks.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Indexing failed";
    updateDocument(documentId, { status: "error", error: message, chunkCount: 0 });
  }
}
