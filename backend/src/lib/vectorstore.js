/**
 * Embedding + vector-store adapter
 *
 * Public API (three functions, nothing else should ever be imported):
 *
 *   embedText(text)
 *     → Promise<number[]>
 *     Embeds a plain string using the configured embedding provider.
 *
 *   upsertVectors(items)
 *     → Promise<void>
 *     Writes one or more vectors to the configured vector store.
 *     items: Array<{ id: string, embedding: number[], metadata?: object, text?: string }>
 *
 *   queryVectorStore(embedding, topK, filter)
 *     → Promise<QueryResult[]>
 *     Nearest-neighbour search.  Returns up to topK matches.
 *     filter: provider-specific metadata filter (optional)
 *     QueryResult: { id: string, score: number, metadata: object, text?: string }
 *
 * ── Embedding providers ───────────────────────────────────────────────────────
 *   EMBEDDING_PROVIDER = openai | gemini | local   (default: openai)
 *   EMBEDDING_MODEL    = model name for the chosen provider
 *   EMBEDDING_BASE_URL = base URL override for local (falls back to LLM_BASE_URL)
 *   OPENAI_API_KEY / GEMINI_API_KEY / LOCAL_API_KEY
 *
 * ── Vector-store providers ────────────────────────────────────────────────────
 *   VECTOR_STORE_PROVIDER = pinecone | chroma | supabase   (default: pinecone)
 *
 *   Pinecone:
 *     PINECONE_API_KEY, PINECONE_INDEX_NAME
 *
 *   Chroma (requires a running `chroma run` server):
 *     CHROMA_URL        (default: http://localhost:8000)
 *     CHROMA_COLLECTION (default: wilhelm)
 *
 *   Supabase (PostgREST + pgvector):
 *     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *     SUPABASE_TABLE (default: documents), SUPABASE_MATCH_FUNCTION (default: match_documents)
 */

import OpenAI from 'openai'
import { GoogleGenAI } from '@google/genai'
import { Pinecone } from '@pinecone-database/pinecone'
import { ChromaClient } from 'chromadb'

// ── Env helpers ───────────────────────────────────────────────────────────────

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function env(name, fallback = undefined) {
  return process.env[name] ?? fallback
}

// ── Embedding providers ───────────────────────────────────────────────────────

/**
 * OpenAI embeddings.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function embedOpenAI(text) {
  const client = new OpenAI({ apiKey: requireEnv('OPENAI_API_KEY') })
  const model = env('EMBEDDING_MODEL', 'text-embedding-3-small')

  const response = await client.embeddings.create({
    model,
    input: text,
    encoding_format: 'float',
  })

  return response.data[0].embedding
}

/**
 * Gemini embeddings via @google/genai.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function embedGemini(text) {
  const ai = new GoogleGenAI({ apiKey: requireEnv('GEMINI_API_KEY') })
  const model = env('EMBEDDING_MODEL', 'gemini-embedding-2')

  const response = await ai.models.embedContent({
    model,
    contents: text,
  })

  // response.embeddings is an array of ContentEmbedding; we want the first one
  return response.embeddings[0].values
}

/**
 * Local embeddings — any OpenAI-compatible endpoint (Ollama, LM Studio, etc.).
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function embedLocal(text) {
  const baseURL =
    env('EMBEDDING_BASE_URL') || requireEnv('LLM_BASE_URL')
  const apiKey = env('LOCAL_API_KEY', 'local')
  const model = env('EMBEDDING_MODEL', 'nomic-embed-text')

  const client = new OpenAI({ baseURL, apiKey })

  const response = await client.embeddings.create({
    model,
    input: text,
    encoding_format: 'float',
  })

  return response.data[0].embedding
}

const EMBEDDING_PROVIDERS = {
  openai: embedOpenAI,
  gemini: embedGemini,
  local: embedLocal,
}

// ── Vector-store providers ────────────────────────────────────────────────────

// Lazy singletons — created once on first use so startup doesn't fail if
// credentials aren't set for a store that won't be used.
let _pineconeIndex = null
let _chromaCollection = null

function supabaseConfig() {
  const base = requireEnv('SUPABASE_URL').replace(/\/$/, '')
  return {
    base,
    key: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    table: env('SUPABASE_TABLE', 'documents'),
    matchFunction: env('SUPABASE_MATCH_FUNCTION', 'match_documents'),
  }
}

async function supabaseRequest(path, options = {}) {
  const { base, key } = supabaseConfig()
  const response = await fetch(`${base}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Supabase request failed (${response.status}): ${detail}`)
  }
  if (response.status === 204) return null
  return response.json()
}

async function getPineconeIndex() {
  if (_pineconeIndex) return _pineconeIndex

  const pc = new Pinecone({ apiKey: requireEnv('PINECONE_API_KEY') })
  _pineconeIndex = pc.index(requireEnv('PINECONE_INDEX_NAME'))
  return _pineconeIndex
}

async function getChromaCollection() {
  if (_chromaCollection) return _chromaCollection

  const client = new ChromaClient({
    path: env('CHROMA_URL', 'http://localhost:8000'),
  })
  const collectionName = env('CHROMA_COLLECTION', 'wilhelm')

  // getOrCreate so the collection is always available
  _chromaCollection = await client.getOrCreateCollection({
    name: collectionName,
  })
  return _chromaCollection
}

// ── Upsert implementations ────────────────────────────────────────────────────

/**
 * @param {Array<{id: string, embedding: number[], metadata?: object, text?: string}>} items
 */
