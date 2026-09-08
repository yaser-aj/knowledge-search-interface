import { ingestDocument, MAX_UPLOAD_BYTES } from "@/lib/ingest";
import { isConfigured } from "@/lib/llm";
import { corpusStats, listDocuments } from "@/lib/store";
import type { DocumentRecord } from "@/lib/types";

export interface DocumentsResponse {
  documents: DocumentRecord[];
  stats: ReturnType<typeof corpusStats>;
  llmConfigured: boolean;
  rejected?: { filename: string; error: string }[];
}

function payload(rejected?: DocumentsResponse["rejected"]): DocumentsResponse {
  return {
    documents: listDocuments(),
    stats: corpusStats(),
    llmConfigured: isConfigured(),
    ...(rejected && rejected.length > 0 ? { rejected } : {}),
  };
}

export async function GET() {
  return Response.json(payload());
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Expected a multipart upload." }, { status: 400 });
  }

  const files = form.getAll("files").filter((entry): entry is File => entry instanceof File);
  if (files.length === 0) {
    return Response.json({ error: "No files were attached." }, { status: 400 });
  }

  const rejected: NonNullable<DocumentsResponse["rejected"]> = [];

  for (const file of files) {
    if (file.size > MAX_UPLOAD_BYTES) {
      rejected.push({ filename: file.name, error: "Larger than the 20 MB limit." });
      continue;
    }
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      await ingestDocument({ filename: file.name, buffer });
    } catch (error) {
      rejected.push({
        filename: file.name,
        error: error instanceof Error ? error.message : "Indexing failed.",
      });
    }
  }

  return Response.json(payload(rejected));
}
