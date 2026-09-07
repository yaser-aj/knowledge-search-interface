# Knowledge Search Interface

Ask questions about a local document library. The app retrieves relevant passages, plans what to write, drafts a cited answer, and verifies the claims. Every answer names the documents it used.

## Setup

1. Copy `.env.example` to `.env.local` and add an [OpenRouter](https://openrouter.ai/keys) API key.
2. Install dependencies and start the app:

```bash
npm install
npm run dev
```

3. Open [http://localhost:3000](http://localhost:3000). Upload PDF, TXT, or MD files, then ask.

Generation uses OpenRouter free models: `nvidia/nemotron-3-ultra-550b-a55b:free`, then Super, then `openrouter/free`. Free-tier accounts are limited to **20 requests/minute** and **50 requests/day** (1,000/day after $10 in lifetime credits). Failed 429s still count. Embeddings run locally (MiniLM), so indexing does not spend that quota.

## How a question is answered

1. **Retrieve** — local cosine search over chunk embeddings, with a small boost from thumbs-up intent feedback.
2. **Plan** — the model picks which results matter and outlines the response from what was asked.
3. **Write** — streams an answer that follows the plan. Every factual claim is cited.
4. **Verify** — checks the answer against the selected passages and the plan.

If a node fails (timeout or free-tier limit), use **Resume from here**. Completed nodes are not repeated.

## Data

Documents, embeddings, and run traces live in `data/` on this machine. Nothing is uploaded except the text sent to OpenRouter for Plan / Write / Verify.
