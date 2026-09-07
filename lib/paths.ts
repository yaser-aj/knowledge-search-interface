import fs from "node:fs";
import path from "node:path";

const root = path.join(process.cwd(), "data");

export const paths = {
  root,
  dbFile: path.join(root, "knowledge.db"),
  uploads: path.join(root, "uploads"),
  modelsDir: path.join(root, "models"),
};

export function ensureDataDirs() {
  fs.mkdirSync(paths.uploads, { recursive: true });
  fs.mkdirSync(paths.modelsDir, { recursive: true });
}
