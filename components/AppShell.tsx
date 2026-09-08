"use client";

import { useCallback, useState } from "react";
import { AlertTriangle, BrainCircuit, KeyRound, PanelRightClose, PanelRightOpen } from "lucide-react";

import type { CorpusStats, DocumentRecord } from "@/lib/types";
import type { DocumentsResponse } from "@/app/api/documents/route";
import { AnswerCard } from "./AnswerCard";
import { AskPanel } from "./AskPanel";
import { LibraryPanel } from "./LibraryPanel";
import { ReasoningPanel } from "./ReasoningPanel";
import { SourcesPanel } from "./SourcesPanel";
import { Badge, EmptyState, cx } from "./ui";
import { useAskRun } from "./useAskRun";

export function AppShell({
  initialDocuments,
  initialStats,
  llmConfigured,
}: {
  initialDocuments: DocumentRecord[];
  initialStats: CorpusStats;
  llmConfigured: boolean;
}) {
  const [documents, setDocuments] = useState(initialDocuments);
  const [stats, setStats] = useState(initialStats);
  const [uploading, setUploading] = useState<string[]>([]);
  const [rejected, setRejected] = useState<{ filename: string; error: string }[]>([]);
  const [showReasoning, setShowReasoning] = useState(true);
  const [activeSource, setActiveSource] = useState<number | null>(null);

  const { run, ask, cancel } = useAskRun();

  const applyResponse = useCallback((payload: DocumentsResponse) => {
    setDocuments(payload.documents);
    setStats(payload.stats);
    setRejected(payload.rejected ?? []);
  }, []);

  const upload = useCallback(
    async (files: File[]) => {
      setRejected([]);
      setUploading(files.map((file) => file.name));

      const body = new FormData();
      for (const file of files) body.append("files", file);

      try {
        const response = await fetch("/api/documents", { method: "POST", body });
        const payload = (await response.json()) as DocumentsResponse & { error?: string };
        if (!response.ok) {
          setRejected(
            files.map((file) => ({
              filename: file.name,
              error: payload.error ?? "Upload failed.",
            })),
          );
          return;
        }
        applyResponse(payload);
      } catch {
        setRejected(
          files.map((file) => ({ filename: file.name, error: "Upload failed." })),
        );
      } finally {
        setUploading([]);
      }
    },
    [applyResponse],
  );

  const remove = useCallback(
    async (id: string) => {
      // Optimistic: the row disappears while the vocabulary is rebuilt.
      setDocuments((current) => current.filter((document) => document.id !== id));
      try {
        const response = await fetch(`/api/documents/${id}`, { method: "DELETE" });
        if (response.ok) applyResponse((await response.json()) as DocumentsResponse);
      } catch {
        // Leave the optimistic state; a reload will resync.
      }
    },
    [applyResponse],
  );

  const askQuestion = useCallback(
    (question: string) => {
      setActiveSource(null);
      void ask(question);
    },
    [ask],
  );

  const empty = stats.chunks === 0;
  const started = run.status !== "idle";

  return (
    <div className="mx-auto flex min-h-dvh max-w-[1680px] flex-col">
      <header className="sticky top-0 z-10 border-b border-line bg-canvas/85 backdrop-blur-md">
        <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
          <div className="flex size-8 items-center justify-center rounded-lg bg-accent text-white">
            <BrainCircuit className="size-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-[15px] leading-tight font-semibold">Knowledge Search</h1>
            <p className="truncate text-[11px] text-faint">
              Plan, retrieve, write, verify — every answer shows its sources
            </p>
          </div>

          {!llmConfigured ? (
            <Badge tone="warn" title="Set OPENROUTER_API_KEY in .env.local for the planner, writer and verifier.">
              <KeyRound className="size-3" />
              no API key
            </Badge>
          ) : null}
          <span className="hidden font-mono text-[11px] text-faint sm:inline">
            {stats.documents} docs · {stats.chunks} chunks · {stats.vocabTerms} terms
          </span>
          <button
            type="button"
            onClick={() => setShowReasoning(!showReasoning)}
            title={showReasoning ? "Hide reasoning" : "Show reasoning"}
            className="rounded-lg border border-line p-1.5 text-muted transition-colors hover:border-line-strong hover:text-ink"
          >
            {showReasoning ? (
              <PanelRightClose className="size-4" />
            ) : (
              <PanelRightOpen className="size-4" />
            )}
          </button>
        </div>
      </header>

      <div
        className={cx(
          "grid flex-1 gap-4 px-4 py-4 sm:px-6",
          showReasoning
            ? "lg:grid-cols-[290px_minmax(0,1fr)] xl:grid-cols-[290px_minmax(0,1fr)_380px]"
            : "lg:grid-cols-[290px_minmax(0,1fr)]",
        )}
      >
        <aside className="panel h-fit max-h-[calc(100dvh-7rem)] p-3 lg:sticky lg:top-[4.5rem]">
          <LibraryPanel
            documents={documents}
            stats={stats}
            uploading={uploading}
            rejected={rejected}
            onUpload={upload}
            onDelete={remove}
          />
        </aside>

        <main className="flex min-w-0 flex-col gap-4">
          <AskPanel
            disabled={empty || uploading.length > 0}
            running={run.status === "running"}
            onAsk={askQuestion}
            onCancel={cancel}
          />

          {run.error ? (
            <div className="flex items-start gap-2 rounded-xl border border-bad/30 bg-bad-soft px-3 py-2.5">
              <AlertTriangle className="mt-px size-4 shrink-0 text-bad" />
              <p className="text-[12px] leading-relaxed text-bad">{run.error}</p>
            </div>
          ) : null}

          {!started ? (
            <div className="panel">
              <EmptyState
                icon={<BrainCircuit className="size-6" />}
                title={empty ? "Add a document to begin" : "Ask a question"}
              >
                {empty
                  ? "Drop a PDF, DOCX, TXT or Markdown file into the library. It is parsed, chunked and embedded locally."
                  : "The planner expands your wording into terms the documents actually use, so a question about a category still finds the passage that names a specific member of it."}
              </EmptyState>
            </div>
          ) : null}

          {started && (run.answer || run.streaming) ? (
            <AnswerCard
              answer={run.answer}
              streaming={run.streaming}
              passages={run.passages}
              degraded={run.usage.degraded}
              onCite={setActiveSource}
            />
          ) : null}

          <SourcesPanel passages={run.passages} activeSource={activeSource} />

          {showReasoning ? (
            <div className="xl:hidden">{started ? <ReasoningPanel run={run} /> : null}</div>
          ) : null}
        </main>

        {showReasoning ? (
          <aside className="hidden min-w-0 xl:block">
            {started ? (
              <div className="sticky top-[4.5rem] max-h-[calc(100dvh-6rem)] overflow-y-auto pb-4 scrollbar-slim">
                <ReasoningPanel run={run} />
              </div>
            ) : (
              <div className="panel sticky top-[4.5rem]">
                <EmptyState title="Reasoning trace">
                  Each stage of the graph reports here as it runs: the plan and its expansions, what
                  retrieval found and why, and the claim-by-claim audit.
                </EmptyState>
              </div>
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
