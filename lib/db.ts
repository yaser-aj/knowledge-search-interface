import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ensureDataDirs, paths } from "./paths";
import type {
  ChunkRecord,
  DocumentRecord,
  DocumentStatus,
  NodeRecord,
  NodeStatus,
  NodeType,
  RunRecord,
  RunStatus,
} from "./types";

ensureDataDirs();

const db = new Database(paths.dbFile);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  page INTEGER,
  text TEXT NOT NULL,
  embedding BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  helpful INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  input TEXT,
  output TEXT,
  error TEXT,
  model TEXT,
  started_at INTEGER,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  helpful_count INTEGER NOT NULL DEFAULT 1,
  UNIQUE(term, document_id)
);

CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_nodes_run ON nodes(run_id);
CREATE INDEX IF NOT EXISTS idx_intents_term ON intents(term);
`);

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function mapDocument(row: Record<string, unknown>): DocumentRecord {
  return {
    id: Number(row.id),
    filename: String(row.filename),
    storedName: String(row.stored_name),
    size: Number(row.size),
    mime: String(row.mime),
    status: row.status as DocumentStatus,
    error: row.error == null ? null : String(row.error),
    chunkCount: Number(row.chunk_count),
    createdAt: Number(row.created_at),
  };
}

function mapRun(row: Record<string, unknown>): RunRecord {
  return {
    id: Number(row.id),
    question: String(row.question),
    status: row.status as RunStatus,
    createdAt: Number(row.created_at),
    helpful: Number(row.helpful),
  };
}

function mapNode(row: Record<string, unknown>): NodeRecord {
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    type: row.type as NodeType,
    status: row.status as NodeStatus,
    input: parseJson(row.input as string | null),
    output: parseJson(row.output as string | null),
    error: row.error == null ? null : String(row.error),
    model: row.model == null ? null : String(row.model),
    startedAt: row.started_at == null ? null : Number(row.started_at),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
  };
}

function embeddingToBuffer(values: Float32Array): Buffer {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

function bufferToEmbedding(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

export function listDocuments(): DocumentRecord[] {
  const rows = db
    .prepare("SELECT * FROM documents ORDER BY created_at DESC")
    .all() as Record<string, unknown>[];
  return rows.map(mapDocument);
}

export function getDocument(id: number): DocumentRecord | null {
  const row = db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapDocument(row) : null;
}

export function findDocumentByFilename(filename: string): DocumentRecord | null {
  const row = db
    .prepare("SELECT * FROM documents WHERE filename = ? COLLATE NOCASE")
    .get(filename) as Record<string, unknown> | undefined;
  return row ? mapDocument(row) : null;
}

export function insertDocument(input: {
  filename: string;
  storedName: string;
  size: number;
  mime: string;
}): DocumentRecord {
  const createdAt = Date.now();
  const info = db
    .prepare(
      `INSERT INTO documents (filename, stored_name, size, mime, status, error, chunk_count, created_at)
       VALUES (?, ?, ?, ?, 'indexing', NULL, 0, ?)`,
    )
    .run(input.filename, input.storedName, input.size, input.mime, createdAt);
  return getDocument(Number(info.lastInsertRowid))!;
}

export function updateDocument(
  id: number,
  patch: Partial<Pick<DocumentRecord, "status" | "error" | "chunkCount">>,
): DocumentRecord {
  const current = getDocument(id);
  if (!current) throw new Error(`Document ${id} not found`);
  db.prepare(
    `UPDATE documents SET status = ?, error = ?, chunk_count = ? WHERE id = ?`,
  ).run(
    patch.status ?? current.status,
    patch.error === undefined ? current.error : patch.error,
    patch.chunkCount ?? current.chunkCount,
    id,
  );
  return getDocument(id)!;
}

export function deleteDocument(id: number): boolean {
  const doc = getDocument(id);
  if (!doc) return false;
  db.prepare("DELETE FROM documents WHERE id = ?").run(id);
  const filePath = path.join(paths.uploads, doc.storedName);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  return true;
}

export function replaceChunks(
  documentId: number,
  chunks: { chunkIndex: number; page: number | null; text: string; embedding: Float32Array }[],
) {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM chunks WHERE document_id = ?").run(documentId);
    const insert = db.prepare(
      `INSERT INTO chunks (document_id, chunk_index, page, text, embedding)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const chunk of chunks) {
      insert.run(
        documentId,
        chunk.chunkIndex,
        chunk.page,
        chunk.text,
        embeddingToBuffer(chunk.embedding),
      );
    }
  });
  tx();
}

