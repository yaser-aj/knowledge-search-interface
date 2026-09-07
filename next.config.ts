import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "better-sqlite3",
    "@huggingface/transformers",
    "onnxruntime-node",
    "sharp",
  ],
};

export default nextConfig;
