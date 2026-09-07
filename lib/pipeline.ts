import {
  createRun,
  getRun,
  listNodes,
  nodeByType,
  updateNode,
  updateRun,
} from "./db";
import { chatJson, chatStream, parseJsonObject } from "./openrouter";
import { retrievePassages } from "./retrieve";
import type {
  NodeRecord,
  PipelineEvent,
  PlanOutput,
  RetrieveOutput,
  RetrievedPassage,
  Source,
  VerifyOutput,
  WriteOutput,
} from "./types";

type Send = (event: PipelineEvent) => void;

const NODE_ORDER = ["retrieve", "plan", "write", "verify"] as const;

function emitNode(send: Send, node: NodeRecord) {
  send({ type: "node", node });
}

function startNode(node: NodeRecord, input: unknown): NodeRecord {
  return updateNode(node.id, {
    status: "running",
    input,
    output: null,
    error: null,
    model: null,
    startedAt: Date.now(),
    finishedAt: null,
  });
}

function finishNode(
  node: NodeRecord,
  patch: Partial<Pick<NodeRecord, "status" | "output" | "error" | "model">>,
): NodeRecord {
  return updateNode(node.id, {
    ...patch,
    finishedAt: Date.now(),
  });
}

function skipNode(node: NodeRecord, reason: string): NodeRecord {
  return updateNode(node.id, {
    status: "skipped",
    output: { reason },
    finishedAt: Date.now(),
  });
}

function compactPassages(passages: RetrievedPassage[]) {
  return passages.map((p, i) => ({
    n: i + 1,
    chunkId: p.chunkId,
    documentId: p.documentId,
    filename: p.filename,
    page: p.page,
    score: Number(p.score.toFixed(3)),
    snippet: p.snippet,
    text: p.text,
  }));
}

function sourcesFrom(passages: RetrievedPassage[]): Source[] {
  return passages.map((p, i) => ({
    n: i + 1,
    documentId: p.documentId,
    filename: p.filename,
    chunkId: p.chunkId,
    page: p.page,
    score: Number(p.boostedScore.toFixed(3)),
    snippet: p.snippet,
  }));
}

function normalizePlan(raw: unknown, candidates: RetrievedPassage[]): PlanOutput {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const rawIds = Array.isArray(obj.selectedChunkIds) ? obj.selectedChunkIds : [];
  const allowed = new Set(candidates.map((c) => c.chunkId));
  const selectedChunkIds = rawIds
    .map((id) => Number(id))
    .filter((id) => allowed.has(id))
    .slice(0, 4);
  const outline = (obj.responseOutline ?? {}) as Record<string, unknown>;
  return {
    selectedChunkIds,
    insufficient: Boolean(obj.insufficient) || selectedChunkIds.length === 0,
    intent: String(obj.intent ?? ""),
    responseOutline: {
      claims: Array.isArray(outline.claims) ? outline.claims.map(String) : [],
      documentsToCite: Array.isArray(outline.documentsToCite)
        ? outline.documentsToCite.map(String)
        : [],
      mustNotInclude: Array.isArray(outline.mustNotInclude)
        ? outline.mustNotInclude.map(String)
        : [],
      gaps: String(outline.gaps ?? ""),
    },
    rationale: String(obj.rationale ?? ""),
    dropped: Array.isArray(obj.dropped)
      ? obj.dropped.map((item) => {
          const row = item as Record<string, unknown>;
          return { chunkId: Number(row.chunkId), reason: String(row.reason ?? "") };
        })
      : [],
  };
}

function normalizeVerify(raw: unknown): VerifyOutput {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const verdict = obj.verdict;
  return {
    verdict:
      verdict === "supported" || verdict === "weak" || verdict === "insufficient"
        ? verdict
        : "weak",
    notes: String(obj.notes ?? ""),
    flags: Array.isArray(obj.flags)
      ? obj.flags.map((item) => {
          const row = item as Record<string, unknown>;
          const issue = row.issue;
          return {
            claim: String(row.claim ?? ""),
            issue:
              issue === "uncited" || issue === "unsupported" || issue === "off-outline"
                ? issue
                : "unsupported",
          };
        })
      : [],
  };
}

