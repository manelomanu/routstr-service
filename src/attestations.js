/**
 * AIRadar Reliability Attestations — kind 30421
 *
 * Publishes parameterized-replaceable Nostr events vouching for provider reliability.
 * One event per provider, replaced on each publish cycle. Expiry = 30 days.
 * Stop publishing = auto-revoke (event expires, Vokter ignores stale vouches).
 *
 * Vokter query: { kinds: [30421], authors: [AIRADAR_PUBKEY] }
 * Match by: event.tags.find(t => t[0]==='r')?.[1] === endpoint_url
 *
 * Namespace: airadar.reliability (NIP-32 compatible label tags)
 * NOT the same as Vokter's "trusted" space — these mean "good uptime", nothing more.
 */

import { finalizeEvent, Relay, getPublicKey } from 'nostr-tools'
import db from './db.js'

const RELAYS = [
  'wss://relay.airadar.fyi',
  'wss://relay.routstr.com',
  'wss://relay.nostr.band',
  'wss://relay.damus.io',
  'wss://nos.lol',
]

const MIN_UPTIME_PCT  = 70   // >= 70% uptime in last 24h
const MIN_CHECK_COUNT = 5    // >= 5 checks to avoid vouching after 1 ping
const EXPIRY_DAYS     = 30

const stmtProviders = db.prepare(`
  SELECT pubkey, name, endpoint, network, response_ms,
         uptime_ok_24h, uptime_total_24h,
         CAST(uptime_ok_24h AS REAL) / MAX(uptime_total_24h, 1) * 100 AS uptime_pct
  FROM providers
  WHERE endpoint IS NOT NULL
    AND uptime_total_24h >= ?
    AND CAST(uptime_ok_24h AS REAL) / MAX(uptime_total_24h, 1) * 100 >= ?
  ORDER BY uptime_pct DESC, response_ms ASC
`)

function reliabilityScore(uptimePct, responseMs) {
  const uptimePoints  = Math.round(uptimePct * 0.6)          // 0–60
  const latencyMs     = responseMs || 9999
  const latencyPoints = Math.max(0, Math.round(40 * (1 - Math.min(latencyMs, 4000) / 4000)))
  return Math.min(100, uptimePoints + latencyPoints)
}

function buildAttestation(provider, sk) {
  const uptimePct = provider.uptime_pct ?? 0
  const score     = reliabilityScore(uptimePct, provider.response_ms)
  const expiry    = Math.floor(Date.now() / 1000) + EXPIRY_DAYS * 86400

  const tags = [
    ['d',       provider.pubkey],
    ['r',       provider.endpoint],
    ['L',       'airadar.reliability'],
    ['l',       'reliable', 'airadar.reliability'],
    ['expiry',  String(expiry)],
    ['network', provider.network || 'unknown'],
    ['score',   String(score)],
    ['uptime',  String(Math.round(uptimePct))],
  ]

  // Real Nostr pubkeys (64-char hex) get a p tag for direct identity linking
  if (/^[0-9a-f]{64}$/.test(provider.pubkey)) {
    tags.push(['p', provider.pubkey])
  }

  const content = JSON.stringify({
    name:           provider.name,
    endpoint:       provider.endpoint,
    network:        provider.network || 'unknown',
    score,
    uptime_24h_pct: Math.round(uptimePct),
    latency_ms:     provider.response_ms || null,
    source:         'airadar.fyi',
    note:           `Reliability score ${score}/100. Uptime ${Math.round(uptimePct)}% over last 24h.`,
    expires_at:     new Date(expiry * 1000).toISOString(),
  })

  return finalizeEvent({
    kind:       30421,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content,
  }, sk)
}

async function publishToRelay(relayUrl, event) {
  try {
    const relay = await Relay.connect(relayUrl)
    await relay.publish(event)
    relay.close()
    return true
  } catch {
    return false
  }
}

async function publishCycle(sk) {
  const providers = stmtProviders.all(MIN_CHECK_COUNT, MIN_UPTIME_PCT)

  if (!providers.length) {
    console.log('[attestations] No providers meet reliability threshold — skipping')
    return
  }

  console.log(`[attestations] Publishing vouches for ${providers.length} providers`)
  let published = 0

  for (const provider of providers) {
    try {
      const event = buildAttestation(provider, sk)
      // Publish to each relay with individual error handling — avoids SimplePool's
      // bug where a late rate-limit CLOSED message calls ep.reject on a resolved
      // promise reference, crashing the process with an uncaught exception.
      await Promise.allSettled(RELAYS.map(r => publishToRelay(r, event)))
      published++
    } catch (e) {
      console.error(`[attestations] Failed for ${provider.name}:`, e.message)
    }
    await new Promise(r => setTimeout(r, 500))
  }

  console.log(`[attestations] Done — ${published}/${providers.length} vouches published`)
}

export function startAttestationPublisher() {
  const privHex = process.env.NOSTR_PRIVKEY
  if (!privHex) {
    console.warn('[attestations] NOSTR_PRIVKEY not set — skipping')
    return
  }

  const sk     = Uint8Array.from(Buffer.from(privHex, 'hex'))
  const pubkey = getPublicKey(sk)
  console.log(`[attestations] AIRadar pubkey: ${pubkey.slice(0, 16)}…`)

  // Wait 90s after startup for DB to populate from Nostr sync, then run
  setTimeout(() => publishCycle(sk).catch(e => console.error('[attestations]', e.message)), 90_000)

  // Re-publish every 24h (replaces previous events on relay)
  setInterval(() => publishCycle(sk).catch(e => console.error('[attestations]', e.message)), 24 * 60 * 60 * 1000)
}
