// Tamperproof data anchoring via OpenTimestamps (Bitcoin blockchain)
// No fees, no keys, no PoW — just POST a SHA256 hash to a free calendar server.
import { createHash } from 'crypto'

const CALENDAR = 'https://a.pool.opentimestamps.org'

// Anchor a JSON snapshot to Bitcoin via OpenTimestamps.
// Returns the hex SHA256 hash that was submitted (use it as the proof ID).
export async function anchorData(data) {
  const hash = createHash('sha256').update(JSON.stringify(data)).digest()

  const res = await fetch(`${CALENDAR}/digest`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body:    hash,
    signal:  AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`OTS submit failed: HTTP ${res.status}`)

  return hash.toString('hex')
}

// URL to check/retrieve the OTS proof once Bitcoin has confirmed (~1-6h).
export const proofUrl = (hash) => `${CALENDAR}/timestamp/${hash}`
