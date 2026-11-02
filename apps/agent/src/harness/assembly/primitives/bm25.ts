export interface Bm25Document {
  id: string;
  text: string;
}

export interface Bm25Index {
  search(query: string, limit: number): string[];
}

const K1 = 1.2;
const B = 0.75;

function isCjkOnly(text: string): boolean {
  if (text.length === 0) return false;
  for (const char of text) {
    if (!/\p{Script=Han}/u.test(char)) return false;
  }
  return true;
}

function cjkBigrams(text: string): string[] {
  if (text.length < 2) return text.length === 1 ? [text] : [];
  const out: string[] = [];
  for (let i = 0; i < text.length - 1; i++) out.push(text.slice(i, i + 2));
  return out;
}

function splitIdentifier(segment: string): string[] {
  const withSpaces = segment.replace(/([a-z\d])([A-Z])/g, "$1 $2");
  const chunks = withSpaces.split(/\s+/).filter(Boolean);
  const parts: string[] = [];
  for (const chunk of chunks) {
    if (chunk.includes("__")) parts.push(...chunk.split("__").filter(Boolean));
    else if (chunk.includes("_")) parts.push(...chunk.split("_").filter(Boolean));
    else parts.push(chunk);
  }
  return parts;
}

export function tokenizeForSearch(text: string): string[] {
  const segments = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const tokens: string[] = [];
  for (const segment of segments) {
    for (const part of splitIdentifier(segment)) {
      if (!part) continue;
      const lower = part.toLowerCase();
      if (isCjkOnly(lower)) {
        tokens.push(...cjkBigrams(lower));
        continue;
      }
      if (lower.length > 1) tokens.push(lower);
      else if (/\p{L}/u.test(lower) || /\p{N}/u.test(lower)) tokens.push(lower);
    }
  }
  return tokens;
}

export function createBm25Index(documents: Bm25Document[]): Bm25Index {
  const docs = documents.map((doc) => ({
    id: doc.id,
    tokens: tokenizeForSearch(doc.text),
  }));
  const docLengths = docs.map((d) => d.tokens.length);
  const avgLen = docLengths.length === 0
    ? 0
    : docLengths.reduce((a, b) => a + b, 0) / docLengths.length;

  const df = new Map<string, number>();
  for (const doc of docs) {
    const seen = new Set(doc.tokens);
    for (const term of seen) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const n = docs.length;

  return {
    search(query: string, limit: number): string[] {
      const qTerms = tokenizeForSearch(query);
      if (qTerms.length === 0 || n === 0) return [];

      const scores = docs.map((doc, i) => {
        const len = docLengths[i] ?? 0;
        const tf = new Map<string, number>();
        for (const term of doc.tokens) tf.set(term, (tf.get(term) ?? 0) + 1);

        let score = 0;
        for (const term of qTerms) {
          const freq = tf.get(term) ?? 0;
          if (freq === 0) continue;
          const docFreq = df.get(term) ?? 0;
          const idf = Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5));
          const denom = freq + K1 * (1 - B + B * (len / (avgLen || 1)));
          score += idf * ((freq * (K1 + 1)) / denom);
        }
        return { id: doc.id, score };
      });

      return scores
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(0, limit))
        .map((row) => row.id);
    },
  };
}
