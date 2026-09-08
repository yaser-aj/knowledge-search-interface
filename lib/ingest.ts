import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { chunkPreview, chunkPages } from "./chunk";
import { embedAll } from "./embeddings";
import { extensionOf, isSupported, parseDocument } from "./parse";
import { ensureDataDirs, paths } from "./paths";
import {
  getCorpus,
  patchDocument,
  saveDocumentChunks,
  saveVocabulary,
  upsertDocument,
} from "./store";
import { wordCount } from "./text";
import { buildVocabulary, documentProfile } from "./vocab";
import type { DocumentRecord } from "./types";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export interface IngestInput {
  filename: string;
  buffer: Buffer;
}

/** Recomputes the corpus-wide vocabulary that grounds planner expansions. */
export async function reindexVocabulary(): Promise<number> {
  const corpus = getCorpus();
  const readyDocuments = corpus.documents.filter((doc) => doc.status === "ready");
  const vocab = await buildVocabulary(
    corpus.chunks,
    Math.max(1, readyDocuments.length),
    corpus.vocab,
  );
  await saveVocabulary(vocab);
  return vocab.length;
}

export async function ingestDocument({
  filename,
  buffer,
}: IngestInput): Promise<DocumentRecord> {
  ensureDataDirs();

  const extension = extensionOf(filename);
  if (!isSupported(filename)) {
    throw new Error(
      `Unsupported file type "${extension || filename}". Upload PDF, DOCX, TXT, or MD.`,
    );
  }
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error("File is larger than the 20 MB limit.");
  }

  const id = randomUUID();
  const record: DocumentRecord = {
    id,
    filename,
    extension,
    bytes: buffer.byteLength,
    pages: null,
    chunkCount: 0,
    wordCount: 0,
    status: "processing",
    error: null,
    createdAt: new Date().toISOString(),
    profile: { lede: "", topTerms: [] },
  };

  await upsertDocument(record);
  await writeFile(paths.uploadFile(id, extension), buffer);

  try {
    const parsed = await parseDocument(filename, buffer);
    const chunks = chunkPages(id, parsed.pages);
    if (chunks.length === 0) {
      throw new Error("No readable text found. Scanned PDFs need OCR first.");
    }

    const vectors = await embedAll(chunks.map(chunkPreview));
    await saveDocumentChunks(record, chunks, vectors);

    const loaded = getCorpus().chunks.filter((chunk) => chunk.documentId === id);
    const updated = await patchDocument(id, {
      status: "ready",
      pages: parsed.totalPages,
      chunkCount: chunks.length,
      wordCount: chunks.reduce((sum, chunk) => sum + wordCount(chunk.text), 0),
      profile: documentProfile(loaded),
      error: null,
    });

    await reindexVocabulary();
    return updated ?? { ...record, status: "ready" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Indexing failed.";
    const failed = await patchDocument(id, { status: "failed", error: message });
    return failed ?? { ...record, status: "failed", error: message };
  }
}