async function upsertPinecone(items) {
  const index = await getPineconeIndex()

  const vectors = items.map(({ id, embedding, metadata = {}, text }) => ({
    id,
    values: embedding,
    metadata: text ? { ...metadata, text } : metadata,
  }))

  await index.upsert(vectors)
}

/**
 * @param {Array<{id: string, embedding: number[], metadata?: object, text?: string}>} items
 */
async function upsertChroma(items) {
  const collection = await getChromaCollection()

  await collection.upsert({
    ids: items.map((i) => i.id),
    embeddings: items.map((i) => i.embedding),
    metadatas: items.map(({ metadata = {}, text }) =>
      text ? { ...metadata, text } : metadata
    ),
    documents: items.map((i) => i.text ?? ''),
  })
}

async function upsertSupabase(items) {
  const { table } = supabaseConfig()
  const rows = items.map(({ id, embedding, metadata = {}, text = '' }) => ({
    id,
    content: text,
    metadata,
    embedding,
  }))
  await supabaseRequest(`${encodeURIComponent(table)}?on_conflict=id`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  })
}

// ── Query implementations ─────────────────────────────────────────────────────

/**
 * @typedef {{ id: string, score: number, metadata: object, text?: string }} QueryResult
 */

/**
 * @param {number[]} embedding
 * @param {number} topK
 * @param {object} [filter]
 * @returns {Promise<QueryResult[]>}
 */
async function queryPinecone(embedding, topK, filter) {
  const index = await getPineconeIndex()

  const response = await index.query({
    vector: embedding,
    topK,
    filter,
    includeMetadata: true,
  })

  return response.matches.map(({ id, score, metadata = {} }) => {
    const { text, ...rest } = metadata
    return { id, score, metadata: rest, text }
  })
}

/**
 * @param {number[]} embedding
 * @param {number} topK
 * @param {object} [filter]
 * @returns {Promise<QueryResult[]>}
 */
async function queryChroma(embedding, topK, filter) {
  const collection = await getChromaCollection()

  const response = await collection.query({
    queryEmbeddings: [embedding],
    nResults: topK,
    where: filter,
  })

  // Chroma returns parallel arrays; zip them into result objects
  const ids = response.ids[0] ?? []
  const distances = response.distances[0] ?? []
  const metadatas = response.metadatas[0] ?? []
  const documents = response.documents[0] ?? []

  return ids.map((id, i) => ({
    id,
    // Chroma returns L2 distance; convert to a 0–1 similarity score
    score: 1 / (1 + distances[i]),
    metadata: metadatas[i] ?? {},
    text: documents[i] ?? undefined,
  }))
}

async function querySupabase(embedding, topK, filter) {
  const { matchFunction } = supabaseConfig()
  const domain = filter?.domain?.$eq ?? null
  const rows = await supabaseRequest(`rpc/${encodeURIComponent(matchFunction)}`, {
    method: 'POST',
    body: JSON.stringify({
      query_embedding: embedding,
      match_count: topK,
      filter_domain: domain,
    }),
  })
  return rows.map(({ id, content, metadata = {}, similarity }) => ({
    id,
    score: Number(similarity ?? 0),
    metadata,
    text: content,
  }))
}

const VECTOR_STORE_PROVIDERS = {
  pinecone: { upsert: upsertPinecone, query: queryPinecone },
  chroma: { upsert: upsertChroma, query: queryChroma },
  supabase: { upsert: upsertSupabase, query: querySupabase },
}

function getVectorStore() {
  const provider = env('VECTOR_STORE_PROVIDER', 'pinecone').toLowerCase()
  const store = VECTOR_STORE_PROVIDERS[provider]
  if (!store) {
    throw new Error(
      `Unknown VECTOR_STORE_PROVIDER "${provider}". Valid values: ${Object.keys(VECTOR_STORE_PROVIDERS).join(', ')}`
    )
  }
  return store
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Embed a plain string using the configured embedding provider.
 *
 * @param {string} text
 * @returns {Promise<number[]>} Dense embedding vector.
 */
export async function embedText(text) {
  const provider = env('EMBEDDING_PROVIDER', 'openai').toLowerCase()

  const handler = EMBEDDING_PROVIDERS[provider]
  if (!handler) {
    throw new Error(
      `Unknown EMBEDDING_PROVIDER "${provider}". Valid values: ${Object.keys(EMBEDDING_PROVIDERS).join(', ')}`
    )
  }

  return handler(text)
}

/**
 * Write vectors to the configured vector store.
 * Creates or replaces records with matching IDs (upsert semantics).
 *
 * @param {Array<{
 *   id:        string,
 *   embedding: number[],
 *   metadata?: object,
 *   text?:     string,
 * }>} items
 * @returns {Promise<void>}
 */
export async function upsertVectors(items) {
  if (!items.length) return
  return getVectorStore().upsert(items)
}

/**
 * Nearest-neighbour search against the configured vector store.
 *
 * @param {number[]} embedding  - Query vector (must match index dimensions).
 * @param {number}   topK       - Maximum number of results to return.
 * @param {object}   [filter]   - Provider-specific metadata filter (optional).
 *                                Pinecone: https://docs.pinecone.io/guides/data/filter-with-metadata
 *                                Chroma:   https://docs.trychroma.com/guides#using-where-filters
 * @returns {Promise<Array<{id: string, score: number, metadata: object, text?: string}>>}
 */
export async function queryVectorStore(embedding, topK = 10, filter) {
  return getVectorStore().query(embedding, topK, filter)
}
