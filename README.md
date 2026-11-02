# Wilhelm

A multi-turn enterprise knowledge-base agent with domain routing, grounded RAG answers, and on-demand output formatting. Built for the hackathon demo; runs fully locally or against any cloud LLM/embedding provider.

---

> **⚠️ Synthetic demo data notice**
>
> The HR policy and IT support documents in `data/hr-policies/` and `data/it-support/` are **entirely synthetic**. They were generated for this hackathon and do **not** represent real KOHLER policy, procedures, or guidance of any kind. Do not treat them as authoritative. Both document sets are committed to the repository so the project is fully reproducible by anyone who clones it — no separate data download required.

---

## What it does

Wilhelm answers employee questions by retrieving relevant passages from an internal knowledge base and generating a grounded, cited response. It never answers from model training data alone — every response traces back to a specific retrieved document.

Key capabilities:

- **Domain routing** — a lightweight LLM-based router classifies each query as `hr`, `support`, or `out_of_scope` before touching the vector store. Out-of-scope queries are rejected immediately with zero retrieval cost.
- **Grounded RAG answers** — retrieved chunks are injected into the LLM prompt and the model is instructed to signal when the context doesn't cover the question. The `grounded` boolean in every response makes this machine-readable.
- **Multi-turn sessions** — conversation history is kept server-side and injected into subsequent prompts. Follow-up queries (e.g. "and what about annual leave?") resolve correctly without the user repeating context.
- **On-demand output formatting** — the same answer can be returned as plain text, a structured JSON object, an XML document, a downloadable Excel file, or a ready-to-send email draft. The format is selected per-request.
- **Source panel** — the chat UI shows an expandable panel under each answer listing exactly which document sections were retrieved, with a green/amber grounding indicator.

---

## Architecture

```
User query
    │
    ▼
┌─────────────┐
│   Router    │  LLM call — classifies domain + confidence
│  (router.js)│  → hr | support | out_of_scope
└──────┬──────┘
       │ (out_of_scope → fast reject, no further calls)
       ▼
┌─────────────┐
│  Retriever  │  embedText(query) → queryVectorStore(embedding, topK, {domain})
│(retriever.js│  returns ranked chunks with source metadata
└──────┬──────┘
       │ (empty result → "no context" fast path)
       ▼
┌─────────────┐
│   Answer    │  generateText(prompt + chunks + history)
│  (answer.js)│  → { answer, sources, grounded }
└──────┬──────┘
       ▼
┌──────────────────┐
│ Format dispatcher│  dispatch(format, result)
│ (dispatcher.js)  │  → json | xml | xlsx | email | plain
└──────────────────┘
       │
       ▼
  HTTP response  (Content-Type set per format)
```

### Adapter layer

All provider coupling is isolated behind two adapter modules. The rest of the codebase never imports an LLM or vector-store SDK directly.

**`backend/src/lib/llm.js`** — `generateText(prompt, options)`

| `LLM_PROVIDER` | SDK used | Default model |
|---|---|---|
| `openai` (default) | `openai` npm package → `api.openai.com` | `gpt-4o-mini` |
| `gemini` | `@google/genai` | `gemini-2.0-flash` |
| `local` | `openai` npm package pointed at `LLM_BASE_URL` | `llama3` |

**`backend/src/lib/vectorstore.js`** — `embedText(text)`, `upsertVectors(items)`, `queryVectorStore(embedding, topK, filter)`

| `EMBEDDING_PROVIDER` | Default model |
|---|---|
| `openai` (default) | `text-embedding-3-small` (1536 dims) |
| `gemini` | `gemini-embedding-2` (3072 dims) |
| `local` | `nomic-embed-text` via Ollama (768 dims) |

| `VECTOR_STORE_PROVIDER` | Notes |
|---|---|
| `pinecone` (default) | Requires `PINECONE_API_KEY` + `PINECONE_INDEX_NAME` |
| `chroma` | Requires a running `chroma run` server; defaults to `http://localhost:8000` |
| `supabase` | Supabase Postgres with pgvector; requires project URL and a backend service role key |

---

## Running locally

### 1. Prerequisites

