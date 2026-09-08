"use client";

import { useRef, useState } from "react";
import {
  AlertTriangle,
  FileText,
  Library,
  Loader2,
  Trash2,
  Upload,
} from "lucide-react";

import type { CorpusStats, DocumentRecord } from "@/lib/types";
import { Badge, EmptyState, SectionLabel, cx, formatBytes } from "./ui";

const ACCEPT = ".pdf,.docx,.txt,.md,.markdown";

export function LibraryPanel({
  documents,
  stats,
  uploading,
  rejected,
  onUpload,
  onDelete,
}: {
  documents: DocumentRecord[];
  stats: CorpusStats;
  uploading: string[];
  rejected: { filename: string; error: string }[];
  onUpload: (files: File[]) => void;
  onDelete: (id: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    onUpload(Array.from(files));
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Library className="size-4 text-faint" />
          <h2 className="text-[13px] font-semibold">Library</h2>
        </div>
        <span className="font-mono text-[11px] text-faint">
          {stats.documents} docs · {stats.chunks} chunks
        </span>
      </div>

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          handleFiles(event.dataTransfer.files);
        }}
        className={cx(
          "rounded-xl border border-dashed p-4 text-center transition-colors",
          dragging ? "border-accent bg-accent-soft" : "border-line bg-surface-2",
        )}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(event) => {
            handleFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <Upload className="mx-auto size-4 text-faint" />
        <p className="mt-2 text-[13px] font-medium">Drop documents here</p>
        <p className="mt-0.5 text-[11px] text-faint">PDF, DOCX, TXT, MD · up to 20 MB</p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="mt-2.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-[12px] font-medium transition-colors hover:border-line-strong hover:bg-surface-3"
        >
          Choose files
        </button>
      </div>

      {rejected.length > 0 ? (
        <div className="rounded-lg border border-bad/30 bg-bad-soft px-2.5 py-2">
          {rejected.map((item) => (
            <p key={item.filename} className="flex gap-1.5 text-[11px] text-bad">
              <AlertTriangle className="mt-px size-3 shrink-0" />
              <span>
                <span className="font-medium">{item.filename}</span> — {item.error}
              </span>
            </p>
          ))}
        </div>
      ) : null}

      <div className="scrollbar-slim -mr-1 min-h-0 flex-1 overflow-y-auto pr-1">
        {uploading.map((filename) => (
          <div
            key={filename}
            className="mb-1.5 flex items-center gap-2 rounded-lg border border-accent-line bg-accent-soft px-2.5 py-2"
          >
            <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-medium">{filename}</p>
              <p className="text-[11px] text-accent">Parsing, chunking, embedding...</p>
            </div>
          </div>
        ))}

        {documents.length === 0 && uploading.length === 0 ? (
          <EmptyState icon={<FileText className="size-5" />} title="No documents yet">
            Upload a file, or run <code className="font-mono text-[11px]">npm run seed</code> to
            index the bundled sample corpus.
          </EmptyState>
        ) : null}

        {documents.map((document) => {
          const open = expanded === document.id;
          return (
            <div
              key={document.id}
              className="group mb-1.5 rounded-lg border border-line bg-surface-2 px-2.5 py-2 transition-colors hover:border-line-strong"
            >
              <div className="flex items-start gap-2">
                <FileText className="mt-0.5 size-3.5 shrink-0 text-faint" />
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : document.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-[12px] font-medium">{document.filename}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-faint">
                    <span>{formatBytes(document.bytes)}</span>
                    {document.status === "ready" ? (
                      <>
                        <span>·</span>
                        <span>{document.chunkCount} chunks</span>
                        {document.pages ? (
                          <>
                            <span>·</span>
                            <span>{document.pages} pages</span>
                          </>
                        ) : null}
                      </>
                    ) : null}
                  </p>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  {document.status === "failed" ? <Badge tone="bad">failed</Badge> : null}
                  {document.status === "processing" ? <Badge tone="accent">indexing</Badge> : null}
                  <button
                    type="button"
                    onClick={() => onDelete(document.id)}
                    aria-label={`Remove ${document.filename}`}
                    className="rounded p-1 text-faint opacity-0 transition hover:bg-bad-soft hover:text-bad focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>

              {document.error ? (
                <p className="mt-1.5 text-[11px] text-bad">{document.error}</p>
              ) : null}

              {open && document.status === "ready" ? (
                <div className="animate-fade-up mt-2 space-y-2 border-t border-line pt-2">
                  <div>
                    <SectionLabel>Indexed terms</SectionLabel>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {document.profile.topTerms.length > 0 ? (
                        document.profile.topTerms.map((term) => (
                          <Badge key={term}>{term}</Badge>
                        ))
                      ) : (
                        <span className="text-[11px] text-faint">None extracted.</span>
                      )}
                    </div>
                  </div>
                  {document.profile.lede ? (
                    <p className="text-[11px] leading-relaxed text-muted">
                      {document.profile.lede}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {stats.vocabTerms > 0 ? (
        <p className="border-t border-line pt-2 text-[11px] text-faint">
          The planner is grounded against{" "}
          <span className="font-medium text-muted">{stats.vocabTerms} indexed terms</span> drawn
          from these documents.
        </p>
      ) : null}
    </div>
  );
}
