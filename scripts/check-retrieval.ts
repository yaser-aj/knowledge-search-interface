import { corpusOnlyPlan, groundFacets, type RawFacet } from "@/lib/graph/plan";
import { retrievePassages } from "@/lib/retrieval/engine";
import { corpusStats } from "@/lib/store";
import type { QueryPlan } from "@/lib/types";

const QUESTION = "a business that is headquartered somewhere in the GCC";

// What a competent planner model should return for this question.
const MODEL_FACETS: RawFacet[] = [
  {
    label: "corporate entity",
    intent: "a passage describing a company and where its main office sits",
    expansions: [
      "company", "firm", "group", "holding", "headquarters", "head office",
      "registered office", "incorporated", "statutory seat",
    ],
    subQueries: [
      "the group's head office is located at",
      "the company's registered office is in",
    ],
  },
  {
    label: "Gulf geography",
    intent: "a passage naming a Gulf Cooperation Council country or city",
    expansions: [
      "Saudi Arabia", "Riyadh", "Jeddah", "Dammam", "United Arab Emirates", "UAE",
      "Dubai", "Abu Dhabi", "Sharjah", "Qatar", "Doha", "Kuwait", "Kuwait City",
      "Bahrain", "Manama", "Oman", "Muscat",
    ],
    subQueries: ["office located in Doha Qatar", "registered in Riyadh Saudi Arabia"],
  },
];

function report(label: string, plan: QueryPlan, passages: Awaited<ReturnType<typeof retrievePassages>>) {
  console.log(`\n=== ${label} ===`);
  for (const facet of plan.facets) {
    const grounded = facet.expansions.filter((expansion) => expansion.inCorpus);
    const indexAdded = facet.expansions.filter((expansion) => expansion.origin === "index");
    console.log(
      `  facet "${facet.label}": ${facet.expansions.length} terms, ${grounded.length} in corpus, ${indexAdded.length} from index`,
    );
    console.log(`    in corpus: ${grounded.map((e) => e.term).join(", ") || "(none)"}`);
    if (indexAdded.length > 0) {
      console.log(`    index added: ${indexAdded.map((e) => e.term).join(", ")}`);
    }
  }
  console.log(`  stats: ${JSON.stringify(passages.stats)}`);
  passages.passages.forEach((passage, i) => {
    console.log(
      `  S${i + 1}  ${passage.filename}#${passage.index}  fused=${passage.fusedScore} dense=${passage.denseScore} lex=${passage.lexicalScore} facets=[${passage.facetHits.join("|")}]`,
    );
    console.log(`      ${passage.snippet.slice(0, 150)}`);
  });
}

console.log(`corpus: ${JSON.stringify(corpusStats())}`);
console.log(`question: ${QUESTION}`);

const modelPlan: QueryPlan = {
  interpretation: "Find a company whose headquarters is in a GCC member state.",
  entityType: "organization",
  answerShape: "list",
  facets: await groundFacets(MODEL_FACETS),
  mustCover: ["the name of the business", "the GCC city or country of its headquarters"],
  source: "llm",
  notes: [],
};

report(
  "planner-driven (simulating the LLM plan)",
  modelPlan,
  await retrievePassages({ question: QUESTION, plan: modelPlan, pass: 1 }),
);

const fallback = await corpusOnlyPlan(QUESTION);
report(
  "corpus-only fallback (no LLM)",
  fallback,
  await retrievePassages({ question: QUESTION, plan: fallback, pass: 1 }),
);
