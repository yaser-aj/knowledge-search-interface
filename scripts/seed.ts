import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { ingestDocument } from "@/lib/ingest";
import { isSupported } from "@/lib/parse";
import { corpusStats } from "@/lib/store";

const directory = path.resolve(process.argv[2] ?? "fixtures");
const entries = (await readdir(directory)).filter(isSupported).sort();

if (entries.length === 0) {
  console.error(`No supported documents found in ${directory}`);
  process.exit(1);
}

console.log(`Indexing ${entries.length} document(s) from ${directory}\n`);

for (const filename of entries) {
  const buffer = await readFile(path.join(directory, filename));
  const started = Date.now();
  const record = await ingestDocument({ filename, buffer });
  const detail =
    record.status === "ready"
      ? `${record.chunkCount} chunks, ${record.wordCount} words`
      : (record.error ?? "failed");
  console.log(`  ${record.status === "ready" ? "ok" : "!!"}  ${filename} — ${detail} (${Date.now() - started}ms)`);
}

const stats = corpusStats();
console.log(
  `\nIndex: ${stats.documents} documents, ${stats.chunks} chunks, ${stats.words} words, ${stats.vocabTerms} vocabulary terms`,
);
