import { cosine } from "../embeddings";
import { getCorpus } from "../store";
import type { FusedCandidate } from "./fuse";

export interface MmrOptions {
  limit: number;
  /** 1 = pure relevance, 0 = pure diversity. */
  lambda?: number;
  maxPerDocument?: number;
}

/**
 * Maximal Marginal Relevance over the fused candidates, with a per-document cap
 * so one verbose file cannot fill the whole evidence set.
 */
export function selectDiverse(
  candidates: FusedCandidate[],
  { limit, lambda = 0.72, maxPerDocument = 3 }: MmrOptions,
): FusedCandidate[] {
  const chunks = getCorpus().chunks;
  if (candidates.length === 0) return [];

  const pool = candidates.slice(0, Math.max(limit * 5, 40));
  const maxFused = Math.max(1e-9, ...pool.map((candidate) => candidate.fused));
  const selected: FusedCandidate[] = [];
  const perDocument = new Map<string, number>();
  const taken = new Set<number>();

  while (selected.length < limit) {
    let best: FusedCandidate | null = null;
    let bestScore = -Infinity;

    for (const candidate of pool) {
      if (taken.has(candidate.chunk)) continue;
      const documentId = chunks[candidate.chunk]?.documentId;
      if (!documentId) continue;
      if ((perDocument.get(documentId) ?? 0) >= maxPerDocument) continue;

      let redundancy = 0;
      for (const chosen of selected) {
        redundancy = Math.max(
          redundancy,
          cosine(chunks[candidate.chunk].vector, chunks[chosen.chunk].vector),
        );
      }

      const score = lambda * (candidate.fused / maxFused) - (1 - lambda) * redundancy;
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    if (!best) break;
    taken.add(best.chunk);
    const documentId = chunks[best.chunk].documentId;
    perDocument.set(documentId, (perDocument.get(documentId) ?? 0) + 1);
    selected.push(best);
  }

  return selected;
}
