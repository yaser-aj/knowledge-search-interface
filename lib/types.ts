export type DocumentStatus = "processing" | "ready" | "failed";

export interface DocumentProfile {
  /** Opening sentences, used to orient the planner about what the file covers. */
  lede: string;
  /** Most salient entities/keywords in this document. */
  topTerms: string[];
}

export interface DocumentRecord {
  id: string;
  filename: string;
  extension: string;
  bytes: number;
  pages: number | null;
  chunkCount: number;
  wordCount: number;
  status: DocumentStatus;
  error: string | null;
  createdAt: string;
  profile: DocumentProfile;
}

export interface Chunk {
  id: string;
  documentId: string;
  index: number;
  page: number | null;
  heading: string | null;
  text: string;
}

export type VocabKind = "entity" | "keyword";

export interface VocabTerm {
  /** Lowercased lookup key. */
  key: string;
  /** Best-looking surface form seen in the corpus. */
  term: string;
  kind: VocabKind;
  /** Number of documents containing the term. */
  documentFrequency: number;
  /** Total occurrences across the corpus. */
  occurrences: number;
  documentIds: string[];
  chunkIds: string[];
}

export interface CorpusStats {
  documents: number;
  chunks: number;
  words: number;
  vocabTerms: number;
}

/* ---------------------------------------------------------------- planning */

export type EntityType =
  | "organization"
  | "person"
  | "place"
  | "event"
  | "concept"
  | "mixed";

export type AnswerShape = "short_fact" | "list" | "explanation" | "comparison";

export type ExpansionOrigin = "question" | "model" | "index";

export interface ExpansionTerm {
  term: string;
  origin: ExpansionOrigin;
  /** True when the term (or a very close variant) actually occurs in the corpus. */
  inCorpus: boolean;
  nearestCorpusTerm: string | null;
  similarity: number | null;
}

export interface PlanFacet {
  label: string;
  intent: string;
  expansions: ExpansionTerm[];
  subQueries: string[];
}

export interface QueryPlan {
  interpretation: string;
  entityType: EntityType;
  answerShape: AnswerShape;
  facets: PlanFacet[];
  mustCover: string[];
  /** "llm" when the planner model answered, "fallback" when it was unavailable. */
  source: "llm" | "fallback";
  notes: string[];
}

/* --------------------------------------------------------------- retrieval */

export interface PassageOrigin {
  kind: "dense" | "lexical";
  query: string;
  facet: string;
  rank: number;
}

export interface RetrievedPassage {
  chunkId: string;
  documentId: string;
  filename: string;
  index: number;
  page: number | null;
  heading: string | null;
  text: string;
  snippet: string;
  denseScore: number;
  lexicalScore: number;
  fusedScore: number;
  /** Labels of the plan facets this passage satisfies. */
  facetHits: string[];
  matchedTerms: string[];
  origins: PassageOrigin[];
}

export interface RetrievalStats {
  pass: number;
  candidates: number;
  denseQueries: number;
  lexicalQueries: number;
  returned: number;
  ms: number;
}

/* ------------------------------------------------------------ verification */

export type Verdict = "supported" | "partial" | "unsupported";

export interface ClaimCheck {
  claim: string;
  verdict: Verdict;
  /** 1-based source numbers as cited in the answer. */
  sources: number[];
  reason: string;
}

export interface CoverageCheck {
  item: string;
  covered: boolean;
}

export interface Verification {
  claims: ClaimCheck[];
  coverage: CoverageCheck[];
  confidence: "high" | "medium" | "low";
  retrievalGaps: string[];
  summary: string;
  source: "llm" | "heuristic";
}

/* ------------------------------------------------------------------ stream */

export type StageName = "prime" | "plan" | "retrieve" | "write" | "verify";
export type StageStatus = "running" | "done" | "error" | "skipped";

export interface PrimeSummary {
  corpus: CorpusStats;
  /** Corpus vocabulary nearest the raw question, shown as "what the index knows". */
  vocabularyShortlist: { term: string; similarity: number; documents: number }[];
}

export type AskEvent =
  | { type: "stage"; stage: StageName; status: StageStatus; ms?: number; detail?: string }
  | { type: "prime"; prime: PrimeSummary }
  | { type: "plan"; plan: QueryPlan }
  | { type: "retrieval"; passages: RetrievedPassage[]; stats: RetrievalStats }
  | { type: "token"; text: string }
  | { type: "answer"; text: string }
  | { type: "verification"; verification: Verification }
  | { type: "usage"; llmCalls: number; models: string[]; degraded: boolean }
  | { type: "done"; ms: number }
  | { type: "error"; message: string };
