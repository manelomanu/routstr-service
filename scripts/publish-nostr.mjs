/**
 * Publish AIRadar's Nostr identity and service announcement.
 *
 * First run: generates a new keypair, saves NOSTR_PRIVKEY to .env, publishes.
 * Subsequent runs: reuses the same key (stable identity).
 *
 * Usage:
 *   node scripts/publish-nostr.mjs
 *   node scripts/publish-nostr.mjs --dry-run   # print events, don't publish
 */

import { generateSecretKey, getPublicKey, finalizeEvent, SimplePool } from 'nostr-tools'
import { readFileSync, writeFileSync, existsSync } from 'fs'

const hexToBytes = hex => Uint8Array.from(Buffer.from(hex, 'hex'))
const bytesToHex = bytes => Buffer.from(bytes).toString('hex')
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
const ENV_PATH = resolve(__dir, '../.env')
const DRY_RUN  = process.argv.includes('--dry-run')

const RELAYS = [
  'wss://relay.airadar.fyi',
  'wss://relay.routstr.com',
  'wss://relay.nostr.band',
  'wss://relay.damus.io',
  'wss://nos.lol',
]

// ── Key management ────────────────────────────────────────────────────────────

function loadOrCreateKey() {
  let privHex = null

  if (existsSync(ENV_PATH)) {
    const env = readFileSync(ENV_PATH, 'utf8')
    const match = env.match(/^NOSTR_PRIVKEY=([0-9a-f]{64})/m)
    if (match) privHex = match[1]
  }

  if (privHex) {
    console.log('Using existing NOSTR_PRIVKEY from .env')
    return hexToBytes(privHex)
  }

  const sk = generateSecretKey()
  privHex  = bytesToHex(sk)

  if (!DRY_RUN) {
    const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
    writeFileSync(ENV_PATH, existing.trimEnd() + `\nNOSTR_PRIVKEY=${privHex}\n`)
    console.log('Generated new keypair — saved NOSTR_PRIVKEY to .env')
  } else {
    console.log('[dry-run] Generated keypair (not saved):', privHex)
  }

  return sk
}

// ── Event builders ────────────────────────────────────────────────────────────

function buildProfile(pubkey) {
  return {
    kind: 0,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify({
      name:    'AIRadar',
      about:   'Decentralized AI provider directory. 77+ providers, 340+ models. Pay per query with Lightning (L402) or USDC (x402) — no account, no API key.',
      website: 'https://airadar.fyi',
      picture: 'https://airadar.fyi/logo.png',
      nip05:   'airadar@airadar.fyi',
      lud16:   'airadar@getalby.com',
    }),
  }
}

function buildAnnouncement(pubkey) {
  const text = `⚡ AIRadar — Decentralized AI Provider Directory

Find, compare, and route to 77+ Nostr/Routstr AI providers and 340+ models. Pay per query with Lightning (L402) or USDC (x402). No account, no API key, no subscription.

🔌 What you get:
• GET /providers — full directory sorted by uptime + speed
• GET /intelligence — trending models, reliability, latencies
• POST /reputation/compare — pick the best agent before paying
• GET /agentanalysis/:id — bot detection, coordination, volume anomaly
• GET /marketplace — browse agents offering services
• POST /v1/chat/completions — inference gateway (340+ models)

📡 Own relay: wss://relay.airadar.fyi
🐍 Python SDK: pip install airadar-sdk
📖 Docs: https://airadar.fyi

Designed for autonomous AI agents — machine-readable at /info

#nostr #ai #lightning #l402 #routstr #bitcoin #llm`

  return {
    kind: 1,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['t', 'nostr'],
      ['t', 'ai'],
      ['t', 'lightning'],
      ['t', 'l402'],
      ['t', 'routstr'],
      ['t', 'bitcoin'],
      ['t', 'llm'],
      ['r', 'https://airadar.fyi'],
    ],
    content: text,
  }
}

function buildProviderAnnouncement(pubkey) {
  return {
    kind:       38421,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['u',    'https://airadar.fyi'],
      ['t',    'directory'],
      ['t',    'intelligence'],
      ['t',    'reputation'],
      ['t',    'l402'],
      ['t',    'x402'],
      ['d',    'airadar.fyi'],
    ],
    content: JSON.stringify({
      name:        'AIRadar',
      about:       'AI provider directory, network intelligence, agent reputation, and marketplace. Pay per query with Lightning or USDC.',
      website:     'https://airadar.fyi',
      relay:       'wss://relay.airadar.fyi',
      endpoints: {
        directory:   'GET  /providers        — 10 sats | $0.01 USDC',
        intelligence:'GET  /intelligence     — 10 sats | $0.01 USDC',
        reputation:  'GET  /reputation/:id   — free',
        agentanalysis:'GET /agentanalysis/:id — 15 sats',
        marketplace: 'GET  /marketplace      — free (reveal: 5 sats)',
        inference:   'POST /v1/chat/completions — 50-1000 sats',
      },
      python_sdk: 'pip install airadar-sdk',
    }),
  }
}

// ── Publish ───────────────────────────────────────────────────────────────────

async function publish(pool, event) {
  const label = `kind:${event.kind}`
  console.log(`\nPublishing ${label}...`)
  console.log('  id:', event.id)
  console.log('  content preview:', JSON.stringify(event.content).slice(0, 80))

  if (DRY_RUN) {
    console.log('  [dry-run] skipping publish')
    return
  }

  const results = await Promise.allSettled(
    RELAYS.map(r => pool.publish([r], event))
  )

  RELAYS.forEach((r, i) => {
    const result = results[i]
    if (result.status === 'fulfilled') {
      console.log(`  ✓ ${r}`)
    } else {
      console.log(`  ✗ ${r} — ${result.reason?.message || result.reason}`)
    }
  })
}

// ── Main ──────────────────────────────────────────────────────────────────────

const sk     = loadOrCreateKey()
const pubkey = getPublicKey(sk)
console.log('\nPublic key (hex):', pubkey)
console.log('npub: use https://njump.me/'+pubkey+' to see profile\n')

const pool   = new SimplePool()

const events = [
  buildProfile(pubkey),
  buildAnnouncement(pubkey),
  buildProviderAnnouncement(pubkey),
].map(template => finalizeEvent(template, sk))

for (const event of events) {
  await publish(pool, event)
  await new Promise(r => setTimeout(r, 500))
}

pool.destroy()
console.log('\nDone.')