async function runRetrieve(runId: number, question: string, send: Send): Promise<RetrieveOutput> {
  const node = nodeByType(runId, "retrieve");
  emitNode(send, startNode(node, { question }));
  try {
    const { results, nearMisses } = await retrievePassages(question);
    const output: RetrieveOutput = {
      results,
      nearMisses,
      empty: results.length === 0,
    };
    emitNode(send, finishNode(node, { status: "done", output }));
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Retrieval failed";
    emitNode(send, finishNode(node, { status: "failed", error: message }));
    throw error;
  }
}

async function runPlan(
  runId: number,
  question: string,
  retrieve: RetrieveOutput,
  send: Send,
): Promise<PlanOutput> {
  const node = nodeByType(runId, "plan");
  const candidates = compactPassages(retrieve.results);
  emitNode(send, startNode(node, { question, candidates }));

  const { text, model } = await chatJson({
    json: true,
    messages: [
      {
        role: "system",
        content: `You are the Plan node of a knowledge-search system.
You receive the user's question and ranked retrieval results from their document library.
You do two jobs:
1) Decide what to pick from the results — which passages actually bear on the question, which are near-misses, and why. Select at most 4 chunk ids from the provided list. Never invent ids.
2) Decide what to write, given what was asked — restate intent, list the claims the answer must make (or a refusal), which documents those claims should rest on, and what the answer must not include.

If none of the passages suffice, set insufficient=true and selectedChunkIds=[].
Return JSON only with this shape:
{
  "selectedChunkIds": number[],
  "insufficient": boolean,
  "intent": string,
  "responseOutline": {
    "claims": string[],
    "documentsToCite": string[],
    "mustNotInclude": string[],
    "gaps": string
  },
  "rationale": string,
  "dropped": [{"chunkId": number, "reason": string}]
}`,
      },
      {
        role: "user",
        content: JSON.stringify({ question, results: candidates }),
      },
    ],
  });

  const plan = normalizePlan(parseJsonObject(text), retrieve.results);
  emitNode(send, finishNode(node, { status: "done", output: plan, model }));
  return plan;
}

async function runWrite(
  runId: number,
  question: string,
  retrieve: RetrieveOutput,
  plan: PlanOutput,
  send: Send,
): Promise<WriteOutput> {
  const node = nodeByType(runId, "write");
  const selected = retrieve.results.filter((r) => plan.selectedChunkIds.includes(r.chunkId));
  const ordered =
    selected.length > 0
      ? plan.selectedChunkIds
          .map((id) => selected.find((s) => s.chunkId === id))
          .filter((s): s is RetrievedPassage => Boolean(s))
      : plan.insufficient
        ? retrieve.results
        : [];
  const passages = compactPassages(ordered);
  const sources = sourcesFrom(ordered);

  emitNode(send, startNode(node, { question, plan, passages }));

  const { text, model } = await chatStream(
    {
      messages: [
        {
          role: "system",
          content: `You write the user-facing answer for a knowledge-search system.
Follow the Plan outline exactly. Use ONLY the provided passages.
Every factual claim MUST include an inline citation like [1] that matches a passage number.
Uncited claims are not allowed. Do not use prior knowledge.
If the plan says insufficient, refuse to invent an answer. Still name the documents you checked.
Write markdown. Do not wrap the whole answer in a code fence.`,
        },
        {
          role: "user",
          content: JSON.stringify({ question, plan, passages }),
        },
      ],
    },
    (delta) => send({ type: "write_delta", text: delta }),
  );

  const output: WriteOutput = { answer: text.trim(), sources };
  emitNode(send, finishNode(node, { status: "done", output, model }));
  return output;
}

function citationNumbers(answer: string): number[] {
  const found = new Set<number>();
  for (const match of answer.matchAll(/\[(\d+)\]/g)) {
    found.add(Number(match[1]));
  }
  return [...found];
}

