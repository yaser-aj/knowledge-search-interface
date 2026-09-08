import { relaxConnectionRacing } from "./net";
import { ensureDataDirs, paths } from "./paths";

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;

const MAX_CHARS = 6000;

type FeatureExtractor = (
  input: string | string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

let extractor: FeatureExtractor | null = null;
let loading: Promise<FeatureExtractor> | null = null;

async function getExtractor(): Promise<FeatureExtractor> {
  if (extractor) return extractor;
  if (!loading) {
    loading = (async () => {
      ensureDataDirs();
      relaxConnectionRacing();
      // Keep the model download inside the project's data dir instead of $HOME.
      process.env.HF_HOME ??= paths.models;
      const { pipeline, env } = await import("@huggingface/transformers");
      env.cacheDir = paths.models;
      const pipe = await pipeline("feature-extraction", EMBEDDING_MODEL, {
        dtype: "fp32",
      });
      return pipe as unknown as FeatureExtractor;
    })().catch((error) => {
      loading = null;
      throw error;
    });
  }
  extractor = await loading;
  return extractor;
}

/** Warms the model so the first user-facing request is not the one paying for it. */
export async function warmEmbedder(): Promise<void> {
  await getExtractor();
}

function clip(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > MAX_CHARS ? trimmed.slice(0, MAX_CHARS) : trimmed;
}

export async function embed(text: string): Promise<Float32Array> {
  const [vector] = await embedAll([text]);
  return vector;
}

/**
 * Embeds a batch of texts. Sequential batches of `batchSize` keep peak memory
 * predictable on small machines while still amortising the tokenizer setup.
 */
export async function embedAll(texts: string[], batchSize = 8): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const pipe = await getExtractor();
  const out: Float32Array[] = [];

  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize).map(clip);
    const result = await pipe(batch, { pooling: "mean", normalize: true });
    const flat =
      result.data instanceof Float32Array ? result.data : Float32Array.from(result.data);
    const dim = result.dims.at(-1) ?? EMBEDDING_DIM;
    for (let i = 0; i < batch.length; i += 1) {
      out.push(flat.slice(i * dim, (i + 1) * dim));
    }
  }

  return out;
}

/** Both vectors are L2-normalised by the pipeline, so the dot product is the cosine. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += a[i] * b[i];
  return sum;
}

export function meanVector(vectors: Float32Array[]): Float32Array {
  const out = new Float32Array(EMBEDDING_DIM);
  if (vectors.length === 0) return out;
  for (const vector of vectors) {
    for (let i = 0; i < out.length; i += 1) out[i] += vector[i] ?? 0;
  }
  let norm = 0;
  for (let i = 0; i < out.length; i += 1) {
    out[i] /= vectors.length;
    norm += out[i] * out[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < out.length; i += 1) out[i] /= norm;
  }
  return out;
}
