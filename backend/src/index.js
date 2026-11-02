import 'dotenv/config'
import express from 'express'
import { askWithHistory }  from './lib/pipeline.js'
import { dispatch }        from './lib/dispatcher.js'
import { UnsupportedFormatError } from './lib/dispatcher.js'
import {
  WilhelmError,
  EmptyQueryError,
  LLMError,
  VectorStoreError,
} from './lib/errors.js'

const app  = express()
const PORT = process.env.PORT ?? 3001

app.use(express.json())

// ── Startup validation ────────────────────────────────────────────────────────
// Warn loudly at boot if required provider env vars are missing so the first
// request doesn't crash with an opaque "Missing required environment variable"
// error buried in a 500 response.

function validateEnv() {
  const provider    = (process.env.LLM_PROVIDER         ?? 'openai').toLowerCase()
  const embProvider = (process.env.EMBEDDING_PROVIDER   ?? 'openai').toLowerCase()
  const vsProvider  = (process.env.VECTOR_STORE_PROVIDER ?? 'pinecone').toLowerCase()

  const missing = []

  if (provider === 'openai'  && !process.env.OPENAI_API_KEY)  missing.push('OPENAI_API_KEY')
  if (provider === 'gemini'  && !process.env.GEMINI_API_KEY)  missing.push('GEMINI_API_KEY')
  if (provider === 'local'   && !process.env.LLM_BASE_URL)    missing.push('LLM_BASE_URL')

  if (embProvider === 'openai' && !process.env.OPENAI_API_KEY && provider !== 'openai')
    missing.push('OPENAI_API_KEY (for embeddings)')
  if (embProvider === 'gemini' && !process.env.GEMINI_API_KEY && provider !== 'gemini')
    missing.push('GEMINI_API_KEY (for embeddings)')

  if (vsProvider === 'pinecone') {
    if (!process.env.PINECONE_API_KEY)   missing.push('PINECONE_API_KEY')
    if (!process.env.PINECONE_INDEX_NAME) missing.push('PINECONE_INDEX_NAME')
  }

  if (vsProvider === 'supabase') {
    if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL')
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY')
  }

  if (missing.length > 0) {
    console.warn(
      '\n⚠️  Wilhelm — missing environment variables:\n' +
      missing.map((v) => `   • ${v}`).join('\n') +
      '\n   Requests will fail until these are set. See backend/.env.example\n'
    )
  }
}

validateEnv()

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// ── Error serialiser ──────────────────────────────────────────────────────────
//
// Maps any thrown error to { status, body } so the route handler stays clean.
//
// Priority order:
//   1. EmptyQueryError       → 400, user-safe message
//   2. UnsupportedFormatError→ 400, message already user-safe
//   3. LLMError              → 502, sanitised userMessage (no key/model info)
//   4. VectorStoreError      → 502, sanitised userMessage
//   5. WilhelmError          → err.httpStatus, err.userMessage
//   6. Anything else         → 500, generic message (err.message logged, not sent)

function serialiseError(err) {
  if (err instanceof EmptyQueryError) {
    return { status: 400, error: err.userMessage }
  }
  if (err.name === 'UnsupportedFormatError') {
    return { status: 400, error: err.message }
  }
  if (err instanceof LLMError || err instanceof VectorStoreError) {
    return { status: 502, error: err.userMessage }
  }
  if (err instanceof WilhelmError) {
    return { status: err.httpStatus ?? 500, error: err.userMessage }
  }
  // Unknown error — log detail but send a generic message
  return {
    status: 500,
    error:  'Something went wrong. Please try again in a moment.',
  }
}

// ── POST /api/chat ─────────────────────────────────────────────────────────────
//
// Request body:
//   {
//     query:         string,
//     sessionId?:    string,
//     historyTurns?: number,
//     format?:       'plain' | 'json' | 'xml' | 'xlsx' | 'email'  (default: 'plain')
//   }
//
// Success responses (200):
//   plain / json  → JSON body (see formatter.js)
//   xml           → application/xml string
//   xlsx          → binary attachment
//   email         → text/plain
//
// Error responses:
//   400  validation errors (empty query, unsupported format)
//   502  upstream service errors (LLM, vector store) — user-safe message only
//   500  unexpected errors — generic message only

app.post('/api/chat', async (req, res) => {
  const { query, sessionId, historyTurns, format = 'plain' } = req.body ?? {}

  // ── Input validation ───────────────────────────────────────────────────────
  if (!query || typeof query !== 'string' || !query.trim()) {
    const err = new EmptyQueryError()
    return res.status(err.httpStatus).json({ error: err.userMessage })
  }

  try {
    const result = await askWithHistory(query.trim(), {
      sessionId:    sessionId ?? undefined,
      historyTurns: historyTurns ?? undefined,
    })

    // 'plain' skips the dispatcher — returns raw pipeline result as JSON
    if (!format || format === 'plain') {
      return res.json(result)
    }

    const { output, contentType } = await dispatch(format, result, { query: query.trim() })

    if (format === 'xlsx') {
      res.set({
        'Content-Type':        contentType,
        'Content-Disposition': 'attachment; filename="answer.xlsx"',
      })
      return res.send(output)
    }

    if (format === 'json') {
      return res.set('Content-Type', contentType).json(output)
    }

    // xml, email — string payloads
    return res.set('Content-Type', contentType).send(
      typeof output === 'object' ? JSON.stringify(output) : output
    )

  } catch (err) {
    // Always log the full technical error server-side
    console.error('[/api/chat]', err)

    const { status, error } = serialiseError(err)
    return res.status(status).json({ error })
  }
})

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`)
})
