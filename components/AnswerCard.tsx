"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Check, Copy, Sparkles } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { RetrievedPassage } from "@/lib/types";
import { Badge, Spinner, cx } from "./ui";

/**
 * Citations arrive as `[S3]`. Turning them into inline code lets the markdown
 * renderer hand them back as discrete nodes we can render as buttons, without
 * needing a raw-HTML pipeline.
 */
function markCitations(answer: string): string {
  return answer.replace(/\[\s*S(\d+)\s*\]/g, (_match, number) => `\`S${number}\``);
}

export function AnswerCard({
  answer,
  streaming,
  passages,
  degraded,
  onCite,
}: {
  answer: string;
  streaming: boolean;
  passages: RetrievedPassage[];
  degraded: boolean;
  onCite: (index: number) => void;
}) {
  const [copied, setCopied] = useState(false);
  const source = useMemo(() => markCitations(answer), [answer]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(answer);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard permission denied; nothing useful to show.
    }
  };

  return (
    <section className="panel p-4">
      <header className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-accent" />
          <h2 className="text-[13px] font-semibold">Answer</h2>
          {streaming ? (
            <span className="flex items-center gap-1.5 text-[11px] text-accent">
              <Spinner />
              writing
            </span>
          ) : null}
          {degraded && !streaming ? (
            <Badge tone="warn" title="Part of the pipeline ran without the language model.">
              degraded mode
            </Badge>
          ) : null}
        </div>
        {answer && !streaming ? (
          <button
            type="button"
            onClick={copy}
            className="flex items-center gap-1 rounded-md border border-line px-1.5 py-1 text-[11px] text-muted transition-colors hover:border-line-strong hover:text-ink"
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
        ) : null}
      </header>

      <div className="answer-prose">
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            code({ children, className }) {
              const text = String(children);
              const citation = /^S(\d+)$/.exec(text);
              if (citation && !className) {
                const number = Number(citation[1]);
                const passage = passages[number - 1];
                return (
                  <button
                    type="button"
                    onClick={() => onCite(number)}
                    title={
                      passage
                        ? `${passage.filename}${passage.page ? ` · p.${passage.page}` : ""}`
                        : "Source not in this result set"
                    }
                    className={cx(
                      "mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded border px-1 align-[1px] font-mono text-[10px] font-semibold transition-colors",
                      passage
                        ? "border-accent-line bg-accent-soft text-accent hover:bg-accent hover:text-white"
                        : "border-bad/30 bg-bad-soft text-bad",
                    )}
                  >
                    {number}
                  </button>
                );
              }
              return (
                <code className="rounded bg-surface-3 px-1 py-0.5 font-mono text-[12px]">
                  {children as ReactNode}
                </code>
              );
            },
            a({ children, href }) {
              return (
                <a href={href} className="text-accent underline underline-offset-2">
                  {children}
                </a>
              );
            },
          }}
        >
          {source}
        </Markdown>
        {streaming ? (
          <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-accent align-text-bottom" />
        ) : null}
      </div>
    </section>
  );
}
