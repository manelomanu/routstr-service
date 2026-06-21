import { SimplePool } from 'nostr-tools'
import db from './db.js'

// Confirmed from Routstr source code (routstr-core/routstr/nostr/discovery.py)
const RELAYS = [
  'wss://relay.airadar.fyi',
  'wss://relay.routstr.com',
  'wss://relay.nostr.band',
  'wss://relay.damus.io',
  'wss://nos.lol',
]

// Kind 38421 = NIP-91 Routstr Provider Announcement
const KIND = 38421

export function startNostrListener() {
  const pool = new SimplePool()
  console.log('Connecting to Nostr relays to find Routstr providers...')

  pool.subscribeMany(
    RELAYS,
    [{ kinds: [KIND], limit: 100 }],
    {
      onevent(event) {
        try {
          upsertProvider(event)
        } catch (e) {
          console.error('Error processing Nostr event:', e.message)
        }
      },
      oneose() {
        const count = db.prepare('SELECT COUNT(*) as n FROM providers').get().n
        console.log(`Initial Nostr sync done. Providers found: ${count}`)
      },
    }
  )
}

function upsertProvider(event) {
  let content = {}
  try { content = JSON.parse(event.content) } catch {}

  // Endpoint is in the "u" tag (may have multiple, take the first https one)
  const endpointTag = event.tags.find(t => t[0] === 'u' && t[1]?.startsWith('https'))
  const endpoint = endpointTag?.[1] || null

  // Mint for Cashu payments (informational for now)
  const mintTag = event.tags.find(t => t[0] === 'mint')
  const mint = mintTag?.[1] || null

  const name = content.name || `Provider ${event.pubkey.slice(0, 8)}`
  const about = content.about || ''

  db.prepare(`
    INSERT INTO providers (pubkey, name, models, price_msat, endpoint, last_seen, raw_event, network, auth_type)
    VALUES (@pubkey, @name, @models, @price_msat, @endpoint, @last_seen, @raw_event, 'routstr', 'lightning')
    ON CONFLICT(pubkey) DO UPDATE SET
      name       = excluded.name,
      models     = excluded.models,
      endpoint   = excluded.endpoint,
      last_seen  = excluded.last_seen,
      raw_event  = excluded.raw_event,
      network    = 'routstr',
      auth_type  = 'lightning'
  `).run({
    pubkey:     event.pubkey,
    name,
    models:     JSON.stringify([]),
    price_msat: 0,
    endpoint,
    last_seen:  event.created_at,
    raw_event:  JSON.stringify({ ...event, mint, about }),
  })

  console.log(`Provider: ${name} | endpoint: ${endpoint || 'unknown'}`)
}
