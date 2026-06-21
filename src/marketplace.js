import { randomBytes } from 'crypto'
import db from './db.js'

// ── Schema (run once at startup) ──────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS listings (
    id              TEXT    PRIMARY KEY,
    agent_id        TEXT    NOT NULL,
    name            TEXT    NOT NULL,
    description     TEXT    NOT NULL,
    category        TEXT    NOT NULL,
    tags            TEXT    DEFAULT '[]',
    endpoint_url    TEXT,
    contact_nostr   TEXT,
    status          TEXT    DEFAULT 'active',
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category, status);
  CREATE INDEX IF NOT EXISTS idx_listings_agent    ON listings(agent_id);
`)

// ── Prepared statements ───────────────────────────────────────────────────────
const stmtInsert = db.prepare(`
  INSERT INTO listings (id, agent_id, name, description, category, tags, endpoint_url, contact_nostr, created_at, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

const stmtList = db.prepare(`
  SELECT id, name, description, category, tags, created_at, expires_at
  FROM listings
  WHERE status = 'active' AND expires_at > ?
  ORDER BY created_at DESC
  LIMIT ? OFFSET ?
`)

const stmtByCategory = db.prepare(`
  SELECT id, name, description, category, tags, created_at, expires_at
  FROM listings
  WHERE status = 'active' AND expires_at > ? AND category = ?
  ORDER BY created_at DESC
  LIMIT ? OFFSET ?
`)

const stmtCount = db.prepare(`SELECT COUNT(*) AS n FROM listings WHERE status = 'active' AND expires_at > ?`)
const stmtCountCat = db.prepare(`SELECT COUNT(*) AS n FROM listings WHERE status = 'active' AND expires_at > ? AND category = ?`)

const stmtGetFull = db.prepare(`
  SELECT id, agent_id, name, description, category, tags, endpoint_url, contact_nostr, created_at, expires_at
  FROM listings WHERE id = ? AND status = 'active' AND expires_at > ?
`)

const stmtGetPublic = db.prepare(`
  SELECT id, name, description, category, tags, created_at, expires_at
  FROM listings WHERE id = ? AND status = 'active' AND expires_at > ?
`)

const VALID_CATEGORIES = new Set([
  'inference', 'search', 'data', 'compute', 'storage',
  'translation', 'vision', 'audio', 'agent', 'other',
])

function nanoid() {
  return randomBytes(16).toString('base64url').slice(0, 22)
}

function safeStr(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

// ── Routes ────────────────────────────────────────────────────────────────────
export function registerMarketplaceRoutes(app, requireList, requireReveal) {

  // Browse marketplace — free (endpoint_url hidden)
  app.get('/marketplace', (req, res) => {
    const now    = Math.floor(Date.now() / 1000)
    const limit  = Math.min(parseInt(req.query.limit) || 20, 50)
    const offset = Math.max(0, parseInt(req.query.offset) || 0)
    const cat    = req.query.category?.trim()

    let rows, total
    if (cat && VALID_CATEGORIES.has(cat)) {
      rows  = stmtByCategory.all(now, cat, limit, offset)
      total = stmtCountCat.get(now, cat).n
    } else {
      rows  = stmtList.all(now, limit, offset)
      total = stmtCount.get(now).n
    }

    res.json({
      total, limit, offset,
      categories: [...VALID_CATEGORIES],
      listings: rows.map(r => ({
        id:          r.id,
        name:        r.name,
        description: r.description,
        category:    r.category,
        tags:        (() => { try { return JSON.parse(r.tags || '[]') } catch { return [] } })(),
        listed_at:   new Date(r.created_at * 1000).toISOString(),
        expires_at:  new Date(r.expires_at  * 1000).toISOString(),
        reveal_url:  `https://airadar.fyi/marketplace/${r.id}`,
        note:        'Pay to reveal endpoint and contact details',
      })),
    })
  })

  // List your agent — paid
  app.post('/marketplace', requireList, (req, res) => {
    const { name, description, category, tags, endpoint_url, contact_nostr } = req.body || {}

    if (!safeStr(name))        return res.status(400).json({ error: 'name required' })
    if (!safeStr(description)) return res.status(400).json({ error: 'description required' })
    if (!VALID_CATEGORIES.has(category)) {
      return res.status(400).json({ error: `category must be one of: ${[...VALID_CATEGORIES].join(', ')}` })
    }
    if (!safeStr(endpoint_url, 500)) return res.status(400).json({ error: 'endpoint_url required' })
    try {
      const u = new URL(endpoint_url)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error()
    } catch {
      return res.status(400).json({ error: 'endpoint_url must be a valid http/https URL' })
    }

    const safeTags = Array.isArray(tags) ? tags.slice(0, 10).map(t => String(t).trim().slice(0, 30)) : []
    const now = Math.floor(Date.now() / 1000)
    const id  = nanoid()
    const agentId = res.locals.walletAddress || res.locals.paymentId || 'anon'

    stmtInsert.run(
      id, agentId,
      safeStr(name, 100),
      safeStr(description, 500),
      category,
      JSON.stringify(safeTags),
      safeStr(endpoint_url, 500),
      safeStr(contact_nostr, 100) || null,
      now,
      now + 30 * 86400,
    )

    res.json({
      id,
      message: 'Listing created. Valid for 30 days.',
      public_url: `https://airadar.fyi/marketplace`,
      reveal_url: `https://airadar.fyi/marketplace/${id}`,
      expires_at: new Date((now + 30 * 86400) * 1000).toISOString(),
    })
  })

  // Reveal full listing (endpoint + contact) — paid
  app.get('/marketplace/:id', requireReveal, (req, res) => {
    const now     = Math.floor(Date.now() / 1000)
    const listing = stmtGetFull.get(req.params.id, now)
    if (!listing) return res.status(404).json({ error: 'Listing not found or expired' })

    res.json({
      id:            listing.id,
      name:          listing.name,
      description:   listing.description,
      category:      listing.category,
      tags:          JSON.parse(listing.tags || '[]'),
      endpoint_url:  listing.endpoint_url,
      contact_nostr: listing.contact_nostr || null,
      listed_at:     new Date(listing.created_at * 1000).toISOString(),
      expires_at:    new Date(listing.expires_at  * 1000).toISOString(),
    })
  })
}
