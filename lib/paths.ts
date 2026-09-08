import { mkdirSync } from "node:fs";
import path from "node:path";

const root = process.env.KSI_DATA_DIR
  ? path.resolve(process.env.KSI_DATA_DIR)
  : path.join(process.cwd(), "data");

export const paths = {
  root,
  uploads: path.join(root, "uploads"),
  chunks: path.join(root, "chunks"),
  vectors: path.join(root, "vectors"),
  models: path.join(root, "models"),
  index: path.join(root, "index.json"),
  vocabIndex: path.join(root, "vocab.json"),
  vocabVectors: path.join(root, "vocab.f32"),
  chunkFile: (documentId: string) => path.join(root, "chunks", `${documentId}.json`),
  vectorFile: (documentId: string) => path.join(root, "vectors", `${documentId}.f32`),
  uploadFile: (documentId: string, ext: string) =>
    path.join(root, "uploads", `${documentId}${ext}`),
};

let ensured = false;

export function ensureDataDirs(): void {
  if (ensured) return;
  for (const dir of [paths.root, paths.uploads, paths.chunks, paths.vectors, paths.models]) {
    mkdirSync(dir, { recursive: true });
  }
  ensured = true;
}
