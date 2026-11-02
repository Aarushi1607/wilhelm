import 'dotenv/config'
import {
  findPatentByApplicationNumber,
  findPatentById,
} from './src/lib/patentLookup.js'

async function main() {
  // Enter a real application number or patent ID from Supabase.
  const applicationNumber = process.env.TEST_PATENT_APPLICATION_NUMBER
  const patentId = process.env.TEST_PATENT_ID

  let patent = null

  if (applicationNumber) {
    patent = await findPatentByApplicationNumber(applicationNumber)
  } else if (patentId) {
    patent = await findPatentById(patentId)
  } else {
    console.log('Set TEST_PATENT_APPLICATION_NUMBER or TEST_PATENT_ID locally.')
    return
  }

  if (!patent) {
    console.log('No exact matching patent record found.')
    return
  }

  console.log('Lookup successful.')
  console.log({
    found: true,
    hasId: patent.id != null,
    hasApplicationNumber: Boolean(patent.application_number),
    hasStatus: Boolean(patent.status),
    status: patent.status,
    hasFilingDate: Boolean(patent.filing_date),
    hasReviewFlag: typeof patent.needs_review === 'boolean',
  })
}

main().catch((error) => {
  console.error('Lookup test failed:', error.message)
  process.exitCode = 1
})