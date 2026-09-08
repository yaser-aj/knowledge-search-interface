import { parseLenientJson } from "@/lib/llm";

const CASES: [string, string][] = [
  ["clean", '{"facets":[{"label":"a"}],"mustCover":["x"]}'],
  ["fenced", '```json\n{"facets":[{"label":"a"}]}\n```'],
  ["prose wrapped", 'Sure! Here is the plan:\n{"facets":[{"label":"a"}]}\nHope that helps.'],
  ["trailing comma", '{"facets":[{"label":"a"},],}'],
  [
    "truncated mid-string",
    '{"interpretation":"x","facets":[{"label":"one","expansions":["Doha","Riyadh"]},{"label":"two","expansions":["Qatari Riyal',
  ],
  [
    "truncated after element",
    '{"interpretation":"x","facets":[{"label":"one","expansions":["Doha"]},{"label":"two","expansions":["Dubai"]},',
  ],
  ["not json at all", "I cannot help with that request."],
];

let failures = 0;
for (const [name, input] of CASES) {
  const parsed = parseLenientJson(input) as { facets?: { label: string }[] } | null;
  const labels = parsed?.facets?.map((facet) => facet.label).join(",") ?? "—";
  const expectedNull = name === "not json at all";
  const ok = expectedNull ? parsed === null : parsed !== null;
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(24)} facets: ${labels}`);
}

console.log(failures === 0 ? "\nall repair cases pass" : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
