# Knowledge Search Interface

Upload documents, ask questions, get an answer that cites the passages it came from. A LangGraph pipeline plans the search, retrieves evidence, writes the answer, and audits it — and the whole trace is visible in the UI.

The point of interest is the planning stage. Keyword search fails on a question like *"which business is headquartered somewhere in the GCC?"* because no document contains the string "GCC" — one says "our head office ... in Doha", another says "registered office ... in Riyadh". The planner expands the question into the surface forms documents actually use, and every expansion is checked against the real index before it is searched.

## Setup

Requires Node 22 or newer.

```bash
npm install
cp .env.example .env.local   # add an OpenRouter key (free: openrouter.ai/keys)
npm run seed                 # index the sample corpus in fixtures/
npm run dev
```

Without a key the app still runs: ingestion, retrieval, the corpus-only planner, and an extractive answer all work with no network calls beyond the one-time embedding-model download. The planner's world knowledge and the written answer need the key.

## How a question is answered

```
question → primeContext → planQuery → retrieveEvidence → writeAnswer → verifyAnswer → answer
                                ↑                                            │
                                └──────────── gaps found, one retry ─────────┘
```

**primeContext** embeds the question and pulls the indexed terms nearest to it, so the planner sees what the library contains instead of guessing.

**planQuery** asks the model to break the question into facets and expand each into concrete searchable terms. Then two grounding passes run for free:

- every model-proposed term is checked against the index and tagged `inCorpus`, so ungrounded guesses can be excluded from keyword search while still contributing to vector search;
- the index contributes its own terms near each facet, which is where expansions like `Sadd Tower`, `King Abdullah Financial District` and `Dubai Internet City` come from — the model never proposed them.

In the UI, expansion chips are styled by provenance: solid means the term is in the library, dashed means the model proposed it but the library does not contain it, and `idx` means the index suggested it.

If the planner call fails or the daily quota is gone, a deterministic planner takes over using the question's own wording plus its nearest indexed terms.

**retrieveEvidence** runs vector search per sub-query and BM25 per facet, fuses the rankings with reciprocal rank fusion blended with the absolute scores, boosts passages satisfying more than one facet (this is what makes "a business" **and** "in the GCC" resolve together), then diversifies with MMR and a cap of three passages per document. Every passage records why it was retrieved.

**writeAnswer** streams an answer constrained to the retrieved passages, citing inline as `[S2]`.

**verifyAnswer** labels each claim `supported`, `partial`, or `unsupported` against the passage it cites, checks the coverage checklist, and can send the graph back for one more retrieval pass.

## Cost

Three model calls per question: plan, write, verify. Everything else — embeddings, expansion grounding, retrieval, fusion, ranking — is local and free. Embeddings are generated on-device with MiniLM, so document contents never leave the machine except as the passages included in a prompt.

## Storage

There is no database. `data/` holds the uploaded files, chunk text as JSON, and embeddings as packed `Float32Array` files, loaded into an in-memory index on first use. Fine for tens to hundreds of documents, which is what an MVP needs.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run seed` | Index `fixtures/`. Add `-- --replace` to reindex files already in the library. |
| `npm run check:retrieval` | Compares the model-driven plan against the corpus-only plan on the GCC question. |
| `npm run check:planner` | Prints the planner's raw reply for prompt work. Takes a question as an argument. |
| `npm run check:embeddings` | Verifies the local embedding model loads. |
| `npm run check:json` | Exercises the lenient JSON parser, including truncated replies. |

## Notes on the free tier

Free OpenRouter models are rate limited and frequently overloaded, and they reason before answering, which can consume the whole token budget and return an empty message. The client sweeps a fallback chain of models twice, repairs JSON that was cut off mid-object, and falls back to the deterministic path rather than failing. Anything that degraded during a run is listed in the pipeline card, so a degraded answer is never presented as a clean one.
