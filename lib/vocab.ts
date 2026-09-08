import { cosine, embedAll } from "./embeddings";
import type { LoadedChunk, LoadedVocabTerm } from "./store";
import { isStopword, normalizeKey, tokenize } from "./text";
import type { DocumentProfile, VocabKind } from "./types";

const MAX_TERMS = 900;
const MIN_KEYWORD_OCCURRENCES = 2;
const MAX_ENTITY_WORDS = 4;

interface Candidate {
  key: string;
  surfaces: Map<string, number>;
  kind: VocabKind;
  occurrences: number;
  documentIds: Set<string>;
  chunkIds: Set<string>;
}

/**
 * Capitalised runs, optionally joined by lowercase connectors ("Bank of Kuwait",
 * "Al Faisal Holding"), plus standalone acronyms.
 */
const ENTITY_PATTERN =
  /\b(?:[\p{Lu}][\p{L}\p{N}'’&.-]*)(?:[ ](?:of|the|for|and|al|el|bin|van|von|de|da)?[ ]?(?:[\p{Lu}][\p{L}\p{N}'’&.-]*)){0,3}\b/gu;

const CONNECTORS = new Set([
  "of", "the", "for", "and", "al", "el", "bin", "van", "von", "de", "da",
]);

function addCandidate(
  map: Map<string, Candidate>,
  surface: string,
  kind: VocabKind,
  chunk: LoadedChunk,
): void {
  const key = normalizeKey(surface);
  if (!key || key.length < 2) return;

  const existing = map.get(key);
  const candidate: Candidate =
    existing ??
    {
      key,
      surfaces: new Map(),
      kind,
      occurrences: 0,
      documentIds: new Set(),
      chunkIds: new Set(),
    };

  // Entities are more useful for planning than the same string seen as a keyword.
  if (kind === "entity") candidate.kind = "entity";
  candidate.occurrences += 1;
  candidate.surfaces.set(surface, (candidate.surfaces.get(surface) ?? 0) + 1);
  candidate.documentIds.add(chunk.documentId);
  candidate.chunkIds.add(chunk.id);
  map.set(key, candidate);
}

function trimEntity(raw: string): string | null {
  let phrase = raw.trim().replace(/[.,;:]+$/, "");
  const words = phrase.split(/\s+/);
  while (words.length > 0 && CONNECTORS.has(words[words.length - 1].toLowerCase())) {
    words.pop();
  }
  while (words.length > 0 && CONNECTORS.has(words[0].toLowerCase())) {
    words.shift();
  }
  if (words.length === 0 || words.length > MAX_ENTITY_WORDS) return null;
  phrase = words.join(" ");

  // A lone capitalised stopword is just a sentence opener.
  if (words.length === 1) {
    const lower = words[0].toLowerCase();
    if (isStopword(lower) || lower.length < 3) return null;
    if (!/[\p{Lu}]/u.test(words[0])) return null;
  }
  return phrase;
}

function collectCandidates(chunks: LoadedChunk[]): Map<string, Candidate> {
  const map = new Map<string, Candidate>();

  for (const chunk of chunks) {
    // Match per sentence, otherwise a capitalised word after a full stop gets
    // glued onto the previous phrase ("Doha. All treasury").
    for (const sentence of chunk.text.split(/(?<=[.!?])\s+|\n+/)) {
      const opening = sentence.replace(/^[^\p{L}\p{N}]+/u, "");
      for (const match of sentence.matchAll(ENTITY_PATTERN)) {
        const phrase = trimEntity(match[0]);
        if (!phrase) continue;
        // A single capitalised word that only ever opens a sentence is just
        // ordinary prose ("Speed within the building..."), not a name.
        const sentenceInitial = opening.startsWith(match[0]);
        if (sentenceInitial && !phrase.includes(" ") && !/^[\p{Lu}]{2,}$/u.test(phrase)) {
          continue;
        }
        addCandidate(map, phrase, "entity", chunk);
      }
    }
    if (chunk.heading) {
      for (const match of chunk.heading.matchAll(ENTITY_PATTERN)) {
        const phrase = trimEntity(match[0]);
        if (phrase) addCandidate(map, phrase, "entity", chunk);
      }
    }

    const tokens = chunk.tokens;
    for (let i = 0; i < tokens.length; i += 1) {
      if (tokens[i].length >= 4) addCandidate(map, tokens[i], "keyword", chunk);
      if (i + 1 < tokens.length) {
        addCandidate(map, `${tokens[i]} ${tokens[i + 1]}`, "keyword", chunk);
      }
    }
  }

  return map;
}

