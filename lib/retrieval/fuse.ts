import type { PassageOrigin } from "../types";

/** Standard Reciprocal Rank Fusion constant; dampens the top of every list. */
const RRF_K = 60;

/** How much each additional satisfied facet multiplies a passage's fused score. */
const FACET_BOOST = 0.38;

/**
 * A hit only counts as satisfying a facet if it ranked near the top of that
 * facet's list. Without this, every chunk in a small corpus matches every facet
 * weakly and the boost stops discriminating.
 */
const FACET_RANK_CUTOFF = 8;

/**
 * Rank fusion alone ignores how strong a match was, which lets a passage that
 * placed mid-table in many lists outrank the one passage that is clearly the
 * best answer. Blend the rank signal with the absolute similarity scores.
 */
const RANK_WEIGHT = 0.55;
const DENSE_WEIGHT = 0.3;
const LEXICAL_WEIGHT = 0.15;

export interface RankedList {
  kind: "dense" | "lexical";
  query: string;
  facet: string;
  /** Chunk indexes, best first. */
  hits: { chunk: number; score: number; matched?: string[] }[];
}

export interface FusedCandidate {
  chunk: number;
  fused: number;
  /** Raw reciprocal-rank total, kept for the reasoning trace. */
  rrf: number;
  denseScore: number;
  lexicalScore: number;
  facets: Set<string>;
  matchedTerms: Set<string>;
  origins: PassageOrigin[];
}

/**
 * Fuses many ranked lists into one ordering. Passages that satisfy more than
 * one facet of the plan are boosted, which is what makes a conjunctive question
 * ("a business" AND "in the GCC") outrank a passage that only matches one side.
 */
export function fuse(lists: RankedList[]): FusedCandidate[] {
  const byChunk = new Map<number, FusedCandidate>();
  const maxLexical = Math.max(
    1e-6,
    ...lists
      .filter((list) => list.kind === "lexical")
      .flatMap((list) => list.hits.map((hit) => hit.score)),
  );

  for (const list of lists) {
    list.hits.forEach((hit, index) => {
      const rank = index + 1;
      let candidate = byChunk.get(hit.chunk);
      if (!candidate) {
        candidate = {
          chunk: hit.chunk,
          fused: 0,
          rrf: 0,
          denseScore: 0,
          lexicalScore: 0,
          facets: new Set(),
          matchedTerms: new Set(),
          origins: [],
        };
        byChunk.set(hit.chunk, candidate);
      }

      candidate.rrf += 1 / (RRF_K + rank);

      const matched = hit.matched ?? [];
      const nearTop = rank <= FACET_RANK_CUTOFF;
      const satisfiesFacet =
        list.kind === "lexical" ? nearTop && matched.length > 0 : nearTop;
      if (list.facet && satisfiesFacet) candidate.facets.add(list.facet);
      for (const term of matched) candidate.matchedTerms.add(term);

      candidate.origins.push({ kind: list.kind, query: list.query, facet: list.facet, rank });

      if (list.kind === "dense") {
        candidate.denseScore = Math.max(candidate.denseScore, hit.score);
      } else {
        candidate.lexicalScore = Math.max(candidate.lexicalScore, hit.score / maxLexical);
      }
    });
  }

  const fused = [...byChunk.values()];
  const maxRrf = Math.max(1e-9, ...fused.map((candidate) => candidate.rrf));

  for (const candidate of fused) {
    const base =
      RANK_WEIGHT * (candidate.rrf / maxRrf) +
      DENSE_WEIGHT * candidate.denseScore +
      LEXICAL_WEIGHT * candidate.lexicalScore;
    const extraFacets = Math.max(0, candidate.facets.size - 1);
    candidate.fused = base * (1 + FACET_BOOST * extraFacets);
  }

  fused.sort((a, b) => b.fused - a.fused);
  return fused;
}