export function listChunksWithDocuments(): ChunkRecord[] {
  const rows = db
    .prepare(
      `SELECT c.*, d.filename
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE d.status = 'ready'`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((row) => ({
    id: Number(row.id),
    documentId: Number(row.document_id),
    filename: String(row.filename),
    chunkIndex: Number(row.chunk_index),
    page: row.page == null ? null : Number(row.page),
    text: String(row.text),
    embedding: bufferToEmbedding(row.embedding as Buffer),
  }));
}

export function getChunksByIds(ids: number[]): ChunkRecord[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT c.*, d.filename
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE c.id IN (${placeholders})`,
    )
    .all(...ids) as Record<string, unknown>[];
  const mapped = rows.map((row) => ({
    id: Number(row.id),
    documentId: Number(row.document_id),
    filename: String(row.filename),
    chunkIndex: Number(row.chunk_index),
    page: row.page == null ? null : Number(row.page),
    text: String(row.text),
    embedding: bufferToEmbedding(row.embedding as Buffer),
  }));
  const byId = new Map(mapped.map((c) => [c.id, c]));
  return ids.map((id) => byId.get(id)).filter((c): c is ChunkRecord => Boolean(c));
}

export function intentBoostsForTerms(terms: string[]): Map<number, number> {
  const boosts = new Map<number, number>();
  if (terms.length === 0) return boosts;
  const placeholders = terms.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT document_id, SUM(helpful_count) AS helpful
       FROM intents
       WHERE term IN (${placeholders})
       GROUP BY document_id`,
    )
    .all(...terms) as { document_id: number; helpful: number }[];
  for (const row of rows) {
    boosts.set(Number(row.document_id), Number(row.helpful));
  }
  return boosts;
}

export function recordIntentFeedback(terms: string[], documentIds: number[]) {
  const upsert = db.prepare(
    `INSERT INTO intents (term, document_id, helpful_count)
     VALUES (?, ?, 1)
     ON CONFLICT(term, document_id) DO UPDATE SET helpful_count = helpful_count + 1`,
  );
  const tx = db.transaction(() => {
    for (const term of terms) {
      for (const documentId of documentIds) {
        upsert.run(term, documentId);
      }
    }
  });
  tx();
}

export function createRun(question: string): { run: RunRecord; nodes: NodeRecord[] } {
  const createdAt = Date.now();
  const info = db
    .prepare(`INSERT INTO runs (question, status, created_at, helpful) VALUES (?, 'running', ?, 0)`)
    .run(question, createdAt);
  const runId = Number(info.lastInsertRowid);
  const insertNode = db.prepare(
    `INSERT INTO nodes (run_id, type, status, input, output, error, model, started_at, finished_at)
     VALUES (?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, NULL)`,
  );
  for (const type of ["retrieve", "plan", "write", "verify"] as NodeType[]) {
    insertNode.run(runId, type);
  }
  return { run: getRun(runId)!, nodes: listNodes(runId) };
}

export function getRun(id: number): RunRecord | null {
  const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapRun(row) : null;
}

export function updateRun(id: number, patch: Partial<Pick<RunRecord, "status" | "helpful">>) {
  const current = getRun(id);
  if (!current) throw new Error(`Run ${id} not found`);
  db.prepare(`UPDATE runs SET status = ?, helpful = ? WHERE id = ?`).run(
    patch.status ?? current.status,
    patch.helpful ?? current.helpful,
    id,
  );
  return getRun(id)!;
}

export function listNodes(runId: number): NodeRecord[] {
  const rows = db
    .prepare("SELECT * FROM nodes WHERE run_id = ? ORDER BY id ASC")
    .all(runId) as Record<string, unknown>[];
  return rows.map(mapNode);
}

export function updateNode(
  id: number,
  patch: Partial<Pick<NodeRecord, "status" | "input" | "output" | "error" | "model" | "startedAt" | "finishedAt">>,
): NodeRecord {
  const row = db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error(`Node ${id} not found`);
  const current = mapNode(row);
  db.prepare(
    `UPDATE nodes
     SET status = ?, input = ?, output = ?, error = ?, model = ?, started_at = ?, finished_at = ?
     WHERE id = ?`,
  ).run(
    patch.status ?? current.status,
    JSON.stringify(patch.input === undefined ? current.input : patch.input),
    JSON.stringify(patch.output === undefined ? current.output : patch.output),
    patch.error === undefined ? current.error : patch.error,
    patch.model === undefined ? current.model : patch.model,
    patch.startedAt === undefined ? current.startedAt : patch.startedAt,
    patch.finishedAt === undefined ? current.finishedAt : patch.finishedAt,
    id,
  );
  const updated = db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as Record<string, unknown>;
  return mapNode(updated);
}

export function nodeByType(runId: number, type: NodeType): NodeRecord {
  const nodes = listNodes(runId);
  const node = nodes.find((n) => n.type === type);
  if (!node) throw new Error(`Node ${type} missing for run ${runId}`);
  return node;
}
