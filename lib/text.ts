const STOPWORDS = new Set([
  "a", "about", "above", "after", "again", "all", "also", "am", "an", "and", "any", "are",
  "as", "at", "be", "because", "been", "before", "being", "below", "between", "both", "but",
  "by", "can", "did", "do", "does", "doing", "down", "during", "each", "few", "for", "from",
  "further", "had", "has", "have", "having", "he", "her", "here", "hers", "him", "his", "how",
  "i", "if", "in", "into", "is", "it", "its", "itself", "just", "me", "more", "most", "my",
  "no", "nor", "not", "now", "of", "off", "on", "once", "only", "or", "other", "our", "ours",
  "out", "over", "own", "s", "same", "she", "should", "so", "some", "such", "t", "than",
  "that", "the", "their", "theirs", "them", "then", "there", "these", "they", "this", "those",
  "through", "to", "too", "under", "until", "up", "very", "was", "we", "were", "what", "when",
  "where", "which", "while", "who", "whom", "why", "will", "with", "would", "you", "your",
  "yours",
  // Function words that otherwise dominate policy and contract prose.
  "must", "may", "shall", "might", "could", "within", "upon", "per", "via", "whether",
  "however", "therefore", "including", "include", "made", "make", "remains", "remain",
  "held", "hold", "every", "either", "neither", "another", "across", "among", "toward",
  "towards", "without", "against", "along", "around", "behind", "beyond", "beside",
]);

export function isStopword(word: string): boolean {
  return STOPWORDS.has(word);
}

/** Lowercased alphanumeric tokens, stopwords and 1-character noise removed. */
export function tokenize(text: string): string[] {
  const raw = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]+/gu, " ")
    .split(/\s+/);

  const out: string[] = [];
  for (const word of raw) {
    const cleaned = word.replace(/^['-]+|['-]+$/g, "");
    if (cleaned.length < 2) continue;
    if (STOPWORDS.has(cleaned)) continue;
    out.push(cleaned);
  }
  return out;
}

/** Tokens of a phrase, kept in order, so multi-word terms can be matched as n-grams. */
export function phraseTokens(phrase: string): string[] {
  return tokenize(phrase);
}

export function countTokens(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

export function normalizeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function collapseWhitespace(text: string): string {
  return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function snippetOf(text: string, limit = 260): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}

export function wordCount(text: string): number {
  const matches = text.match(/\S+/g);
  return matches ? matches.length : 0;
}
