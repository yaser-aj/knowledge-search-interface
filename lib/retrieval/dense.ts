import { cosine } from "../embeddings";
import { getCorpus } from "../store";

export interface DenseHit {
  chunk: number;
  score: number;
}

export function searchDense(
  vector: Float32Array,
  limit: number,
  minScore = 0.08,
): DenseHit[] {
  const chunks = getCorpus().chunks;
  const hits: DenseHit[] = [];

  for (let i = 0; i < chunks.length; i += 1) {
    const score = cosine(vector, chunks[i].vector);
    if (score >= minScore) hits.push({ chunk: i, score });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

export function scoreAgainst(vector: Float32Array, chunkIndex: number): number {
  const chunk = getCorpus().chunks[chunkIndex];
  return chunk ? cosine(vector, chunk.vector) : 0;
}
