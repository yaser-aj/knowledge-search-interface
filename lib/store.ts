import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { EMBEDDING_DIM } from "./embeddings";
import { ensureDataDirs, paths } from "./paths";
import { countTokens, tokenize } from "./text";
import type { Chunk, CorpusStats, DocumentRecord, VocabTerm } from "./types";

export interface LoadedChunk extends Chunk {
  filename: string;
  vector: Float32Array;
  tokens: string[];
  tokenCounts: Map<string, number>;
  length: number;
}

export interface LoadedVocabTerm extends VocabTerm {
  vector: Float32Array;
}

interface Corpus {
  documents: DocumentRecord[];
  chunks: LoadedChunk[];
  vocab: LoadedVocabTerm[];
}

interface StoreCache {
  corpus: Corpus | null;
  writeQueue: Promise<unknown>;
}

// Survives Next.js dev-server module reloads so the index is not re-read per edit.
const globalCache = globalThis as unknown as { __ksiStore?: StoreCache };
const cache: StoreCache = (globalCache.__ksiStore ??= {
  corpus: null,
  writeQueue: Promise.resolve(),
});

/** Serialises writes so two concurrent uploads cannot clobber index.json. */
function withWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const run = cache.writeQueue.then(task, task);
  cache.writeQueue = run.catch(() => undefined);
  return run;
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(temp, JSON.stringify(value), "utf8");
  await rename(temp, file);
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function readVectors(file: string, count: number): Float32Array[] {
  if (!existsSync(file) || count === 0) return [];
  const buffer = readFileSync(file);
  const out: Float32Array[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = i * EMBEDDING_DIM * 4;
    if (start + EMBEDDING_DIM * 4 > buffer.byteLength) break;
    const vector = new Float32Array(EMBEDDING_DIM);
    for (let j = 0; j < EMBEDDING_DIM; j += 1) {
      vector[j] = buffer.readFloatLE(start + j * 4);
    }
    out.push(vector);
  }
  return out;
}

function packVectors(vectors: Float32Array[]): Buffer {
  const buffer = Buffer.allocUnsafe(vectors.length * EMBEDDING_DIM * 4);
  vectors.forEach((vector, i) => {
    for (let j = 0; j < EMBEDDING_DIM; j += 1) {
      buffer.writeFloatLE(vector[j] ?? 0, (i * EMBEDDING_DIM + j) * 4);
    }
  });
  return buffer;
}

function hydrate(chunk: Chunk, filename: string, vector: Float32Array): LoadedChunk {
  const tokens = tokenize(chunk.text);
  return {
    ...chunk,
    filename,
    vector,
    tokens,
    tokenCounts: countTokens(tokens),
    length: tokens.length,
  };
}

function loadCorpus(): Corpus {
  ensureDataDirs();
  const documents = readJson<DocumentRecord[]>(paths.index, []);
  const chunks: LoadedChunk[] = [];

  for (const doc of documents) {
    if (doc.status !== "ready") continue;
    const stored = readJson<Chunk[]>(paths.chunkFile(doc.id), []);
    const vectors = readVectors(paths.vectorFile(doc.id), stored.length);
    stored.forEach((chunk, i) => {
      const vector = vectors[i];
      if (!vector) return;
      chunks.push(hydrate(chunk, doc.filename, vector));
    });
  }

  const vocabTerms = readJson<VocabTerm[]>(paths.vocabIndex, []);
  const vocabVectors = readVectors(paths.vocabVectors, vocabTerms.length);
  const vocab: LoadedVocabTerm[] = [];
  vocabTerms.forEach((term, i) => {
    const vector = vocabVectors[i];
    if (vector) vocab.push({ ...term, vector });
  });

  return { documents, chunks, vocab };
}

export function getCorpus(): Corpus {
  cache.corpus ??= loadCorpus();
  return cache.corpus;
}

export function invalidateCorpus(): void {
  cache.corpus = null;
}

export function listDocuments(): DocumentRecord[] {
  return [...getCorpus().documents].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

export function getDocument(id: string): DocumentRecord | undefined {
  return getCorpus().documents.find((doc) => doc.id === id);
}

export function corpusStats(): CorpusStats {
  const corpus = getCorpus();
  const ready = corpus.documents.filter((doc) => doc.status === "ready");
  return {
    documents: ready.length,
    chunks: corpus.chunks.length,
    words: ready.reduce((sum, doc) => sum + doc.wordCount, 0),
    vocabTerms: corpus.vocab.length,
  };
}

export function upsertDocument(record: DocumentRecord): Promise<void> {
  return withWriteLock(async () => {
    const corpus = getCorpus();
    const next = corpus.documents.filter((doc) => doc.id !== record.id);
    next.push(record);
    await writeJsonAtomic(paths.index, next);
    corpus.documents = next;
  });
}

export function patchDocument(
  id: string,
  patch: Partial<DocumentRecord>,
): Promise<DocumentRecord | undefined> {
  return withWriteLock(async () => {
    const corpus = getCorpus();
    const existing = corpus.documents.find((doc) => doc.id === id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch };
    const next = corpus.documents.map((doc) => (doc.id === id ? updated : doc));
    await writeJsonAtomic(paths.index, next);
    corpus.documents = next;
    return updated;
  });
}

/** Persists the chunk text + vectors for a document and folds them into memory. */
export function saveDocumentChunks(
  document: DocumentRecord,
  chunks: Chunk[],
  vectors: Float32Array[],
): Promise<void> {
  return withWriteLock(async () => {
    ensureDataDirs();
    await writeJsonAtomic(paths.chunkFile(document.id), chunks);
    await writeFile(paths.vectorFile(document.id), packVectors(vectors));

    const corpus = getCorpus();
    corpus.chunks = corpus.chunks.filter((chunk) => chunk.documentId !== document.id);
    chunks.forEach((chunk, i) => {
      const vector = vectors[i];
      if (vector) corpus.chunks.push(hydrate(chunk, document.filename, vector));
    });
  });
}

export function saveVocabulary(terms: LoadedVocabTerm[]): Promise<void> {
  return withWriteLock(async () => {
    ensureDataDirs();
    const plain: VocabTerm[] = terms.map(({ vector: _vector, ...rest }) => rest);
    await writeJsonAtomic(paths.vocabIndex, plain);
    await writeFile(paths.vocabVectors, packVectors(terms.map((t) => t.vector)));
    getCorpus().vocab = terms;
  });
}

export function deleteDocument(id: string): Promise<boolean> {
  return withWriteLock(async () => {
    const corpus = getCorpus();
    const existing = corpus.documents.find((doc) => doc.id === id);
    if (!existing) return false;

    const next = corpus.documents.filter((doc) => doc.id !== id);
    await writeJsonAtomic(paths.index, next);
    corpus.documents = next;
    corpus.chunks = corpus.chunks.filter((chunk) => chunk.documentId !== id);

    await Promise.all([
      rm(paths.chunkFile(id), { force: true }),
      rm(paths.vectorFile(id), { force: true }),
      rm(paths.uploadFile(id, existing.extension), { force: true }),
    ]);
    return true;
  });
}
