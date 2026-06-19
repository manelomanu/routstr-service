/**
 * SDK integration test — local server on :3000
 * Verifica que el cliente parsea correctamente el 402 y expone payment_options.
 */
import { AIRadar, AIRadarClient } from './src/index.js'

const BASE = 'http://localhost:3000'

let passed = 0
let failed = 0

function ok(label, cond) {
  if (cond) { console.log(`  ✓ ${label}`); passed++ }
  else       { console.error(`  ✗ ${label}`); failed++ }
}

// ── Test 1: 402 throws with payment_options ───────────────────────────────
console.log('\n[1] 402 without payment handler → error with payment_options')
try {
  const c = new AIRadar({ baseUrl: BASE })
  await c.data.crypto('bitcoin')
  ok('should have thrown', false)
} catch (e) {
  ok('throws on 402',       e.status === 402)
  ok('has payment_options', !!e.payment_options?.lightning)
  ok('has lightning.invoice', typeof e.payment_options?.lightning?.invoice === 'string')
  ok('has lightning.payment_hash', typeof e.payment_options?.lightning?.payment_hash === 'string')
  ok('has crypto.payment_required_header', typeof e.payment_options?.crypto?.payment_required_header === 'string')
}

// ── Test 2: reputation (free, no payment) ────────────────────────────────
console.log('\n[2] Reputation endpoint (free)')
const c = new AIRadar({ baseUrl: BASE })
const rep = await c.reputation.get('0xAGENT1234567890abcdef')
ok('score returned',  typeof rep.score === 'number')
ok('score = 90',      rep.score === 90)
ok('label = premium', rep.label === 'premium')
ok('has breakdown',   !!rep.breakdown)
ok('has integrate',   !!rep.integrate)
ok('powered_by set',  rep.powered_by === 'https://airadar.fyi')

// ── Test 3: leaderboard (free) ────────────────────────────────────────────
console.log('\n[3] Leaderboard (free)')
const lb = await c.reputation.leaderboard()
ok('has leaderboard array', Array.isArray(lb.leaderboard))
ok('first entry matches',   lb.leaderboard[0]?.id === '0xAGENT1234567890abcdef')

// ── Test 4: badge raw response ────────────────────────────────────────────
console.log('\n[4] Badge SVG (free, raw response)')
const badgeRes = await c.reputation.badge('0xAGENT1234567890abcdef')
ok('returns Response',       badgeRes instanceof Response)
ok('content-type svg',       badgeRes.headers.get('content-type')?.includes('svg'))
ok('status 200',             badgeRes.status === 200)
const svg = await badgeRes.text()
ok('is valid SVG',           svg.startsWith('<svg'))
ok('contains premium label', svg.includes('premium'))

// ── Test 5: 402 with mock L402 payment (preimage doesn't match — server rejects, but we verify flow) ─
console.log('\n[5] L402 payment flow (mock preimage — verifies client sends Authorization header)')
let invoiceSeen = null
let authSeen    = null

// Monkey-patch fetch to intercept the retry
const origFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (init?.headers?.Authorization?.startsWith('L402')) {
    authSeen = init.headers.Authorization
  }
  const res = await origFetch(url, init)
  return res
}

try {
  const payer = new AIRadar({
    baseUrl: BASE,
    lightning: async (bolt11) => {
      invoiceSeen = bolt11
      return '00'.repeat(32)  // fake preimage — server will reject but we verify client tried
    },
  })
  await payer.data.fees()
} catch (e) {
  // Expected — server rejects fake preimage
}
globalThis.fetch = origFetch

ok('lightning callback called with bolt11', invoiceSeen?.startsWith('lnbc'))
ok('retry sent Authorization: L402 header', authSeen?.startsWith('L402 '))
ok('Authorization format: L402 <hash>:<preimage>', /^L402 [0-9a-f]+:[0-9a-f]+$/.test(authSeen ?? ''))

// ── Summary ───────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`)
console.log(`  ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