function bestSurface(candidate: Candidate): string {
  let best = candidate.key;
  let bestCount = -1;
  for (const [surface, count] of candidate.surfaces) {
    if (count > bestCount || (count === bestCount && surface.length < best.length)) {
      best = surface;
      bestCount = count;
    }
  }
  return best;
}

/** Frequency times inverse document frequency, with entities favoured. */
function salience(candidate: Candidate, documentCount: number): number {
  const df = candidate.documentIds.size;
  const idf = Math.log(1 + documentCount / Math.max(1, df));
  const kindWeight = candidate.kind === "entity" ? 1.6 : 1;
  const lengthBonus = candidate.key.includes(" ") ? 1.15 : 1;
  return Math.log1p(candidate.occurrences) * (0.4 + idf) * kindWeight * lengthBonus;
}

/**
 * Rebuilds the corpus vocabulary. Vectors for terms that already existed are
 * reused so an upload only pays to embed genuinely new terms.
 */
export async function buildVocabulary(
  chunks: LoadedChunk[],
  documentCount: number,
  existing: LoadedVocabTerm[],
): Promise<LoadedVocabTerm[]> {
  if (chunks.length === 0) return [];

  const candidates = collectCandidates(chunks);
  const ranked = [...candidates.values()]
    .filter(
      (candidate) =>
        candidate.kind === "entity" ||
        candidate.occurrences >= MIN_KEYWORD_OCCURRENCES,
    )
    .sort((a, b) => salience(b, documentCount) - salience(a, documentCount))
    .slice(0, MAX_TERMS);

  const reusable = new Map(existing.map((term) => [term.key, term.vector]));
  const needEmbedding = ranked.filter((candidate) => !reusable.has(candidate.key));
  const freshVectors = await embedAll(needEmbedding.map((c) => bestSurface(c)));
  needEmbedding.forEach((candidate, i) => {
    const vector = freshVectors[i];
    if (vector) reusable.set(candidate.key, vector);
  });

  const out: LoadedVocabTerm[] = [];
  for (const candidate of ranked) {
    const vector = reusable.get(candidate.key);
    if (!vector) continue;
    out.push({
      key: candidate.key,
      term: bestSurface(candidate),
      kind: candidate.kind,
      documentFrequency: candidate.documentIds.size,
      occurrences: candidate.occurrences,
      documentIds: [...candidate.documentIds],
      chunkIds: [...candidate.chunkIds].slice(0, 40),
      vector,
    });
  }
  return out;
}

/** Salient terms and opening text for a single document, shown to the planner. */
export function documentProfile(chunks: LoadedChunk[], limit = 12): DocumentProfile {
  const candidates = collectCandidates(chunks);
  const topTerms = [...candidates.values()]
    .filter((candidate) => candidate.kind === "entity" || candidate.occurrences >= 2)
    .sort((a, b) => salience(b, 1) - salience(a, 1))
    .slice(0, limit)
    .map(bestSurface);

  const lede = chunks[0]?.text.replace(/\s+/g, " ").slice(0, 240).trim() ?? "";
  return { lede, topTerms };
}

export interface VocabMatch {
  term: LoadedVocabTerm;
  similarity: number;
}

export function nearestVocabTerms(
  vector: Float32Array,
  vocab: LoadedVocabTerm[],
  limit: number,
  minSimilarity = 0.35,
): VocabMatch[] {
  const scored: VocabMatch[] = [];
  for (const term of vocab) {
    const similarity = cosine(vector, term.vector);
    if (similarity >= minSimilarity) scored.push({ term, similarity });
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}

export function vocabByKey(vocab: LoadedVocabTerm[]): Map<string, LoadedVocabTerm> {
  return new Map(vocab.map((term) => [term.key, term]));
}

/** True when every word of the phrase occurs somewhere in the corpus vocabulary. */
export function phraseInVocab(
  phrase: string,
  byKey: Map<string, LoadedVocabTerm>,
): boolean {
  const key = normalizeKey(phrase);
  if (byKey.has(key)) return true;
  const words = tokenize(phrase);
  return words.length > 0 && words.every((word) => byKey.has(word));
}
