import { corpusVersion, getCorpus, type LoadedChunk } from "../store";
import { normalizeKey, tokenize } from "../text";

const K1 = 1.4;
const B = 0.75;
const PHRASE_BONUS = 2.2;

interface Posting {
  chunk: number;
  tf: number;
}

export interface LexicalIndex {
  chunks: LoadedChunk[];
  postings: Map<string, Posting[]>;
  lengths: Float64Array;
  averageLength: number;
  /** Normalised exact text of each chunk, used for phrase containment checks. */
  normalized: string[];
  version: number;
}

interface IndexCache {
  index: LexicalIndex | null;
}

const globalCache = globalThis as unknown as { __ksiLexical?: IndexCache };
const cache: IndexCache = (globalCache.__ksiLexical ??= { index: null });

export function getLexicalIndex(): LexicalIndex {
  const version = corpusVersion();
  if (cache.index && cache.index.version === version) return cache.index;

  const chunks = getCorpus().chunks;
  const postings = new Map<string, Posting[]>();
  const lengths = new Float64Array(chunks.length);
  const normalized: string[] = new Array(chunks.length);
  let total = 0;

  chunks.forEach((chunk, i) => {
    lengths[i] = chunk.length;
    total += chunk.length;
    normalized[i] = normalizeKey(chunk.heading ? `${chunk.heading} ${chunk.text}` : chunk.text);
    for (const [token, tf] of chunk.tokenCounts) {
      const list = postings.get(token);
      if (list) list.push({ chunk: i, tf });
      else postings.set(token, [{ chunk: i, tf }]);
    }
  });

  cache.index = {
    chunks,
    postings,
    lengths,
    averageLength: chunks.length > 0 ? total / chunks.length : 0,
    normalized,
    version,
  };
  return cache.index;
}

export function tokenExists(token: string, index = getLexicalIndex()): boolean {
  return index.postings.has(token);
}

/**
 * A phrase counts as present when it appears verbatim, or when every one of its
 * words appears somewhere in the corpus.
 */
export function phraseExists(
  phrase: string,
  index = getLexicalIndex(),
): { present: boolean; verbatim: boolean } {
  const words = tokenize(phrase);
  if (words.length === 0) return { present: false, verbatim: false };

  const key = normalizeKey(phrase);
  const verbatim =
    words.length > 1 ? index.normalized.some((text) => text.includes(key)) : tokenExists(words[0], index);
  if (verbatim) return { present: true, verbatim: true };

  return { present: words.every((word) => tokenExists(word, index)), verbatim: false };
}

export interface LexicalHit {
  chunk: number;
  score: number;
  matched: string[];
}

/**
 * BM25 over the query's tokens, plus a bonus for chunks containing any of the
 * supplied multi-word phrases verbatim.
 */
export function searchLexical(
  query: string,
  phrases: string[],
  limit: number,
  index = getLexicalIndex(),
): LexicalHit[] {
  if (index.chunks.length === 0) return [];

  const queryTokens = [...new Set(tokenize(query))];
  const scores = new Map<number, number>();
  const matched = new Map<number, Set<string>>();
  const total = index.chunks.length;

  const note = (chunk: number, term: string) => {
    const set = matched.get(chunk);
    if (set) set.add(term);
    else matched.set(chunk, new Set([term]));
  };

  for (const token of queryTokens) {
    const postings = index.postings.get(token);
    if (!postings) continue;
    const idf = Math.log(1 + (total - postings.length + 0.5) / (postings.length + 0.5));

    for (const { chunk, tf } of postings) {
      const norm = 1 - B + (B * index.lengths[chunk]) / (index.averageLength || 1);
      const contribution = (idf * (tf * (K1 + 1))) / (tf + K1 * norm);
      scores.set(chunk, (scores.get(chunk) ?? 0) + contribution);
      note(chunk, token);
    }
  }

  for (const phrase of phrases) {
    const key = normalizeKey(phrase);
    if (!key || !key.includes(" ")) continue;
    index.normalized.forEach((text, chunk) => {
      if (!text.includes(key)) return;
      scores.set(chunk, (scores.get(chunk) ?? 0) + PHRASE_BONUS);
      note(chunk, phrase);
    });
  }

  return [...scores.entries()]
    .map(([chunk, score]) => ({
      chunk,
      score,
      matched: [...(matched.get(chunk) ?? [])],
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
