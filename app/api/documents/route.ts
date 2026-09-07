import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  findDocumentByFilename,
  insertDocument,
  listDocuments,
} from "@/lib/db";
import { indexDocument } from "@/lib/ingest";
import { isAllowedFile, mimeFor } from "@/lib/parse";
import { ensureDataDirs, paths } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeStoredName(filename: string) {
  const base = filename.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  return `${Date.now()}-${randomBytes(4).toString("hex")}-${base}`;
}

export async function GET() {
  return Response.json({ documents: listDocuments() });
}

export async function POST(request: Request) {
  ensureDataDirs();
  const form = await request.formData();
  const files = form.getAll("files").filter((f): f is File => f instanceof File);

  if (files.length === 0) {
    return Response.json({ error: "Attach at least one PDF, TXT, or MD file." }, { status: 400 });
  }

  const created = [];
  for (const file of files) {
    const mime = mimeFor(file.name, file.type || "application/octet-stream");
    if (!isAllowedFile(file.name, mime)) {
      return Response.json(
        { error: `${file.name} is not a supported type. Use PDF, TXT, or MD.` },
        { status: 400 },
      );
    }
    if (findDocumentByFilename(file.name)) {
      return Response.json(
        { error: `A document named “${file.name}” is already in the library.` },
        { status: 409 },
      );
    }

    const storedName = safeStoredName(file.name);
    const bytes = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(path.join(paths.uploads, storedName), bytes);
    const doc = insertDocument({
      filename: file.name,
      storedName,
      size: bytes.length,
      mime,
    });
    created.push(doc);
  }

  void Promise.all(created.map((doc) => indexDocument(doc.id)));
  return Response.json({ documents: created });
}
