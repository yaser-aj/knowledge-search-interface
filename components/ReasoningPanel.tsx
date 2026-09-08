"use client";

import { useState, type ReactNode } from "react";
import {
  Braces,
  CheckCircle2,
  Circle,
  CircleAlert,
  CircleDashed,
  HelpCircle,
  Layers,
  ListChecks,
  RefreshCw,
  ShieldCheck,
  Telescope,
} from "lucide-react";

import type {
  ExpansionTerm,
  PlanFacet,
  StageName,
  Verdict,
} from "@/lib/types";
import { STAGE_ORDER, type RunState, type StageState } from "./useAskRun";
import { Badge, SectionLabel, Spinner, cx, formatMs } from "./ui";

const STAGE_LABEL: Record<StageName, string> = {
  prime: "Prime",
  plan: "Plan",
  retrieve: "Retrieve",
  write: "Write",
  verify: "Verify",
};

const STAGE_DESCRIPTION: Record<StageName, string> = {
  prime: "Reads the index and shortlists the terms it already contains",
  plan: "Decomposes the question and expands it into searchable terms",
  retrieve: "Runs vector and keyword search per facet, then fuses the rankings",
  write: "Drafts the answer using only the retrieved passages",
  verify: "Audits every claim against the passage it cites",
};

function StageIcon({ state }: { state: StageState }) {
  switch (state.status) {
    case "running":
      return <Spinner className="text-accent" />;
    case "done":
      return <CheckCircle2 className="size-3.5 text-ok" />;
    case "error":
      return <CircleAlert className="size-3.5 text-bad" />;
    case "skipped":
      return <CircleDashed className="size-3.5 text-faint" />;
    default:
      return <Circle className="size-3.5 text-faint" />;
  }
}

function Collapsible({
  title,
  icon,
  badge,
  defaultOpen = true,
  children,
}: {
  title: string;
  icon: ReactNode;
  badge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="panel overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
      >
        <span className="text-faint">{icon}</span>
        <span className="flex-1 text-[13px] font-semibold">{title}</span>
        {badge}
      </button>
      {open ? <div className="animate-fade-up border-t border-line px-3 py-3">{children}</div> : null}
    </section>
  );
}

/** Expansion chips carry their provenance in their styling. */
function ExpansionChip({ expansion }: { expansion: ExpansionTerm }) {
  const { term, origin, inCorpus, nearestCorpusTerm, similarity } = expansion;

  const title =
    origin === "index"
      ? `Contributed by the index itself (similarity ${similarity ?? "—"})`
      : inCorpus
        ? `Appears in the library${nearestCorpusTerm && nearestCorpusTerm !== term ? ` · nearest indexed term "${nearestCorpusTerm}"` : ""}`
        : `Not found in the library${nearestCorpusTerm ? ` · nearest indexed term "${nearestCorpusTerm}" (${similarity ?? "—"})` : ""}`;

  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-4",
        origin === "index"
          ? "border-ok/40 bg-ok-soft text-ok"
          : inCorpus
            ? "border-accent-line bg-accent-soft font-medium text-accent"
            : "border-line border-dashed bg-transparent text-faint",
      )}
    >
      {origin === "index" ? <span className="font-mono text-[9px]">idx</span> : null}
      {term}
    </span>
  );
}

