import { AppShell } from "@/components/AppShell";
import { isConfigured } from "@/lib/llm";
import { corpusStats, listDocuments } from "@/lib/store";

// The library lives on disk and changes at runtime, so this must never be
// prerendered at build time.
export const dynamic = "force-dynamic";

export default function Page() {
  // Rendered on the server so the library is populated on first paint.
  return (
    <AppShell
      initialDocuments={listDocuments()}
      initialStats={corpusStats()}
      llmConfigured={isConfigured()}
    />
  );
}