- Node.js 20+
- An LLM API key **or** a local model server (Ollama, LM Studio, etc.)
- An embedding API key **or** the same local server for embeddings
- A Pinecone account, a running Chroma instance, or a Supabase project with pgvector enabled

### 2. Install dependencies

```bash
npm run install:all
```

This installs both `frontend/` and `backend/` packages in one command.

### 3. Configure environment variables

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

Edit `backend/.env`. The minimum set of variables depends on your chosen providers:

#### Option A — OpenAI + Pinecone (cloud, quickest start)

```env
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-...

EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536

VECTOR_STORE_PROVIDER=pinecone
PINECONE_API_KEY=pcsk_...
PINECONE_INDEX_NAME=wilhelm
```

Create the Pinecone index first — dimension `1536`, metric `cosine`.

#### Option B — Gemini + Pinecone

```env
LLM_PROVIDER=gemini
LLM_MODEL=gemini-2.0-flash
GEMINI_API_KEY=AIza...

EMBEDDING_PROVIDER=gemini
EMBEDDING_MODEL=gemini-embedding-2
EMBEDDING_DIMENSIONS=3072

VECTOR_STORE_PROVIDER=pinecone
PINECONE_API_KEY=pcsk_...
PINECONE_INDEX_NAME=wilhelm
```

Create the Pinecone index with dimension `3072`.

#### Option C — Fully local (Ollama + Chroma, no API keys)

```bash
# Start Ollama and pull the models you want
ollama pull llama3
ollama pull nomic-embed-text

# Start Chroma
chroma run --path ./chroma-data
```

```env
LLM_PROVIDER=local
LLM_MODEL=llama3
LLM_BASE_URL=http://localhost:11434/v1

EMBEDDING_PROVIDER=local
EMBEDDING_MODEL=nomic-embed-text
EMBEDDING_BASE_URL=http://localhost:11434/v1
EMBEDDING_DIMENSIONS=768

VECTOR_STORE_PROVIDER=chroma
CHROMA_URL=http://localhost:8000
CHROMA_COLLECTION=wilhelm
```

#### Option D — OpenAI + Supabase pgvector

The included SQL schema uses `text-embedding-3-small` (1536 dimensions). In the Supabase dashboard, open **SQL Editor**, run `backend/supabase/schema.sql`, and set these values in `backend/.env`:

```env
EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
OPENAI_API_KEY=sk-...

VECTOR_STORE_PROVIDER=supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_TABLE=documents
SUPABASE_MATCH_FUNCTION=match_documents
```

Use the project URL and service role key from the Supabase project settings. Keep the service role key in the backend environment only; never expose it in the frontend. After the schema and environment are set, run the ingestion command below to load the local source documents into Supabase.

### 4. Ingest the knowledge base

The source documents are already in the repo at `data/hr-policies/` and `data/it-support/`. Run the ingestion pipeline to chunk, embed, and upload them to your vector store:

```bash
cd backend
node src/scripts/ingest.js
```

Useful flags:

```bash
# Preview what would be ingested without making any API calls
node src/scripts/ingest.js --dry-run

# Re-chunk with custom settings
node src/scripts/ingest.js --chunk-size 300 --overlap 50

# Chroma only: wipe the collection and start fresh
node src/scripts/ingest.js --reset

# Ingest a single domain
node src/scripts/ingest.js --filter hr-policies
```

If you want to regenerate `data/chunks.json` separately (e.g. to inspect the chunks before embedding):

```bash
node src/scripts/chunk-documents.js --dry-run
node src/scripts/chunk-documents.js  # writes data/chunks.json
```

### 5. Start the servers

Open two terminals:

```bash
# Terminal 1 — backend (port 3001)
npm run dev:backend

# Terminal 2 — frontend (port 5173, proxies /api to backend)
npm run dev:frontend
```

Open `http://localhost:5173`.

---

## Project structure

