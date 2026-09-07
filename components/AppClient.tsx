"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DocumentRecord,
  NodeRecord,
  NodeType,
  PipelineEvent,
  RetrieveOutput,
  RunRecord,
  Source,
  VerifyOutput,
  WriteOutput,
} from "@/lib/types";

const NODE_META: { type: NodeType; label: string; hint: string }[] = [
  { type: "retrieve", label: "Retrieve", hint: "Rank passages from your library" },
  { type: "plan", label: "Plan", hint: "Pick results and outline the answer" },
  { type: "write", label: "Write", hint: "Draft the cited response" },
  { type: "verify", label: "Verify", hint: "Check claims against sources" },
];

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWhen(ts: number) {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function readSse(
  response: Response,
  onEvent: (event: PipelineEvent) => void,
) {
  if (!response.body) throw new Error("No response stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const dataLine = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (!dataLine) continue;
      onEvent(JSON.parse(dataLine) as PipelineEvent);
    }
  }
}

function AnswerBody({
  text,
  onCite,
  active,
}: {
  text: string;
  onCite: (n: number) => void;
  active: number | null;
}) {
  const parts = text.split(/(\[\d+\])/g);
  return (
    <div className="whitespace-pre-wrap font-serif text-[1.05rem] leading-8 text-ink">
      {parts.map((part, i) => {
        const cite = part.match(/^\[(\d+)\]$/);
        if (!cite) return <span key={i}>{part}</span>;
        const n = Number(cite[1]);
        return (
          <button
            key={i}
            type="button"
            onClick={() => onCite(n)}
            className={`mx-0.5 inline-flex translate-y-[-1px] rounded-sm px-1 font-sans text-[0.72rem] font-semibold tracking-wide ${
              active === n
                ? "bg-sienna text-paper"
                : "bg-paper-deep text-sienna-deep hover:bg-sienna hover:text-paper"
            }`}
          >
            {part}
          </button>
        );
      })}
    </div>
  );
}

