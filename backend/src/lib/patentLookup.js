/**
 * Read-only lookup for patent records in Supabase.
 * Exact match by application_number or patent id. Uses the anon key only.
 */

import 'dotenv/config'

const PATENT_VIEW = 'patents_overview'
const REQUEST_TIMEOUT_MS = 8000

// Adjust to the columns the view actually exposes.
const PATENT_COLUMNS = [
  'id',
  'application_number',
  'patent_office',
  'title',
  'status',
  'filing_date',
  'publication_date',
  'publication_number',
  'grant_date',
  'grant_number',
  'assignee_name',
  'reporting_year',
  'needs_review',
  'cleaning_notes',
].join(',')

export class PatentLookupError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'PatentLookupError'
    this.code = code // INVALID_INPUT | CONFIG | UPSTREAM | AMBIGUOUS
  }
}

function getConfig() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url) throw new PatentLookupError('Missing SUPABASE_URL', 'CONFIG')
  if (!key) throw new PatentLookupError('Missing SUPABASE_ANON_KEY', 'CONFIG')
  return { url: url.replace(/\/$/, ''), key }
}

async function findExactPatent(column, value) {
  const { url: baseUrl, key } = getConfig()

  const url = new URL(`/rest/v1/${PATENT_VIEW}`, baseUrl)
  url.searchParams.set('select', PATENT_COLUMNS)
  url.searchParams.set(column, `eq.${value}`)
  url.searchParams.set('limit', '2') // 2 so duplicates are detectable

  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new PatentLookupError('Patent lookup request failed', 'UPSTREAM')
  }

  if (!response.ok) {
    throw new PatentLookupError(
      `Patent lookup failed with Supabase HTTP ${response.status}`,
      'UPSTREAM'
    )
  }

  const records = await response.json()

  if (records.length > 1) {
    throw new PatentLookupError(
      'Multiple records matched; refusing to pick one',
      'AMBIGUOUS'
    )
  }

  return records[0] ?? null
}

export async function findPatentByApplicationNumber(applicationNumber) {
  const value = String(applicationNumber ?? '').trim()
  if (!value) {
    throw new PatentLookupError('Application number is required', 'INVALID_INPUT')
  }
  return findExactPatent('application_number', value)
}

export async function findPatentById(id) {
  const value = String(id ?? '').trim()
  if (!/^[1-9]\d*$/.test(value) || BigInt(value) > 9223372036854775807n) {
    throw new PatentLookupError(
      'Patent ID must be a positive integer',
      'INVALID_INPUT'
    )
  }
  return findExactPatent('id', value)
}