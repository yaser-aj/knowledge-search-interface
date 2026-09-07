const TARGET_CHARS = 2000;
const OVERLAP_CHARS = 320;

export type TextChunk = {
  text: string;
  chunkIndex: number;
  page: number | null;
};

export function chunkText(text: string, page: number | null = null): TextChunk[] {
  const cleaned = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  if (!cleaned) return [];

  const chunks: TextChunk[] = [];
  let start = 0;
  let index = 0;

  while (start < cleaned.length) {
    let end = Math.min(start + TARGET_CHARS, cleaned.length);
    if (end < cleaned.length) {
      const slice = cleaned.slice(start, end);
      const breakAt = Math.max(
        slice.lastIndexOf("\n\n"),
        slice.lastIndexOf(". "),
        slice.lastIndexOf("\n"),
      );
      if (breakAt > TARGET_CHARS * 0.4) {
        end = start + breakAt + 1;
      }
    }

    const piece = cleaned.slice(start, end).trim();
    if (piece) {
      chunks.push({ text: piece, chunkIndex: index, page });
      index += 1;
    }

    if (end >= cleaned.length) break;
    start = Math.max(0, end - OVERLAP_CHARS);
  }

  return chunks;
}

export function snippetOf(text: string, max = 220): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max).trim()}…`;
}