function FacetBlock({ facet }: { facet: PlanFacet }) {
  const grounded = facet.expansions.filter((expansion) => expansion.inCorpus).length;
  const fromIndex = facet.expansions.filter((expansion) => expansion.origin === "index").length;

  return (
    <div className="rounded-lg border border-line bg-surface-2 px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[12px] font-semibold">{facet.label}</span>
        <Badge title="Expansion terms that occur in the library">
          {grounded}/{facet.expansions.length} in corpus
        </Badge>
        {fromIndex > 0 ? (
          <Badge tone="ok" title="Terms the index contributed on its own">
            +{fromIndex} from index
          </Badge>
        ) : null}
      </div>

      {facet.intent ? (
        <p className="mt-1 text-[11px] leading-relaxed text-muted">{facet.intent}</p>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-1">
        {facet.expansions.map((expansion) => (
          <ExpansionChip key={`${facet.label}-${expansion.term}`} expansion={expansion} />
        ))}
      </div>

      {facet.subQueries.length > 0 ? (
        <div className="mt-2">
          <SectionLabel>Sub-queries</SectionLabel>
          <ul className="mt-1 space-y-0.5">
            {facet.subQueries.map((subQuery) => (
              <li key={subQuery} className="text-[11px] text-muted italic">
                &ldquo;{subQuery}&rdquo;
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

const VERDICT_TONE: Record<Verdict, "ok" | "warn" | "bad"> = {
  supported: "ok",
  partial: "warn",
  unsupported: "bad",
};

export function ReasoningPanel({ run }: { run: RunState }) {
  const { plan, prime, stats, verification, usage } = run;

  return (
    <div className="flex flex-col gap-3">
      <section className="panel p-3">
        <div className="mb-2.5 flex items-center justify-between">
          <SectionLabel>Pipeline</SectionLabel>
          <div className="flex items-center gap-1.5">
            <Badge tone={usage.degraded ? "warn" : "neutral"} title="LangGraph nodes that called the model">
              {usage.llmCalls} LLM {usage.llmCalls === 1 ? "call" : "calls"}
            </Badge>
            {run.ms !== null ? <Badge>{formatMs(run.ms)}</Badge> : null}
          </div>
        </div>

        <ol className="space-y-1">
          {STAGE_ORDER.map((stage) => {
            const state = run.stages[stage];
            return (
              <li
                key={stage}
                className={cx(
                  "flex items-start gap-2 rounded-md px-1.5 py-1 transition-colors",
                  state.status === "running" && "bg-accent-soft",
                )}
              >
                <span className="mt-0.5">
                  <StageIcon state={state} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span
                      className={cx(
                        "text-[12px] font-medium",
                        state.status === "pending" && "text-faint",
                      )}
                    >
                      {STAGE_LABEL[stage]}
                    </span>
                    {state.ms !== undefined ? (
                      <span className="font-mono text-[10px] text-faint">
                        {formatMs(state.ms)}
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-[11px] leading-snug text-faint">
                    {state.status === "error" && state.detail
                      ? state.detail
                      : STAGE_DESCRIPTION[stage]}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>

        {usage.models.length > 0 ? (
          <p className="mt-2 border-t border-line pt-2 font-mono text-[10px] break-all text-faint">
            {usage.models.join(" → ")}
          </p>
        ) : null}
      </section>

      {run.refined ? (
        <div className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn-soft px-2.5 py-2">
          <RefreshCw className="mt-px size-3.5 shrink-0 text-warn" />
          <p className="text-[11px] leading-relaxed text-warn">{run.refined}</p>
        </div>
      ) : null}

      {prime ? (
        <Collapsible
          title="What the index knows"
          icon={<Telescope className="size-4" />}
          defaultOpen={false}
          badge={<Badge>{prime.vocabularyShortlist.length} terms</Badge>}
        >
          <p className="mb-2 text-[11px] leading-relaxed text-muted">
            Indexed terms closest to the question, handed to the planner so its expansions target
            words the documents actually use.
          </p>
          <div className="flex flex-wrap gap-1">
            {prime.vocabularyShortlist.length > 0 ? (
              prime.vocabularyShortlist.map((entry) => (
                <Badge
                  key={entry.term}
                  title={`similarity ${entry.similarity} · in ${entry.documents} document(s)`}
                >
                  {entry.term}
                </Badge>
              ))
            ) : (
              <span className="text-[11px] text-faint">
                Nothing in the index is close to this wording.
              </span>
            )}
          </div>
        </Collapsible>
      ) : null}

      {plan ? (
        <Collapsible
          title="Plan"
          icon={<Layers className="size-4" />}
          badge={
            <Badge tone={plan.source === "llm" ? "accent" : "warn"}>
              {plan.source === "llm" ? "model planner" : "corpus-only planner"}
            </Badge>
          }
        >
          <p className="text-[12px] leading-relaxed">{plan.interpretation}</p>

          <div className="mt-2 flex flex-wrap gap-1">
            <Badge title="What kind of thing the question is about">{plan.entityType}</Badge>
            <Badge title="Shape the answer should take">{plan.answerShape}</Badge>
          </div>

          <div className="mt-3 space-y-2">
            {plan.facets.map((facet) => (
              <FacetBlock key={facet.label} facet={facet} />
            ))}
          </div>

          {plan.mustCover.length > 0 ? (
            <div className="mt-3">
              <SectionLabel>A complete answer must state</SectionLabel>
              <ul className="mt-1 space-y-0.5">
                {plan.mustCover.map((item) => (
                  <li key={item} className="flex gap-1.5 text-[11px] text-muted">
                    <ListChecks className="mt-0.5 size-3 shrink-0 text-faint" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {plan.notes.length > 0 ? (
            <ul className="mt-3 space-y-1 border-t border-line pt-2">
              {plan.notes.map((note) => (
                <li key={note} className="text-[11px] text-warn">
                  {note}
                </li>
              ))}
            </ul>
          ) : null}
        </Collapsible>
      ) : null}

      {stats ? (
        <Collapsible
          title="Retrieval"
          icon={<Braces className="size-4" />}
          defaultOpen={false}
          badge={<Badge>pass {stats.pass}</Badge>}
        >
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
            {[
              ["vector queries", stats.denseQueries],
              ["keyword queries", stats.lexicalQueries],
              ["candidates fused", stats.candidates],
              ["passages kept", stats.returned],
            ].map(([label, value]) => (
              <div key={String(label)} className="flex items-baseline justify-between gap-2">
                <dt className="text-faint">{label}</dt>
                <dd className="font-mono font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-faint">
            Rankings are fused with reciprocal rank fusion, boosted when a passage satisfies more
            than one facet, then diversified so no single document dominates. Took{" "}
            {formatMs(stats.ms)}.
          </p>
        </Collapsible>
      ) : null}

      {verification ? (
        <Collapsible
          title="Verification"
          icon={<ShieldCheck className="size-4" />}
          badge={
            <Badge
              tone={
                verification.confidence === "high"
                  ? "ok"
                  : verification.confidence === "medium"
                    ? "warn"
                    : "bad"
              }
            >
              {verification.confidence} confidence
            </Badge>
          }
        >
          {verification.summary ? (
            <p className="mb-2.5 text-[12px] leading-relaxed">{verification.summary}</p>
          ) : null}

          <div className="space-y-1.5">
            {verification.claims.map((claim, i) => (
              <div
                key={`${claim.claim.slice(0, 40)}-${i}`}
                className="rounded-lg border border-line bg-surface-2 px-2.5 py-2"
              >
                <div className="flex items-start gap-2">
                  <Badge tone={VERDICT_TONE[claim.verdict]}>{claim.verdict}</Badge>
                  {claim.sources.length > 0 ? (
                    <span className="font-mono text-[10px] text-faint">
                      {claim.sources.map((number) => `S${number}`).join(" ")}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1.5 text-[11px] leading-relaxed">{claim.claim}</p>
                {claim.reason ? (
                  <p className="mt-1 text-[11px] text-faint">{claim.reason}</p>
                ) : null}
              </div>
            ))}
          </div>

          {verification.coverage.length > 0 ? (
            <div className="mt-3">
              <SectionLabel>Coverage</SectionLabel>
              <ul className="mt-1 space-y-1">
                {verification.coverage.map((item) => (
                  <li key={item.item} className="flex gap-1.5 text-[11px]">
                    {item.covered ? (
                      <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-ok" />
                    ) : (
                      <HelpCircle className="mt-0.5 size-3 shrink-0 text-warn" />
                    )}
                    <span className={item.covered ? "text-muted" : "text-warn"}>{item.item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <p className="mt-2.5 border-t border-line pt-2 text-[11px] text-faint">
            {verification.source === "llm"
              ? "Audited by the verifier model against the cited passages."
              : "Audited by term overlap against the cited passages (no model available)."}
          </p>
        </Collapsible>
      ) : null}
    </div>
  );
}