export function AppClient({
  initialDocuments,
}: {
  initialDocuments: DocumentRecord[];
}) {
  const [documents, setDocuments] = useState<DocumentRecord[]>(initialDocuments);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [run, setRun] = useState<RunRecord | null>(null);
  const [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [answer, setAnswer] = useState("");
  const [activeSource, setActiveSource] = useState<number | null>(null);
  const [helpful, setHelpful] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [openNode, setOpenNode] = useState<NodeType | null>("plan");
  const fileRef = useRef<HTMLInputElement>(null);

  const loadDocuments = useCallback(async () => {
    const res = await fetch("/api/documents");
    const data = (await res.json()) as { documents: DocumentRecord[] };
    setDocuments(data.documents);
  }, []);

  const indexing = documents.some((d) => d.status === "indexing");
  useEffect(() => {
    if (!indexing) return;
    const timer = setInterval(() => {
      void loadDocuments();
    }, 1000);
    return () => clearInterval(timer);
  }, [indexing, loadDocuments]);

  const readyCount = documents.filter((d) => d.status === "ready").length;

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(true);
    setLibraryError(null);
    const form = new FormData();
    for (const file of list) form.append("files", file);
    const res = await fetch("/api/documents", { method: "POST", body: form });
    const data = (await res.json()) as { error?: string };
    if (!res.ok) setLibraryError(data.error ?? "Upload failed");
    await loadDocuments();
    setUploading(false);
  }

  async function removeDocument(id: number) {
    await fetch(`/api/documents/${id}`, { method: "DELETE" });
    await loadDocuments();
  }

  async function retryDocument(id: number) {
    await fetch(`/api/documents/${id}/retry`, { method: "POST" });
    await loadDocuments();
  }

  function applyEvent(event: PipelineEvent) {
    if (event.type === "run") setRun(event.run);
    if (event.type === "node") {
      setNodes((current) => {
        const next = current.filter((n) => n.id !== event.node.id);
        next.push(event.node);
        return next.sort((a, b) => a.id - b.id);
      });
      if (event.node.type === "write" && event.node.status === "done") {
        const output = event.node.output as WriteOutput | null;
        if (output?.answer) setAnswer(output.answer);
      }
    }
    if (event.type === "write_delta") {
      setAnswer((current) => current + event.text);
    }
    if (event.type === "error") setAskError(event.message);
    if (event.type === "done") setRun(event.run);
  }

  async function ask(url: string, init?: RequestInit) {
    setAsking(true);
    setAskError(null);
    setAnswer("");
    setHelpful(false);
    setActiveSource(null);
    if (!init) {
      setNodes([]);
      setRun(null);
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ...init,
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? "Ask failed");
      }
      await readSse(res, applyEvent);
    } catch (error) {
      setAskError(error instanceof Error ? error.message : "Ask failed");
    } finally {
      setAsking(false);
    }
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!question.trim() || readyCount === 0) return;
    await ask("/api/ask", { body: JSON.stringify({ question: question.trim() }) });
  }

  const writeNode = nodes.find((n) => n.type === "write");
  const retrieveNode = nodes.find((n) => n.type === "retrieve");
  const verifyNode = nodes.find((n) => n.type === "verify");
  const sources: Source[] =
    (writeNode?.output as WriteOutput | null)?.sources ??
    ((retrieveNode?.output as RetrieveOutput | null)?.results ?? []).map((p, i) => ({
      n: i + 1,
      documentId: p.documentId,
      filename: p.filename,
      chunkId: p.chunkId,
      page: p.page,
      score: Number(p.boostedScore.toFixed(3)),
      snippet: p.snippet,
    }));
  const retrieveOut = retrieveNode?.output as RetrieveOutput | null;
  const verifyOut = verifyNode?.output as VerifyOutput | null;
  const failedNode = nodes.find((n) => n.status === "failed");
  const displayedSources: Source[] =
    run?.status === "insufficient"
      ? (retrieveOut?.nearMisses ?? []).map((p, i) => ({
          n: i + 1,
          documentId: p.documentId,
          filename: p.filename,
          chunkId: p.chunkId,
          page: p.page,
          score: Number(p.score.toFixed(3)),
          snippet: p.snippet,
        }))
      : sources;

  const canAsk = readyCount > 0 && !asking && !uploading;

  const emptyCopy = useMemo(() => {
    if (documents.length === 0) return "Upload documents first.";
    if (readyCount === 0) return "Wait until a document is ready, then ask.";
    return "Ask a question about the library.";
  }, [documents.length, readyCount]);

  return (
    <div className="flex min-h-full">
      <aside className="flex w-[22rem] shrink-0 flex-col bg-walnut text-paper">
        <div className="border-b border-white/10 px-6 py-6">
          <p className="text-[0.68rem] font-semibold uppercase tracking-[0.22em] text-[#d9b48c]">
            Library
          </p>
          <h1 className="mt-2 font-serif text-3xl leading-tight">Knowledge Search</h1>
          <p className="mt-2 text-sm leading-6 text-[#cbb9a3]">
            Your documents stay on this machine. Answers always name the files they used.
          </p>
        </div>

        <div className="px-6 py-5">
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              void uploadFiles(e.dataTransfer.files);
            }}
            className={`block cursor-pointer rounded-md border border-dashed px-4 py-6 text-center transition ${
              dragOver
                ? "border-sienna bg-sienna/15"
                : "border-[#6a5846] bg-walnut-edge hover:border-[#d9b48c]"
            }`}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.txt,.md,.markdown,application/pdf,text/plain,text/markdown"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) void uploadFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <span className="block font-serif text-lg">Drop PDF, TXT, or MD</span>
            <span className="mt-1 block text-xs text-[#cbb9a3]">
              {uploading ? "Uploading…" : "or click to choose files"}
            </span>
          </label>
          {libraryError ? (
            <p className="mt-3 text-sm text-[#f0b4a8]">{libraryError}</p>
          ) : null}
        </div>

        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-6">
          {documents.length === 0 ? (
            <li className="px-2 text-sm leading-6 text-[#cbb9a3]">
              Nothing indexed yet. Add a few files and they will appear here.
            </li>
          ) : (
            documents.map((doc) => (
              <li
                key={doc.id}
                className="rounded-md border border-white/10 bg-walnut-edge px-3 py-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium leading-5">{doc.filename}</p>
                    <p className="mt-1 text-[0.72rem] uppercase tracking-wide text-[#cbb9a3]">
                      {formatBytes(doc.size)} · {doc.chunkCount} chunks · {formatWhen(doc.createdAt)}
                    </p>
                  </div>
                  <span
                    className={`mt-0.5 shrink-0 rounded-sm px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wider ${
                      doc.status === "ready"
                        ? "bg-moss/30 text-[#b7d7c2]"
                        : doc.status === "error"
                          ? "bg-clay/30 text-[#f0b4a8]"
                          : "bg-sienna/20 text-[#f0c9a6]"
                    }`}
                  >
                    {doc.status}
                  </span>
                </div>
                {doc.error ? (
                  <p className="mt-2 text-xs leading-5 text-[#f0b4a8]">{doc.error}</p>
                ) : null}
                <div className="mt-3 flex gap-2">
                  {doc.status === "error" || doc.status === "indexing" ? (
                    <button
                      type="button"
                      onClick={() => void retryDocument(doc.id)}
                      className="text-xs font-medium text-[#d9b48c] underline-offset-2 hover:underline"
                    >
                      Retry
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void removeDocument(doc.id)}
                    className="text-xs font-medium text-[#f0b4a8] underline-offset-2 hover:underline"
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))
          )}
        </ul>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-rule px-8 py-6">
          <form onSubmit={onSubmit} className="mx-auto max-w-3xl">
            <label className="text-[0.68rem] font-semibold uppercase tracking-[0.22em] text-ink-soft">
              Ask the library
            </label>
            <div className="mt-3 flex gap-3">
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder={emptyCopy}
                disabled={!canAsk}
                className="h-12 flex-1 rounded-md border border-rule bg-white/70 px-4 text-ink outline-none ring-sienna/30 placeholder:text-ink-soft/70 focus:ring-2 disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={!canAsk || !question.trim()}
                className="h-12 rounded-md bg-sienna px-5 text-sm font-semibold text-paper hover:bg-sienna-deep disabled:opacity-50"
              >
                {asking ? "Working…" : "Ask"}
              </button>
            </div>
          </form>
        </header>

        <div className="flex-1 overflow-y-auto px-8 py-8">
          <div className="mx-auto flex max-w-3xl flex-col gap-8">
            <section>
              <p className="text-[0.68rem] font-semibold uppercase tracking-[0.22em] text-ink-soft">
                Reasoning
              </p>
              <ol className="mt-3 grid grid-cols-4 gap-2">
                {NODE_META.map((meta, index) => {
                  const node = nodes.find((n) => n.type === meta.type);
                  const status = node?.status ?? "pending";
                  return (
                    <li key={meta.type}>
                      <button
                        type="button"
                        onClick={() => setOpenNode(openNode === meta.type ? null : meta.type)}
                        className={`w-full rounded-md border px-3 py-3 text-left ${
                          status === "running"
                            ? "border-sienna bg-sienna/10"
                            : status === "done"
                              ? "border-moss/40 bg-moss/10"
                              : status === "failed"
                                ? "border-clay bg-clay/10"
                                : "border-rule bg-white/50"
                        }`}
                      >
                        <span className="block text-[0.65rem] uppercase tracking-wider text-ink-soft">
                          {String(index + 1).padStart(2, "0")} · {status}
                        </span>
                        <span className="mt-1 block font-serif text-lg">{meta.label}</span>
                        <span className="mt-1 block text-xs leading-5 text-ink-soft">{meta.hint}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>

              {openNode ? (
                <NodeDetail node={nodes.find((n) => n.type === openNode) ?? null} type={openNode} />
              ) : null}

              {failedNode && run ? (
                <div className="mt-4 flex items-center justify-between rounded-md border border-clay/40 bg-clay/10 px-4 py-3">
                  <p className="text-sm text-clay">
                    {failedNode.type} failed{failedNode.error ? `: ${failedNode.error}` : "."}
                  </p>
                  <button
                    type="button"
                    disabled={asking}
                    onClick={() => void ask(`/api/ask/${run.id}/resume`)}
                    className="text-sm font-semibold text-sienna-deep underline-offset-2 hover:underline"
                  >
                    Resume from here
                  </button>
                </div>
              ) : null}
            </section>

            {askError ? (
              <p className="rounded-md border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
                {askError}
              </p>
            ) : null}

            {run?.status === "insufficient" ? (
              <section className="rounded-md border border-rule bg-white/60 px-5 py-5">
                <h2 className="font-serif text-2xl">Nothing relevant in your library</h2>
                <p className="mt-2 text-sm leading-6 text-ink-soft">
                  Retrieval stayed below the similarity floor. Closest documents are listed below —
                  the model did not invent an answer.
                </p>
              </section>
            ) : null}

            {answer || sources.length > 0 ? (
              <section className="grid gap-6 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                <div>
                  <div className="flex items-center justify-between">
                    <h2 className="font-serif text-2xl">Answer</h2>
                    {run && answer && !asking ? (
                      <button
                        type="button"
                        disabled={helpful}
                        onClick={async () => {
                          const res = await fetch("/api/feedback", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              runId: run.id,
                              question: run.question,
                              chunkIds: sources.map((s) => s.chunkId),
                            }),
                          });
                          if (res.ok) setHelpful(true);
                        }}
                        className="text-xs font-semibold uppercase tracking-wider text-sienna-deep disabled:text-moss"
                      >
                        {helpful ? "Remembered as helpful" : "This helped"}
                      </button>
                    ) : null}
                  </div>
                  <div className="mt-4">
                    {answer ? (
                      <AnswerBody
                        text={answer}
                        active={activeSource}
                        onCite={(n) => setActiveSource(n)}
                      />
                    ) : (
                      <p className="text-sm text-ink-soft">Waiting for Write…</p>
                    )}
                  </div>
                  {verifyOut ? (
                    <p className="mt-4 text-sm text-ink-soft">
                      Verify: <span className="font-medium text-ink">{verifyOut.verdict}</span>
                      {verifyOut.notes ? ` — ${verifyOut.notes}` : ""}
                    </p>
                  ) : null}
                </div>

                <aside className="rounded-md border border-rule bg-white/60 p-4">
                  <h3 className="text-[0.68rem] font-semibold uppercase tracking-[0.22em] text-ink-soft">
                    Sources
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-ink-soft">
                    Every answer is tied to these documents. Click a citation to highlight it.
                  </p>
                  <ul className="mt-4 space-y-3">
                    {displayedSources.map((source) => (
                      <li key={`${source.filename}-${source.n}`}>
                        <button
                          type="button"
                          onClick={() => setActiveSource(source.n)}
                          className={`w-full rounded-md border px-3 py-3 text-left ${
                            activeSource === source.n
                              ? "border-sienna bg-sienna/10"
                              : "border-transparent bg-paper-deep/60"
                          }`}
                        >
                          <span className="text-[0.7rem] font-semibold text-sienna-deep">
                            [{source.n}] {source.filename}
                            {source.page ? ` · p.${source.page}` : ""}
                          </span>
                          <span className="mt-1 block text-xs leading-5 text-ink-soft">
                            {source.snippet}
                          </span>
                          <span className="mt-1 block text-[0.65rem] uppercase tracking-wider text-ink-soft">
                            similarity {source.score.toFixed(2)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </aside>
              </section>
            ) : (
              <p className="font-serif text-xl leading-8 text-ink-soft">
                Upload a few documents, then ask. You will see retrieval, a plan for what to write,
                the answer, and the files it came from.
              </p>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function NodeDetail({ node, type }: { node: NodeRecord | null; type: NodeType }) {
  if (!node) {
    return (
      <div className="mt-3 rounded-md border border-rule bg-white/50 px-4 py-3 text-sm text-ink-soft">
        {type} has not started.
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-md border border-rule bg-white/70 px-4 py-4 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium capitalize">{node.type}</p>
        <p className="text-xs text-ink-soft">
          {node.model ? `model ${node.model}` : "local tool"}
          {node.status === "running" ? " · running" : ""}
        </p>
      </div>
      {node.error ? <p className="mt-2 text-clay">{node.error}</p> : null}
      <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[0.72rem] leading-5 text-ink-soft">
        {JSON.stringify(
          {
            input: node.input,
            output: summarizeOutput(node),
          },
          null,
          2,
        )}
      </pre>
    </div>
  );
}

function summarizeOutput(node: NodeRecord) {
  if (node.type === "retrieve") {
    const output = node.output as RetrieveOutput | null;
    if (!output) return node.output;
    return {
      empty: output.empty,
      results: output.results?.map((r) => ({
        chunkId: r.chunkId,
        filename: r.filename,
        score: r.score,
        snippet: r.snippet,
      })),
    };
  }
  if (node.type === "write") {
    const output = node.output as WriteOutput | null;
    if (!output) return node.output;
    return { sources: output.sources, answerPreview: output.answer?.slice(0, 280) };
  }
  return node.output;
}
