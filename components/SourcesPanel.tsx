"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, FileText, Quote } from "lucide-react";

import type { RetrievedPassage } from "@/lib/types";
import { Badge, ScoreBar, cx } from "./ui";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Wraps every retrieval-matched term so the user can see why a chunk came back. */
function Highlighted({ text, terms }: { text: string; terms: string[] }): ReactNode {
  const usable = terms.filter((term) => term.length > 2).map(escapeRegex);
  if (usable.length === 0) return text;

  // Splitting on a capturing group puts the matches at the odd indexes.
  const pattern = new RegExp(`(${usable.join("|")})`, "gi");
  return text.split(pattern).map((part, i) =>
    i % 2 === 1 ? (
      <mark
        key={`${part}-${i}`}
        className="rounded bg-accent-soft px-0.5 text-accent decoration-clone"
      >
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

export function SourcesPanel({
  passages,
  activeSource,
}: {
  passages: RetrievedPassage[];
  activeSource: number | null;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const refs = useRef(new Map<number, HTMLElement>());

  useEffect(() => {
    if (activeSource === null) return;
    const element = refs.current.get(activeSource);
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    element.classList.remove("animate-highlight");
    // Force the animation to restart when the same citation is clicked twice.
    void element.offsetWidth;
    element.classList.add("animate-highlight");
  }, [activeSource]);

  if (passages.length === 0) return null;

  return (
    <section className="panel p-4">
      <header className="mb-3 flex items-center gap-2">
        <Quote className="size-4 text-faint" />
        <h2 className="text-[13px] font-semibold">Sources</h2>
        <span className="font-mono text-[11px] text-faint">{passages.length} passages</span>
      </header>

      <div className="space-y-2">
        {passages.map((passage, i) => {
          const number = i + 1;
          const isOpen = open.has(passage.chunkId);
          return (
            <article
              key={passage.chunkId}
              ref={(element) => {
                if (element) refs.current.set(number, element);
              }}
              className={cx(
                "rounded-lg border px-3 py-2.5 transition-colors",
                activeSource === number
                  ? "border-accent-line bg-accent-soft/40"
                  : "border-line bg-surface-2",
              )}
            >
              <div className="flex items-start gap-2.5">
                <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded border border-accent-line bg-accent-soft font-mono text-[10px] font-semibold text-accent">
                  {number}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                    <FileText className="size-3 shrink-0 text-faint" />
                    <span className="truncate text-[12px] font-medium">{passage.filename}</span>
                    {passage.page ? (
                      <span className="font-mono text-[11px] text-faint">p.{passage.page}</span>
                    ) : null}
                    <span className="font-mono text-[11px] text-faint">#{passage.index}</span>
                    {passage.heading ? (
                      <span className="truncate text-[11px] text-muted">{passage.heading}</span>
                    ) : null}
                  </div>

                  <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
                    <Highlighted
                      text={isOpen ? passage.text : passage.snippet}
                      terms={passage.matchedTerms}
                    />
                  </p>

                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <ScoreBar value={passage.denseScore} label="vec" />
                    <ScoreBar value={passage.lexicalScore} label="bm25" tone="neutral" />
                    {passage.facetHits.map((facet) => (
                      <Badge key={facet} tone="ok" title="Plan facet satisfied by this passage">
                        {facet}
                      </Badge>
                    ))}
                  </div>

                  {passage.origins.length > 0 ? (
                    <p className="mt-1.5 text-[11px] text-faint">
                      found via{" "}
                      {passage.origins
                        .slice(0, 2)
                        .map((origin) => `${origin.kind === "dense" ? "vector" : "keyword"} "${origin.query.slice(0, 60)}" (#${origin.rank})`)
                        .join(", ")}
                    </p>
                  ) : null}

                  <button
                    type="button"
                    onClick={() =>
                      setOpen((current) => {
                        const next = new Set(current);
                        if (next.has(passage.chunkId)) next.delete(passage.chunkId);
                        else next.add(passage.chunkId);
                        return next;
                      })
                    }
                    className="mt-1.5 flex items-center gap-1 text-[11px] text-muted transition-colors hover:text-accent"
                  >
                    {isOpen ? (
                      <ChevronDown className="size-3" />
                    ) : (
                      <ChevronRight className="size-3" />
                    )}
                    {isOpen ? "Show less" : "Show full passage"}
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
