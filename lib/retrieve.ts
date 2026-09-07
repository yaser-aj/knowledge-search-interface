import { snippetOf } from "./chunk";
import { cosine, embedText } from "./embed";
import { intentBoostsForTerms, listChunksWithDocuments } from "./db";
import { tokenize } from "./tokenize";
import type { RetrievedPassage } from "./types";

const FLOOR = 0.25;
const TOP_K = 8;
const NEAR_MISS = 3;
const BOOST_PER = 0.04;
const BOOST_CAP = 0.2;

export async function retrievePassages(question: string): Promise<{
  results: RetrievedPassage[];
  nearMisses: RetrievedPassage[];
}> {
  const chunks = listChunksWithDocuments();
  if (chunks.length === 0) {
    return { results: [], nearMisses: [] };
  }

  const queryEmbedding = await embedText(question);
  const terms = tokenize(question);
  const boosts = intentBoostsForTerms(terms);

  const ranked: RetrievedPassage[] = chunks
    .map((chunk) => {
      const score = cosine(queryEmbedding, chunk.embedding);
      const helpful = boosts.get(chunk.documentId) ?? 0;
      const boost = Math.min(BOOST_CAP, BOOST_PER * Math.log1p(helpful));
      return {
        chunkId: chunk.id,
        documentId: chunk.documentId,
        filename: chunk.filename,
        chunkIndex: chunk.chunkIndex,
        page: chunk.page,
        text: chunk.text,
        snippet: snippetOf(chunk.text),
        score,
        boostedScore: score + boost,
      };
    })
    .sort((a, b) => b.boostedScore - a.boostedScore);

  const results = ranked.filter((r) => r.score >= FLOOR).slice(0, TOP_K);
  const nearMisses = ranked.slice(0, NEAR_MISS);
  return { results, nearMisses };
}
