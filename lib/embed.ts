import { ensureDataDirs, paths } from "./paths";

ensureDataDirs();
process.env.HF_HOME ??= paths.modelsDir;
process.env.TRANSFORMERS_CACHE ??= paths.modelsDir;

type FeaturePipeline = (
  text: string,
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array | number[] }>;

let extractor: FeaturePipeline | null = null;
let loading: Promise<FeaturePipeline> | null = null;

async function getExtractor(): Promise<FeaturePipeline> {
  if (extractor) return extractor;
  if (!loading) {
    loading = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      const pipe = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
        cache_dir: paths.modelsDir,
      });
      return pipe as unknown as FeaturePipeline;
    })();
  }
  extractor = await loading;
  return extractor;
}

export async function embedText(text: string): Promise<Float32Array> {
  const pipe = await getExtractor();
  const clipped = text.length > 8000 ? text.slice(0, 8000) : text;
  const output = await pipe(clipped, { pooling: "mean", normalize: true });
  return output.data instanceof Float32Array
    ? output.data
    : Float32Array.from(output.data);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += a[i] * b[i];
  return sum;
}
