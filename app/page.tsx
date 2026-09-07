import { AppClient } from "@/components/AppClient";
import { listDocuments } from "@/lib/db";

export const dynamic = "force-dynamic";

export default function Home() {
  return <AppClient initialDocuments={listDocuments()} />;
}
