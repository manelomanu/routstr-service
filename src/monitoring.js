import { randomBytes } from 'crypto'
import db from './db.js'
import { assertPublicHost } from './net-guard.js'

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS monitor_subscriptions (
    id           TEXT    PRIMARY KEY,
    owner_id     TEXT    NOT NULL,
    provider_pubkey TEXT NOT NULL,
    webhook_url  TEXT    NOT NULL,
    threshold_ms INTEGER DEFAULT 5000,
    last_state   TEXT    DEFAULT 'unknown',
    last_fired   INTEGER DEFAULT 0,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    active       INTEGER DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_monitor_active ON monitor_subscriptions(active, expires_at);
`)

// ── Prepared statements ───────────────────────────────────────────────────────
const stmtInsert = db.prepare(`
  INSERT INTO monitor_subscriptions (id, owner_id, provider_pubkey, webhook_url, threshold_ms, created_at, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`)

const stmtByOwner = db.prepare(`
  SELECT id, provider_pubkey, webhook_url, threshold_ms, last_state, last_fired, created_at, expires_at, active
  FROM monitor_subscriptions WHERE owner_id = ? ORDER BY created_at DESC
`)

const stmtCancel = db.prepare(`UPDATE monitor_subscriptions SET active = 0 WHERE id = ? AND owner_id = ?`)

const stmtActiveAll = db.prepare(`
  SELECT s.id, s.provider_pubkey, s.webhook_url, s.threshold_ms, s.last_state, s.last_fired,
         p.name, p.is_online, p.response_ms
  FROM monitor_subscriptions s
  LEFT JOIN providers p ON p.pubkey = s.provider_pubkey
  WHERE s.active = 1 AND s.expires_at > ?
`)

const stmtUpdateState = db.prepare(`
  UPDATE monitor_subscriptions SET last_state = ?, last_fired = ? WHERE id = ?
`)

const stmtExpire = db.prepare(`UPDATE monitor_subscriptions SET active = 0 WHERE expires_at < ?`)

function nanoid() {
  return randomBytes(16).toString('base64url').slice(0, 22)
}

// ── Webhook delivery (fire and forget with one retry) ─────────────────────────
async function fireWebhook(url, payload) {
  try { await assertPublicHost(new URL(url).hostname) } catch { return }
  const body = JSON.stringify(payload)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'AIRadar-Monitor/1.0' },
        body,
        signal:  AbortSignal.timeout(8000),
      })
      if (res.ok) return
    } catch { /* retry or give up */ }
  }
}

// ── Background check loop (called from startMonitor) ─────────────────────────
async function checkSubscriptions() {
  const now  = Math.floor(Date.now() / 1000)
  stmtExpire.run(now)

  const subs = stmtActiveAll.all(now)
  for (const sub of subs) {
    const online = !!sub.is_online
    const slow   = sub.response_ms && sub.response_ms > sub.threshold_ms

    const newState = !online ? 'offline' : slow ? 'degraded' : 'online'

    // Only fire on state transition, and at most once per 10 minutes
    if (newState !== sub.last_state && (now - sub.last_fired) > 600) {
      stmtUpdateState.run(newState, now, sub.id)
      fireWebhook(sub.webhook_url, {
        event:           'provider_state_change',
        subscription_id: sub.id,
        provider:        sub.provider_pubkey,
        provider_name:   sub.name || sub.provider_pubkey,
        previous_state:  sub.last_state,
        new_state:       newState,
        response_ms:     sub.response_ms || null,
        ts:              new Date().toISOString(),
        note:            newState === 'degraded'
          ? `Latency ${sub.response_ms}ms exceeded threshold ${sub.threshold_ms}ms`
          : `Provider went ${newState}`,
      }).catch(() => {})
    }
  }
}

export function startMonitor() {
  setInterval(() => {
    checkSubscriptions().catch(e => console.error('[monitor] check failed:', e.message))
  }, 60_000)
}

// ── Routes ────────────────────────────────────────────────────────────────────
export function registerMonitorRoutes(app, requireSubscribe) {

  // Subscribe to provider alerts — paid
  app.post('/monitor/subscribe', requireSubscribe, async (req, res) => {
    const { provider_pubkey, webhook_url, threshold_ms } = req.body || {}

    if (!provider_pubkey?.trim()) return res.status(400).json({ error: 'provider_pubkey required' })
    if (!webhook_url?.trim())     return res.status(400).json({ error: 'webhook_url required' })

    let parsedUrl
    try { parsedUrl = new URL(webhook_url) } catch {
      return res.status(400).json({ error: 'webhook_url must be a valid https URL' })
    }
    if (parsedUrl.protocol !== 'https:') return res.status(400).json({ error: 'webhook_url must use https' })
    try { await assertPublicHost(parsedUrl.hostname) } catch (e) {
      return res.status(400).json({ error: `webhook_url: ${e.message}` })
    }

    const now     = Math.floor(Date.now() / 1000)
    const id      = nanoid()
    const ownerId = res.locals.walletAddress || res.locals.paymentId || 'anon'
    const thresh  = Math.max(500, Math.min(30000, parseInt(threshold_ms) || 5000))

    stmtInsert.run(id, ownerId, provider_pubkey.trim(), webhook_url.trim(), thresh, now, now + 30 * 86400)

    res.json({
      id,
      provider_pubkey: provider_pubkey.trim(),
      webhook_url: webhook_url.trim(),
      threshold_ms: thresh,
      expires_at:  new Date((now + 30 * 86400) * 1000).toISOString(),
      message:     'Subscribed. You will receive POST webhooks on provider state changes for 30 days.',
    })
  })

  // List own subscriptions — free (identified by wallet address or payment id)
  app.get('/monitor/subscriptions', (req, res) => {
    const ownerId = req.query.owner_id?.trim()
    if (!ownerId) return res.status(400).json({ error: 'owner_id query param required' })

    const subs = stmtByOwner.all(ownerId)
    res.json({
      count: subs.length,
      subscriptions: subs.map(s => ({
        id:              s.id,
        provider_pubkey: s.provider_pubkey,
        webhook_url:     s.webhook_url,
        threshold_ms:    s.threshold_ms,
        last_state:      s.last_state,
        last_fired:      s.last_fired ? new Date(s.last_fired * 1000).toISOString() : null,
        active:          !!s.active,
        expires_at:      new Date(s.expires_at * 1000).toISOString(),
      })),
    })
  })

  // Cancel subscription — free
  app.delete('/monitor/subscriptions/:id', (req, res) => {
    const ownerId = req.query.owner_id?.trim()
    if (!ownerId) return res.status(400).json({ error: 'owner_id query param required' })

    const r = stmtCancel.run(req.params.id, ownerId)
    if (r.changes === 0) return res.status(404).json({ error: 'Subscription not found or not owned by you' })

    res.json({ message: 'Subscription cancelled' })
  })
}
