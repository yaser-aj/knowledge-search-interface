import type { ParsedPage } from "./parse";
import type { Chunk } from "./types";

const TARGET_CHARS = 900;
const OVERLAP_CHARS = 160;
const MIN_CHARS = 60;

function headingOf(block: string): string | null {
  const line = block.trim();
  if (/^#{1,6}\s+\S/.test(line)) {
    return line.replace(/^#{1,6}\s+/, "").replace(/\s*#+\s*$/, "").trim();
  }
  // Short, punctuation-free, title-ish lines act as headings in plain text files.
  if (
    line.length <= 80 &&
    !line.includes("\n") &&
    !/[.!?;:]$/.test(line) &&
    /^[\p{Lu}\p{N}]/u.test(line) &&
    line.split(/\s+/).length <= 10 &&
    line === line.replace(/\s{2,}/g, " ")
  ) {
    const letters = line.replace(/[^\p{L}]/gu, "");
    const upper = line.replace(/[^\p{Lu}]/gu, "");
    if (letters.length > 0 && upper.length / letters.length > 0.6) return line;
  }
  return null;
}

/** Keeps the tail of a flushed chunk so a fact split across a boundary stays findable. */
function overlapTail(text: string): string {
  if (text.length <= OVERLAP_CHARS) return text;
  const tail = text.slice(-OVERLAP_CHARS);
  const boundary = tail.search(/[.!?]\s+\S/);
  return boundary === -1 ? tail : tail.slice(boundary + 1).trimStart();
}

function splitBlocks(text: string): string[] {
  return text
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean);
}

/**
 * Splits an oversized single block on sentence boundaries so one wall-of-text
 * paragraph does not become one unsearchable chunk.
 */
function splitLongBlock(block: string): string[] {
  if (block.length <= TARGET_CHARS) return [block];
  const sentences = block.match(/[^.!?]+[.!?]+[\s]*|[^.!?]+$/g) ?? [block];
  const out: string[] = [];
  let buffer = "";
  for (const sentence of sentences) {
    if (buffer && buffer.length + sentence.length > TARGET_CHARS) {
      out.push(buffer.trim());
      buffer = overlapTail(buffer);
    }
    buffer += sentence;
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out;
}

export function chunkPages(documentId: string, pages: ParsedPage[]): Chunk[] {
  const chunks: Chunk[] = [];
  let heading: string | null = null;
  let buffer = "";
  let bufferPage: number | null = null;
  let bufferHeading: string | null = null;

  /** Emits the buffered text as a chunk and returns the overlap seed for the next one. */
  const flush = (): string => {
    const text = buffer.trim();
    buffer = "";
    if (!text) return "";

    // Too small to stand alone: fold it into the previous chunk rather than lose it.
    const previous = chunks.at(-1);
    if (text.length < MIN_CHARS && previous) {
      previous.text = `${previous.text}\n\n${text}`;
      return "";
    }

    const index = chunks.length;
    chunks.push({
      id: `${documentId}:${index}`,
      documentId,
      index,
      page: bufferPage,
      heading: bufferHeading,
      text,
    });
    return overlapTail(text);
  };

  for (const page of pages) {
    for (const rawBlock of splitBlocks(page.text)) {
      const maybeHeading = headingOf(rawBlock);
      if (maybeHeading) {
        // A new section starts: close the current chunk so headings stay clean.
        if (buffer.trim().length >= MIN_CHARS) flush();
        heading = maybeHeading;
        continue;
      }

      for (const block of splitLongBlock(rawBlock)) {
        if (buffer && buffer.length + block.length + 2 > TARGET_CHARS) {
          buffer = flush();
        }
        if (!buffer) {
          bufferPage = page.page;
          bufferHeading = heading;
        }
        buffer = buffer ? `${buffer}\n\n${block}` : block;
      }
    }
  }

  flush();
  return chunks;
}

export function chunkPreview(chunk: Chunk): string {
  return chunk.heading ? `${chunk.heading} — ${chunk.text}` : chunk.text;
}
