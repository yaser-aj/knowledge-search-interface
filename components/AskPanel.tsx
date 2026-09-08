"use client";

import { useState } from "react";
import { CornerDownLeft, Search, Square } from "lucide-react";

import { cx } from "./ui";

const EXAMPLES = [
  "Which business is headquartered somewhere in the GCC?",
  "Who can approve a payment of 3 million?",
  "What was decided about the office relocation?",
  "What are the cold chain temperature rules?",
];

export function AskPanel({
  disabled,
  running,
  onAsk,
  onCancel,
}: {
  disabled: boolean;
  running: boolean;
  onAsk: (question: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");

  const submit = () => {
    const question = value.trim();
    if (question.length < 3 || disabled || running) return;
    onAsk(question);
  };

  return (
    <div className="panel p-3">
      <div className="flex items-end gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-3 left-3 size-4 text-faint" />
          <textarea
            value={value}
            rows={1}
            disabled={disabled}
            placeholder={
              disabled
                ? "Upload a document to start asking"
                : "Ask anything about your documents..."
            }
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            className="scrollbar-slim max-h-40 min-h-11 w-full resize-y rounded-lg border border-line bg-surface-2 py-2.5 pr-3 pl-9 text-sm placeholder:text-faint focus:border-accent-line focus:bg-surface disabled:opacity-60"
          />
        </div>

        {running ? (
          <button
            type="button"
            onClick={onCancel}
            className="flex h-11 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-3.5 text-sm font-medium transition-colors hover:border-line-strong"
          >
            <Square className="size-3.5" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={disabled || value.trim().length < 3}
            className={cx(
              "flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-4 text-sm font-medium text-white transition-colors",
              "bg-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40",
            )}
          >
            Ask
            <CornerDownLeft className="size-3.5" />
          </button>
        )}
      </div>

      {!running ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-faint">Try:</span>
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              disabled={disabled}
              onClick={() => {
                setValue(example);
                onAsk(example);
              }}
              className="rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-accent-line hover:bg-accent-soft hover:text-accent disabled:opacity-40"
            >
              {example}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