async function runVerify(
  runId: number,
  question: string,
  plan: PlanOutput,
  write: WriteOutput,
  send: Send,
): Promise<VerifyOutput> {
  const node = nodeByType(runId, "verify");
  const cited = citationNumbers(write.answer);
  const validNs = new Set(write.sources.map((s) => s.n));
  const unknownCitations = cited.filter((n) => !validNs.has(n));

  emitNode(
    send,
    startNode(node, {
      question,
      plan,
      answer: write.answer,
      sources: write.sources,
      cited,
    }),
  );

  const { text, model } = await chatJson({
    json: true,
    messages: [
      {
        role: "system",
        content: `You verify an answer against selected passages and the Plan outline.
Flag claims that are uncited, unsupported by the passages, or off the plan outline.
verdict must be one of: supported, weak, insufficient.
Return JSON only:
{
  "verdict": "supported" | "weak" | "insufficient",
  "notes": string,
  "flags": [{"claim": string, "issue": "uncited" | "unsupported" | "off-outline"}]
}`,
      },
      {
        role: "user",
        content: JSON.stringify({
          question,
          plan,
          answer: write.answer,
          sources: write.sources,
          unknownCitations,
        }),
      },
    ],
  });

  const verify = normalizeVerify(parseJsonObject(text));
  if (unknownCitations.length > 0 && !verify.flags.some((f) => f.issue === "uncited")) {
    verify.flags.push({
      claim: `Citations ${unknownCitations.map((n) => `[${n}]`).join(", ")} do not match retrieved documents`,
      issue: "uncited",
    });
    if (verify.verdict === "supported") verify.verdict = "weak";
  }
  emitNode(send, finishNode(node, { status: "done", output: verify, model }));
  return verify;
}

async function continueFrom(
  runId: number,
  question: string,
  startType: (typeof NODE_ORDER)[number],
  send: Send,
  prior?: { retrieve?: RetrieveOutput; plan?: PlanOutput; write?: WriteOutput },
) {
  let retrieve = prior?.retrieve;
  let plan = prior?.plan;
  let write = prior?.write;
  const startIndex = NODE_ORDER.indexOf(startType);

  try {
    if (startIndex <= 0) {
      retrieve = await runRetrieve(runId, question, send);
    } else {
      retrieve = retrieve ?? (nodeByType(runId, "retrieve").output as RetrieveOutput);
    }

    if (!retrieve || retrieve.empty) {
      for (const type of ["plan", "write", "verify"] as const) {
        const node = nodeByType(runId, type);
        if (node.status !== "done") {
          emitNode(send, skipNode(node, "Nothing relevant above the similarity floor."));
        }
      }
      const run = updateRun(runId, { status: "insufficient" });
      send({ type: "done", run });
      return;
    }

    if (startIndex <= 1) {
      plan = await runPlan(runId, question, retrieve, send);
    } else {
      plan = plan ?? (nodeByType(runId, "plan").output as PlanOutput);
    }

    if (startIndex <= 2) {
      write = await runWrite(runId, question, retrieve, plan!, send);
    } else {
      write = write ?? (nodeByType(runId, "write").output as WriteOutput);
    }

    if (startIndex <= 3) {
      await runVerify(runId, question, plan!, write!, send);
    }

    const run = updateRun(runId, { status: "completed" });
    send({ type: "done", run });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Run failed";
    const running = listNodes(runId).find((n) => n.status === "running");
    if (running) {
      emitNode(send, finishNode(running, { status: "failed", error: message }));
    }
    const run = updateRun(runId, { status: "failed" });
    send({ type: "error", message });
    send({ type: "done", run });
  }
}

export async function startAsk(question: string, send: Send) {
  const { run } = createRun(question);
  send({ type: "run", run });
  for (const node of listNodes(run.id)) emitNode(send, node);
  await continueFrom(run.id, question, "retrieve", send);
}

export async function resumeAsk(runId: number, send: Send) {
  const run = getRun(runId);
  if (!run) throw new Error("Run not found");
  send({ type: "run", run });
  const nodes = listNodes(runId);
  for (const node of nodes) emitNode(send, node);

  const failed = nodes.find((n) => n.status === "failed");
  const pending = nodes.find((n) => n.status === "pending" || n.status === "running");
  const start = failed ?? pending;
  if (!start) {
    send({ type: "done", run: updateRun(runId, { status: run.status === "running" ? "completed" : run.status }) });
    return;
  }

  updateRun(runId, { status: "running" });
  await continueFrom(runId, run.question, start.type, send);
}
