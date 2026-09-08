"use client";

import type { ReactNode } from "react";

export function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(" ");
}

export type Tone = "neutral" | "accent" | "ok" | "warn" | "bad";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted border-line",
  accent: "bg-accent-soft text-accent border-accent-line",
  ok: "bg-ok-soft text-ok border-ok/30",
  warn: "bg-warn-soft text-warn border-warn/30",
  bad: "bg-bad-soft text-bad border-bad/30",
};

export function Badge({
  children,
  tone = "neutral",
  title,
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-4 font-medium",
        TONE_CLASS[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11px] font-semibold tracking-[0.08em] text-faint uppercase">
      {children}
    </div>
  );
}

/** Horizontal meter for a 0..1 score. */
export function ScoreBar({
  value,
  label,
  tone = "accent",
}: {
  value: number;
  label: string;
  tone?: "accent" | "neutral";
}) {
  const width = `${Math.max(2, Math.min(100, value * 100))}%`;
  return (
    <div className="flex items-center gap-1.5" title={`${label}: ${value.toFixed(3)}`}>
      <span className="w-8 shrink-0 font-mono text-[10px] text-faint">{label}</span>
      <span className="h-1 w-14 overflow-hidden rounded-full bg-surface-3">
        <span
          className={cx("block h-full rounded-full", tone === "accent" ? "bg-accent" : "bg-line-strong")}
          style={{ width }}
        />
      </span>
      <span className="w-8 shrink-0 font-mono text-[10px] text-faint">{value.toFixed(2)}</span>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Working"
      className={cx(
        "inline-block size-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent",
        className,
      )}
    />
  );
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      {icon ? <div className="text-faint">{icon}</div> : null}
      <p className="text-sm font-medium text-ink">{title}</p>
      {children ? <p className="max-w-sm text-[13px] text-muted">{children}</p> : null}
    </div>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMs(ms: number | undefined): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
