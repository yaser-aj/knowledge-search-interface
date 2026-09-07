export type DocumentStatus = "indexing" | "ready" | "error";

export type NodeType = "retrieve" | "plan" | "write" | "verify";
export type NodeStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type RunStatus = "running" | "completed" | "failed" | "insufficient";
export type VerifyVerdict = "supported" | "weak" | "insufficient";

export type DocumentRecord = {
  id: number;
  filename: string;
  storedName: string;
  size: number;
  mime: string;
  status: DocumentStatus;
  error: string | null;
  chunkCount: number;
  createdAt: number;
};

export type ChunkRecord = {
  id: number;
  documentId: number;
  filename: string;
  chunkIndex: number;
  page: number | null;
  text: string;
  embedding: Float32Array;
};

export type RetrievedPassage = {
  chunkId: number;
  documentId: number;
  filename: string;
  chunkIndex: number;
  page: number | null;
  text: string;
  snippet: string;
  score: number;
  boostedScore: number;
};

export type Source = {
  n: number;
  documentId: number;
  filename: string;
  chunkId: number;
  page: number | null;
  score: number;
  snippet: string;
};

export type PlanOutput = {
  selectedChunkIds: number[];
  insufficient: boolean;
  intent: string;
  responseOutline: {
    claims: string[];
    documentsToCite: string[];
    mustNotInclude: string[];
    gaps: string;
  };
  rationale: string;
  dropped: { chunkId: number; reason: string }[];
};

export type VerifyOutput = {
  verdict: VerifyVerdict;
  notes: string;
  flags: { claim: string; issue: "uncited" | "unsupported" | "off-outline" }[];
};

export type NodeRecord = {
  id: number;
  runId: number;
  type: NodeType;
  status: NodeStatus;
  input: unknown;
  output: unknown;
  error: string | null;
  model: string | null;
  startedAt: number | null;
  finishedAt: number | null;
};

export type RunRecord = {
  id: number;
  question: string;
  status: RunStatus;
  createdAt: number;
  helpful: number;
};

export type RetrieveOutput = {
  results: RetrievedPassage[];
  nearMisses: RetrievedPassage[];
  empty: boolean;
};

export type WriteOutput = {
  answer: string;
  sources: Source[];
};

export type PipelineEvent =
  | { type: "run"; run: RunRecord }
  | { type: "node"; node: NodeRecord }
  | { type: "write_delta"; text: string }
  | { type: "done"; run: RunRecord }
  | { type: "error"; message: string };