```
wilhelm/
├── data/
│   ├── hr-policies/        # 15 synthetic HR policy documents (Markdown)
│   ├── it-support/         # 15 synthetic IT support documents (Markdown)
│   └── chunks.json         # Pre-chunked output (committed; regenerate with chunk-documents.js)
│
├── backend/
│   ├── .env.example        # All supported environment variables with comments
│   └── src/
│       ├── index.js        # Express server + POST /api/chat handler
│       └── lib/
│           ├── router.js         # LLM-based domain classifier
│           ├── retriever.js      # Embed query → vector store search
│           ├── answer.js         # Prompt assembly + LLM answer generation
│           ├── pipeline.js       # Orchestrates router → retriever → answer
│           ├── session.js        # Server-side conversation history
│           ├── dispatcher.js     # Routes format name to formatter
│           ├── formatter.js      # Plain/JSON formatter
│           ├── formatter-xml.js  # XML formatter
│           ├── formatter-xlsx.js # Excel formatter (ExcelJS)
│           ├── formatter-email.js# Email draft formatter
│           ├── llm.js            # LLM provider adapter
│           ├── vectorstore.js    # Embedding + vector store adapter
│           └── chunker.js        # Document chunking utilities
│       └── scripts/
│           ├── ingest.js         # Full embed + upsert pipeline
│           └── chunk-documents.js# Chunking only (writes chunks.json)
│
└── frontend/
    ├── .env.example
    └── src/
        ├── api/chat.js           # Typed fetch client for POST /api/chat
        ├── hooks/useChat.js      # React state + session management
        └── components/
            ├── ChatShell.jsx     # App shell: sidebar + main column
            ├── MessageList.jsx   # Scrollable message list
            ├── MessageBubble.jsx # Per-message bubble + format renderers
            ├── SourcePanel.jsx   # Expandable retrieved-document panel
            ├── ChatInput.jsx     # Textarea + format selector + send button
            └── EmptyState.jsx    # First-load prompt with example queries
```

---

## Known limitations

- **Domain coverage** — the knowledge base currently covers two domains only: HR policies and IT support. Queries about anything else (finance, legal, engineering, etc.) are routed to `out_of_scope` and answered with a redirect message.
- **No document update pipeline** — adding new documents requires re-running `ingest.js`. There is no watch mode or webhook-triggered re-ingestion.
- **Single-tenant session store** — sessions are kept in memory (`session.js`) and are lost on server restart. A production deployment would replace this with Redis or a database.
- **No authentication** — the `/api/chat` endpoint is open. A production deployment would add auth middleware before exposing it externally.
- **Excel and XML formats are not session-aware** — when you request `xlsx` or `xml` format, the response is a fully formatted payload for that single turn; the frontend handles it as a download or code block rather than a conversational message.
- **Synthetic data** — as noted above, all 30 documents in the repo are fabricated for demo purposes and reflect no real company policy.

---

## API reference

### `POST /api/chat`

**Request body**

```json
{
  "query":        "How many sick days am I entitled to?",
  "sessionId":    "optional — omit for first turn",
  "historyTurns": 6,
  "format":       "plain"
}
```

| Field | Type | Default | Values |
|---|---|---|---|
| `query` | string | required | — |
| `sessionId` | string | — | ID from previous response |
| `historyTurns` | number | `6` | Number of prior turns to inject |
| `format` | string | `"plain"` | `plain` `json` `xml` `xlsx` `email` |

**Response — `plain` / `json` format**

```json
{
  "answer":     "You are entitled to 10 days of paid sick leave per year.",
  "domain":     "hr",
  "confidence": "high",
  "stage":      "answered",
  "grounded":   true,
  "sources":    ["hr-policies › 02-sick-leave › Entitlement"],
  "sourceDocs": [{ "filename": "02-sick-leave.md", "filePath": "...", "heading": "Entitlement", "domain": "hr-policies" }],
  "sessionId":  "a3f9c2b1...",
  "timing":     { "routeMs": 180, "retrieveMs": 95, "answerMs": 740, "totalMs": 1015 }
}
```

**Response — other formats**

| `format` | `Content-Type` | Body |
|---|---|---|
| `xml` | `application/xml` | XML document string |
| `xlsx` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | Binary; `Content-Disposition: attachment` |
| `email` | `text/plain` | `Subject: …\n\n<body>` |
