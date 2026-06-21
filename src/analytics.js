import { createHash } from 'crypto'
import db from './db.js'

// ── Prepared statements ───────────────────────────────────────────────────────
const stmtLog = db.prepare(`
  INSERT INTO request_log
    (ts, endpoint, method, status, response_ms,
     payment_type, payment_id, wallet_address,
     agent_id, model, ip_hash, user_agent, query_text)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

// Dashboard overview
const stmtTotal24h      = db.prepare('SELECT COUNT(*) as n FROM request_log WHERE ts > ?')
const stmtPaid24h       = db.prepare('SELECT COUNT(*) as n FROM request_log WHERE ts > ? AND payment_type IS NOT NULL')
const stmtAgents24h     = db.prepare('SELECT COUNT(DISTINCT ip_hash) as n FROM request_log WHERE ts > ?')
const stmtWallets24h    = db.prepare('SELECT COUNT(DISTINCT wallet_address) as n FROM request_log WHERE ts > ? AND wallet_address IS NOT NULL')
const stmtTopEndpoints  = db.prepare('SELECT endpoint, COUNT(*) as calls FROM request_log WHERE ts > ? GROUP BY endpoint ORDER BY calls DESC LIMIT 15')
const stmtTopModels     = db.prepare('SELECT model, COUNT(*) as calls FROM request_log WHERE ts > ? AND model IS NOT NULL GROUP BY model ORDER BY calls DESC LIMIT 10')
const stmtPaymentSplit  = db.prepare('SELECT payment_type, COUNT(*) as n FROM request_log WHERE ts > ? AND payment_type IS NOT NULL GROUP BY payment_type')
const stmtHourly        = db.prepare(`
  SELECT CAST((ts - (ts % 3600)) AS INTEGER) as hour_ts, COUNT(*) as calls
  FROM request_log WHERE ts > ?
  GROUP BY hour_ts ORDER BY hour_ts ASC
`)
const stmtStatusBreak   = db.prepare('SELECT status, COUNT(*) as n FROM request_log WHERE ts > ? GROUP BY status ORDER BY n DESC')

// Agents route
const stmtAgentProfiles = db.prepare(`
  SELECT
    wallet_address,
    COUNT(*)                              AS total_calls,
    COUNT(DISTINCT endpoint)              AS endpoints_used,
    MIN(ts)                               AS first_seen,
    MAX(ts)                               AS last_seen,
    GROUP_CONCAT(DISTINCT endpoint)       AS endpoint_list,
    GROUP_CONCAT(DISTINCT model)          AS model_list,
    AVG(response_ms)                      AS avg_response_ms,
    SUM(CASE WHEN status = 200 THEN 1 ELSE 0 END) AS successful_calls
  FROM request_log
  WHERE wallet_address IS NOT NULL AND ts > ?
  GROUP BY wallet_address
  ORDER BY total_calls DESC
  LIMIT ?
`)

// Activity stream
const stmtActivity = db.prepare(`
  SELECT ts, endpoint, method, status, response_ms,
         payment_type, wallet_address, agent_id, model, user_agent, query_text
  FROM request_log
  WHERE ts > ?
  ORDER BY ts DESC
  LIMIT ?
`)

// Endpoint intelligence
const stmtEndpoints = db.prepare(`
  SELECT
    endpoint,
    COUNT(*)                                        AS total_calls,
    SUM(CASE WHEN payment_type IS NOT NULL THEN 1 ELSE 0 END) AS paid_calls,
    SUM(CASE WHEN payment_type = 'l402' THEN 1 ELSE 0 END)   AS l402_calls,
    SUM(CASE WHEN payment_type = 'x402' THEN 1 ELSE 0 END)   AS x402_calls,
    COUNT(DISTINCT ip_hash)                         AS unique_agents,
    COUNT(DISTINCT wallet_address)                  AS unique_wallets,
    AVG(response_ms)                                AS avg_ms,
    MIN(response_ms)                                AS min_ms,
    MAX(response_ms)                                AS max_ms,
    SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS errors
  FROM request_log
  WHERE ts > ?
  GROUP BY endpoint
  ORDER BY total_calls DESC
`)

// Behavioral sequences
const stmtSequences = db.prepare(`
  SELECT wallet_address, GROUP_CONCAT(endpoint, ' → ') AS sequence, COUNT(*) as steps
  FROM (
    SELECT wallet_address, endpoint, ts
    FROM request_log
    WHERE ts > ? AND wallet_address IS NOT NULL
    ORDER BY wallet_address, ts
  )
  GROUP BY wallet_address
  HAVING steps >= ?
  ORDER BY steps DESC
  LIMIT 50
`)

// Raw export
const stmtExport = db.prepare(`
  SELECT ts, endpoint, method, status, response_ms,
         payment_type, payment_id, wallet_address,
         agent_id, model, ip_hash, user_agent, query_text
  FROM request_log WHERE ts > ?
  ORDER BY ts DESC
`)

// ── Middleware: capture every request ─────────────────────────────────────────
export function analyticsMiddleware(req, res, next) {
  const start = Date.now()

  res.on('finish', () => {
    try {
      const now     = Date.now()
      const rawIp   = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
                    || req.socket?.remoteAddress || ''
      const ipHash  = createHash('sha256').update(rawIp).digest('hex').slice(0, 16)
      const endpoint  = req.route?.path || req.path
      const queryText = (
        req.query.q      || req.query.url    || req.query.topic  ||
        req.query.domain || req.query.ids    || req.query.repo   ||
        req.query.expr   || null
      )
      stmtLog.run(
        Math.floor(now / 1000),
        endpoint,
        req.method,
        res.statusCode,
        now - start,
        res.locals.paymentType    || null,
        res.locals.paymentId      || null,
        res.locals.walletAddress  || null,
        req.params?.agent_id      || res.locals.agentId || null,
        res.locals.model          || req.body?.model    || req.query?.model || null,
        ipHash,
        (req.headers['user-agent'] || '').slice(0, 200) || null,
        String(queryText || '').slice(0, 500) || null,
      )
    } catch { /* never crash on telemetry */ }
  })

  next()
}

// ── Admin key guard ───────────────────────────────────────────────────────────
const ONE_DAY  = 86400
const ONE_WEEK = 86400 * 7

function since(seconds) { return Math.floor(Date.now() / 1000) - seconds }

function requireAdmin(req, res, next) {
  const key = req.headers['x-analytics-key']
  if (!process.env.ANALYTICS_KEY || key !== process.env.ANALYTICS_KEY) {
    return res.status(404).json({ error: 'Not found' })
  }
  next()
}

// ── Route registration ────────────────────────────────────────────────────────
export function registerAnalyticsRoutes(app) {

  app.get('/analytics', requireAdmin, (_req, res) => {
    const day  = since(ONE_DAY)
    const week = since(ONE_WEEK)

    res.json({
      period: 'last_24h',
      activity: {
        total_requests: stmtTotal24h.get(day).n,
        paid_requests:  stmtPaid24h.get(day).n,
        unique_agents:  stmtAgents24h.get(day).n,
        unique_wallets: stmtWallets24h.get(day).n,
      },
      week: {
        unique_agents:  stmtAgents24h.get(week).n,
        unique_wallets: stmtWallets24h.get(week).n,
      },
      payment_split:    stmtPaymentSplit.all(day),
      status_breakdown: stmtStatusBreak.all(day),
      top_endpoints:    stmtTopEndpoints.all(day),
      top_models:       stmtTopModels.all(day),
      hourly_traffic:   stmtHourly.all(day).map(r => ({
        hour:  new Date(r.hour_ts * 1000).toISOString(),
        calls: r.calls,
      })),
    })
  })

  app.get('/analytics/agents', requireAdmin, (req, res) => {
    const cutoff = since(ONE_WEEK * 4)
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200)
    const wallets = stmtAgentProfiles.all(cutoff, limit)

    res.json({
      period: 'last_28_days',
      count: wallets.length,
      agents: wallets.map(w => ({
        wallet:           w.wallet_address,
        total_calls:      w.total_calls,
        successful_calls: w.successful_calls,
        endpoints_used:   w.endpoints_used,
        endpoints:        w.endpoint_list?.split(',').filter(Boolean).slice(0, 20),
        models_used:      w.model_list?.split(',').filter(Boolean),
        avg_latency_ms:   Math.round(w.avg_response_ms) || 0,
        first_seen:       new Date(w.first_seen * 1000).toISOString(),
        last_seen:        new Date(w.last_seen  * 1000).toISOString(),
        active_days:      Math.round((w.last_seen - w.first_seen) / ONE_DAY),
      })),
    })
  })

  app.get('/analytics/activity', requireAdmin, (req, res) => {
    const limit  = Math.min(parseInt(req.query.limit) || 100, 500)
    const cutoff = req.query.since ? parseInt(req.query.since) : since(3600)
    const rows   = stmtActivity.all(cutoff, limit)

    res.json({
      count:     rows.length,
      oldest_ts: rows.length ? rows[rows.length - 1].ts : null,
      events:    rows.map(r => ({
        ts:         new Date(r.ts * 1000).toISOString(),
        endpoint:   r.endpoint,
        method:     r.method,
        status:     r.status,
        ms:         r.response_ms,
        payment:    r.payment_type,
        wallet:     r.wallet_address,
        agent_id:   r.agent_id,
        model:      r.model,
        user_agent: r.user_agent,
        query:      r.query_text,
      })),
    })
  })

  app.get('/analytics/endpoints', requireAdmin, (_req, res) => {
    const rows = stmtEndpoints.all(since(ONE_WEEK))
    res.json({
      period: 'last_7_days',
      endpoints: rows.map(r => ({
        endpoint:       r.endpoint,
        total_calls:    r.total_calls,
        paid_calls:     r.paid_calls,
        l402_calls:     r.l402_calls,
        x402_calls:     r.x402_calls,
        unique_agents:  r.unique_agents,
        unique_wallets: r.unique_wallets,
        avg_ms:         Math.round(r.avg_ms),
        min_ms:         r.min_ms,
        max_ms:         r.max_ms,
        error_rate:     r.total_calls > 0 ? (r.errors / r.total_calls).toFixed(3) : '0',
      })),
    })
  })

  app.get('/analytics/sequences', requireAdmin, (req, res) => {
    const minCalls = Math.max(1, parseInt(req.query.min_calls) || 3)
    const active   = stmtSequences.all(since(ONE_DAY), minCalls)
    res.json({
      period:      'last_24h',
      description: 'Call sequences per wallet — reveals agent reasoning patterns',
      sequences:   active.map(r => ({ wallet: r.wallet_address, steps: r.steps, sequence: r.sequence })),
    })
  })

  app.get('/analytics/export', requireAdmin, (req, res) => {
    const hours  = Math.min(parseInt(req.query.hours) || 24, 168)
    const rows   = stmtExport.all(since(hours * 3600))
    res.set('Content-Type', 'application/x-ndjson')
    for (const row of rows) res.write(JSON.stringify(row) + '\n')
    res.end()
  })
}
