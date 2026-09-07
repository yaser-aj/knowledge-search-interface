import { chunkText, type TextChunk } from "./chunk";

const ALLOWED = new Set(["application/pdf", "text/plain", "text/markdown"]);

export function mimeFor(filename: string, fallback: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  return fallback;
}

export function isAllowedFile(filename: string, mime: string): boolean {
  const resolved = mimeFor(filename, mime);
  return ALLOWED.has(resolved) || filename.toLowerCase().match(/\.(pdf|txt|md|markdown)$/) !== null;
}

export async function parseAndChunk(filename: string, bytes: Buffer): Promise<TextChunk[]> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) {
    const { extractText } = await import("unpdf");
    const { text } = await extractText(new Uint8Array(bytes), { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];
    const chunks: TextChunk[] = [];
    pages.forEach((pageText, i) => {
      const pageChunks = chunkText(pageText ?? "", i + 1);
      for (const chunk of pageChunks) {
        chunks.push({ ...chunk, chunkIndex: chunks.length });
      }
    });
    return chunks;
  }

  const raw = bytes.toString("utf8");
  return chunkText(raw);
}
