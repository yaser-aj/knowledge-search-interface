import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // These packages load native/ONNX runtime binaries and large PDF/DOCX parsers.
  // They must stay outside the bundler and be required at runtime on the server.
  serverExternalPackages: ["@huggingface/transformers", "unpdf", "mammoth"],
};

export default nextConfig;
