import path from "node:path";

import { collapseWhitespace } from "./text";

export interface ParsedPage {
  /** 1-based page number for PDFs, null for formats without pagination. */
  page: number | null;
  text: string;
}

export interface ParsedDocument {
  pages: ParsedPage[];
  totalPages: number | null;
}

export const SUPPORTED_EXTENSIONS = [".pdf", ".docx", ".txt", ".md", ".markdown"] as const;

export function extensionOf(filename: string): string {
  return path.extname(filename).toLowerCase();
}

export function isSupported(filename: string): boolean {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(extensionOf(filename));
}

async function parsePdf(buffer: Buffer): Promise<ParsedDocument> {
  const { extractText } = await import("unpdf");
  const { totalPages, text } = await extractText(new Uint8Array(buffer), {
    mergePages: false,
  });
  const pages = text
    .map((raw, i) => ({ page: i + 1, text: collapseWhitespace(raw) }))
    .filter((page) => page.text.length > 0);
  return { pages, totalPages };
}

async function parseDocx(buffer: Buffer): Promise<ParsedDocument> {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ buffer });
  return { pages: [{ page: null, text: collapseWhitespace(value) }], totalPages: null };
}

export async function parseDocument(
  filename: string,
  buffer: Buffer,
): Promise<ParsedDocument> {
  const extension = extensionOf(filename);

  switch (extension) {
    case ".pdf":
      return parsePdf(buffer);
    case ".docx":
      return parseDocx(buffer);
    case ".txt":
    case ".md":
    case ".markdown":
      return {
        pages: [{ page: null, text: collapseWhitespace(buffer.toString("utf8")) }],
        totalPages: null,
      };
    default:
      throw new Error(
        `Unsupported file type "${extension || filename}". Upload PDF, DOCX, TXT, or MD.`,
      );
  }
}
