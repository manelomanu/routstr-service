import db from './db.js'
import { anchorData, proofUrl } from './ots.js'

// ── Scoring ───────────────────────────────────────────────────────────────────
function score(stats) {
  const now  = Math.floor(Date.now() / 1000)
  const days = (now - stats.first_seen) / 86400
  const idle = (now - stats.last_seen)  / 86400

  // Payments (0-35): cada interacción pagada cuenta
  const payments = Math.min(35, stats.paid_calls * 3.5)

  // Antigüedad (0-20): días desde la primera llamada
  const age = Math.min(20, days * 0.5)

  // Diversidad (0-20): endpoints distintos usados
  const diversity = Math.min(20, stats.distinct_endpoints * 3)

  // Recencia (0-15): qué tan reciente fue la última actividad
  const recency = idle < 1  ? 15
                : idle < 7  ? 12
                : idle < 14 ?  8
                : idle < 30 ?  4
                : 0

  // Tasa de pago (0-10): ratio pagado / total
  const rate = Math.round((stats.paid_calls / Math.max(1, stats.total_calls)) * 10)

  const total = Math.round(Math.min(100, payments + age + diversity + recency + rate))

  const label = total === 0 ? 'unknown'
              : total < 20  ? 'new'
              : total < 40  ? 'low'
              : total < 60  ? 'established'
              : total < 80  ? 'trusted'
              : 'premium'

  return { score: total, label }
}

// ── Query helpers ─────────────────────────────────────────────────────────────
function fetchStats(id) {
  const w = stmtByWallet.get(id)
  const a = stmtByAgent.get(id)
  return {
    total_calls:        (w?.total_calls || 0) + (a?.total_calls || 0),
    paid_calls:         (w?.paid_calls  || 0) + (a?.paid_calls  || 0),
    distinct_endpoints: Math.max(w?.distinct_endpoints || 0, a?.distinct_endpoints || 0),
    first_seen:         Math.min(w?.first_seen || Infinity, a?.first_seen || Infinity),
    last_seen:          Math.max(w?.last_seen  || 0,        a?.last_seen  || 0),
  }
}

const stmtByWallet = db.prepare(`
  SELECT COUNT(*)                                                  AS total_calls,
         SUM(CASE WHEN payment_type IS NOT NULL THEN 1 ELSE 0 END) AS paid_calls,
         COUNT(DISTINCT endpoint)                                  AS distinct_endpoints,
         MIN(ts) AS first_seen,
         MAX(ts) AS last_seen
  FROM request_log WHERE wallet_address = ?
`)

const stmtByAgent = db.prepare(`
  SELECT COUNT(*)                                                  AS total_calls,
         SUM(CASE WHEN payment_type IS NOT NULL THEN 1 ELSE 0 END) AS paid_calls,
         COUNT(DISTINCT endpoint)                                  AS distinct_endpoints,
         MIN(ts) AS first_seen,
         MAX(ts) AS last_seen
  FROM request_log WHERE agent_id = ?
`)

const stmtServices = db.prepare(`
  SELECT endpoint, COUNT(*) as calls
  FROM request_log
  WHERE wallet_address = ? OR agent_id = ?
  GROUP BY endpoint ORDER BY calls DESC LIMIT 10
`)

const stmtLeaderboard = db.prepare(`
  SELECT
    wallet_address                                                AS id,
    COUNT(*)                                                      AS total_calls,
    SUM(CASE WHEN payment_type IS NOT NULL THEN 1 ELSE 0 END)    AS paid_calls,
    COUNT(DISTINCT endpoint)                                      AS distinct_endpoints,
    MIN(ts) AS first_seen,
    MAX(ts) AS last_seen
  FROM request_log
  WHERE wallet_address IS NOT NULL
  GROUP BY wallet_address
  ORDER BY paid_calls DESC
  LIMIT 20
`)

const stmtHistory = db.prepare(`
  SELECT
    CAST((ts / 86400) * 86400 AS INTEGER)                              AS day_ts,
    COUNT(*)                                                            AS total,
    SUM(CASE WHEN payment_type IS NOT NULL THEN 1 ELSE 0 END)          AS paid,
    COUNT(DISTINCT endpoint)                                            AS endpoints
  FROM request_log
  WHERE (wallet_address = ? OR agent_id = ?) AND ts > ?
  GROUP BY day_ts ORDER BY day_ts ASC
`)

const stmtCategoryLeaders = db.prepare(`
  SELECT wallet_address AS id,
         COUNT(*)                                                       AS calls,
         SUM(CASE WHEN payment_type IS NOT NULL THEN 1 ELSE 0 END)     AS paid_calls,
         COUNT(DISTINCT endpoint)                                       AS distinct_endpoints,
         MIN(ts) AS first_seen, MAX(ts) AS last_seen
  FROM request_log
  WHERE wallet_address IS NOT NULL AND endpoint LIKE ?
  GROUP BY wallet_address
  ORDER BY paid_calls DESC
  LIMIT 20
`)

const stmtTimeline = db.prepare(`
  SELECT ts, endpoint, method, status, response_ms, payment_type, model
  FROM request_log
  WHERE (wallet_address = ? OR agent_id = ?)
  ORDER BY ts DESC LIMIT 50
`)

const stmtModelUsage = db.prepare(`
  SELECT model, COUNT(*) AS calls
  FROM request_log
  WHERE (wallet_address = ? OR agent_id = ?) AND model IS NOT NULL
  GROUP BY model ORDER BY calls DESC LIMIT 10
`)

const stmtPaymentMethods = db.prepare(`
  SELECT payment_type, COUNT(*) AS n
  FROM request_log
  WHERE (wallet_address = ? OR agent_id = ?) AND payment_type IS NOT NULL
  GROUP BY payment_type
`)

const stmtNetworkAvg = db.prepare(`
  SELECT AVG(paid_pct) AS avg_paid_pct, AVG(distinct_endpoints) AS avg_endpoints
  FROM (
    SELECT SUM(CASE WHEN payment_type IS NOT NULL THEN 1.0 ELSE 0 END) / COUNT(*) * 100 AS paid_pct,
           COUNT(DISTINCT endpoint) AS distinct_endpoints
    FROM request_log WHERE wallet_address IS NOT NULL
    GROUP BY wallet_address
    HAVING COUNT(*) >= 3
  )
`)

const stmtInsertAnchor = db.prepare(
  'INSERT INTO tangle_anchors (ts, data_hash, block_id, agents) VALUES (?, ?, ?, ?)'
)
const stmtLatestAnchor = db.prepare(
  'SELECT * FROM tangle_anchors ORDER BY ts DESC LIMIT 1'
)

// ── SVG badge ─────────────────────────────────────────────────────────────────
function badge(s, label) {
  const color = s === 0   ? '#9ca3af'  // gray  — unknown
              : s < 20    ? '#ef4444'  // red   — new
              : s < 40    ? '#f97316'  // orange — low
              : s < 60    ? '#eab308'  // yellow — established
              : s < 80    ? '#22c55e'  // green  — trusted
              : '#6366f1'              // indigo — premium

  const text = `AIRadar ${label} ${s}/100`
  const w    = 160

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0"  stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1"  stop-opacity=".1"/>
  </linearGradient>
  <rect rx="3" width="${w}" height="20" fill="#555"/>
  <rect rx="3" x="${w - 56}" width="56" height="20" fill="${color}"/>
  <rect rx="3" width="${w}" height="20" fill="url(#s)"/>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${(w - 56) / 2}" y="15" fill="#010101" fill-opacity=".3">AIRadar agent</text>
    <text x="${(w - 56) / 2}" y="14">AIRadar agent</text>
    <text x="${w - 28}" y="15" fill="#010101" fill-opacity=".3">${label} ${s}</text>
    <text x="${w - 28}" y="14">${label} ${s}</text>
  </g>
</svg>`
}

// ── OTS anchor job ────────────────────────────────────────────────────────────
function buildTimestampProof(anchor) {
  if (!anchor) return null
  return {
    data_hash:   anchor.data_hash,
    anchored_at: new Date(anchor.ts * 1000).toISOString(),
    blockchain:  'bitcoin',
    status:      'pending_confirmation',
    verify:      proofUrl(anchor.data_hash),
    note:        'Daily reputation snapshot timestamped to Bitcoin via OpenTimestamps',
  }
}

export function startOtsAnchor() {
  const anchor = async () => {
    const last = stmtLatestAnchor.get()
    if (last && (Math.floor(Date.now() / 1000) - last.ts) < 23 * 3600) return

    const top = stmtLeaderboard.all()
    if (!top.length) return

    const snapshot = top.map(r => {
      const s = score(r)
      return { id: r.id, score: s.score, label: s.label, paid_calls: r.paid_calls }
    })

    const payload = {
      service:   'airadar.fyi',
      timestamp: new Date().toISOString(),
      agents:    snapshot,
    }

    const hash = await anchorData(payload)
    stmtInsertAnchor.run(Math.floor(Date.now() / 1000), hash, hash, snapshot.length)
    console.log(`[ots] anchored ${snapshot.length} agents → ${hash.slice(0, 16)}...`)
  }

  anchor().catch(e => console.error('[ots] anchor failed:', e.message))
  setInterval(() => anchor().catch(e => console.error('[ots] anchor failed:', e.message)), 24 * 60 * 60 * 1000)
}

function sendWithProof(res, out) {
  const proof = buildTimestampProof(stmtLatestAnchor.get())
  if (proof) out.timestamp_proof = proof
  res.json(out)
}

// ── Routes ────────────────────────────────────────────────────────────────────
export function registerReputationRoutes(app, requireDetail) {

  // JSON reputation — free, sin auth, diseñado para que otros servicios integren
  app.get('/reputation/:id', (req, res) => {
    const id = req.params.id.trim()
    const { total_calls: totalCalls, paid_calls: paidCalls, distinct_endpoints: distinctEndpoints,
            first_seen: firstSeen, last_seen: lastSeen } = fetchStats(id)

    if (totalCalls === 0 || firstSeen === Infinity) {
      return res.json({
        id,
        score:   0,
        label:   'unknown',
        message: 'No activity found for this identifier on the AIRadar network.',
        integrate: {
          note:    'Query this endpoint free of charge to verify agent reputation before accepting payments.',
          example: `curl https://airadar.fyi/reputation/${id}`,
          badge:   `https://airadar.fyi/reputation/${id}/badge`,
        },
        powered_by: 'https://airadar.fyi',
      })
    }

    const stats  = { paid_calls: paidCalls, total_calls: totalCalls, distinct_endpoints: distinctEndpoints, first_seen: firstSeen, last_seen: lastSeen }
    const result = score(stats)
    const services = stmtServices.all(id, id)
    const out = {
      id,
      score:  result.score,
      label:  result.label,
      breakdown: {
        total_interactions:  totalCalls,
        paid_interactions:   paidCalls,
        payment_rate:        totalCalls > 0 ? `${Math.round((paidCalls / totalCalls) * 100)}%` : '0%',
        services_used:       distinctEndpoints,
        top_services:        services.map(s => s.endpoint),
        first_seen:          new Date(firstSeen * 1000).toISOString(),
        last_seen:           new Date(lastSeen  * 1000).toISOString(),
        days_active:         Math.round((lastSeen - firstSeen) / 86400),
      },
      integrate: {
        note:    'Any service can query this endpoint free of charge to verify agent reputation before accepting payments.',
        example: `curl https://airadar.fyi/reputation/${id}`,
        badge:   `https://airadar.fyi/reputation/${id}/badge`,
        usage:   'if (score < 40) reject payment — agent has insufficient reputation history',
      },
      powered_by: 'https://airadar.fyi',
    }

    sendWithProof(res, out)
  })

  // Compare up to 5 agents side by side — paid
  app.post('/reputation/compare', requireDetail, (req, res) => {
    const { ids } = req.body || {}
    if (!Array.isArray(ids) || ids.length < 2) return res.status(400).json({ error: 'Provide 2–5 agent IDs in "ids" array' })
    if (ids.length > 5) return res.status(400).json({ error: 'Maximum 5 agents per comparison' })

    const results = ids.map(rawId => {
      const id = String(rawId).trim().slice(0, 200)
      const stats = fetchStats(id)
      if (stats.total_calls === 0 || stats.first_seen === Infinity) {
        return { id, score: 0, label: 'unknown', total_interactions: 0, paid_interactions: 0, payment_rate: '0%', services_used: 0, days_active: 0 }
      }
      const r = score(stats)
      const now = Math.floor(Date.now() / 1000)
      return {
        id,
        score:              r.score,
        label:              r.label,
        total_interactions: stats.total_calls,
        paid_interactions:  stats.paid_calls,
        payment_rate:       `${Math.round(stats.paid_calls / Math.max(1, stats.total_calls) * 100)}%`,
        services_used:      stats.distinct_endpoints,
        days_active:        Math.round((stats.last_seen - stats.first_seen) / 86400),
        last_seen:          new Date(stats.last_seen * 1000).toISOString(),
        idle_days:          Math.round((now - stats.last_seen) / 86400),
      }
    })

    results.sort((a, b) => b.score - a.score)
    const winner = results[0]

    res.json({
      compared_at: new Date().toISOString(),
      winner:      { id: winner.id, score: winner.score, label: winner.label },
      agents:      results,
      recommendation: `${winner.id.slice(0, 12)}… scores highest (${winner.score}/100 — ${winner.label}). ` +
        `${winner.paid_interactions} paid interactions across ${winner.services_used} services.`,
    })
  })

  // Leaderboard by category / endpoint pattern — paid
  app.get('/reputation/leaderboard/:category', requireDetail, (req, res) => {
    const CATEGORIES = {
      inference: '/v1/chat/completions',
      search:    '/search',
      providers: '/providers',
      data:      '/data%',
      compute:   '/compute%',
    }
    const cat = req.params.category.toLowerCase()
    const pattern = CATEGORIES[cat]
    if (!pattern) {
      return res.status(400).json({ error: `Unknown category. Valid: ${Object.keys(CATEGORIES).join(', ')}` })
    }

    const rows = stmtCategoryLeaders.all(pattern)
    const out = {
      category:   cat,
      period:     'all_time',
      leaderboard: rows.map((r, i) => {
        const s = score(r)
        return {
          rank:     i + 1,
          id:       r.id,
          score:    s.score,
          label:    s.label,
          calls:    r.calls,
          paid:     r.paid_calls,
          payment_rate: `${Math.round(r.paid_calls / Math.max(1, r.calls) * 100)}%`,
          since:    new Date(r.first_seen * 1000).toISOString(),
        }
      }),
    }

    sendWithProof(res, out)
  })

  // 30-day score history — paid
  app.get('/reputation/:id/history', requireDetail, (req, res) => {
    const id    = req.params.id.trim()
    const since = Math.floor(Date.now() / 1000) - 30 * 86400
    const rows  = stmtHistory.all(id, id, since)

    if (!rows.length) return res.status(404).json({ error: 'No activity found in the last 30 days.' })

    // Compute running score for each day
    let cumTotal = 0, cumPaid = 0, firstSeen = rows[0].day_ts, maxEndpoints = 0
    const history = rows.map(r => {
      cumTotal    += r.total
      cumPaid     += r.paid
      maxEndpoints = Math.max(maxEndpoints, r.endpoints)
      const s = score({
        total_calls:        cumTotal,
        paid_calls:         cumPaid,
        distinct_endpoints: maxEndpoints,
        first_seen:         firstSeen,
        last_seen:          r.day_ts,
      })
      return {
        date:       new Date(r.day_ts * 1000).toISOString().slice(0, 10),
        score:      s.score,
        label:      s.label,
        calls:      r.total,
        paid_calls: r.paid,
      }
    })

    const first = history[0].score
    const last  = history[history.length - 1].score
    const trend = last > first ? 'rising' : last < first ? 'falling' : 'stable'

    res.json({
      id,
      period:   'last_30_days',
      trend,
      score_start: first,
      score_end:   last,
      delta:       last - first,
      history,
    })
  })

  // Paid detail endpoint — timeline, model usage, payment breakdown, risk signals, comparison to network avg
  app.get('/reputation/:id/detail', requireDetail, (req, res) => {
    const id    = req.params.id.trim()
    const stats = fetchStats(id)

    if (stats.total_calls === 0 || stats.first_seen === Infinity) {
      return res.status(404).json({ error: 'No activity found for this identifier.' })
    }

    const result    = score(stats)
    const timeline  = stmtTimeline.all(id, id)
    const models    = stmtModelUsage.all(id, id)
    const payments  = stmtPaymentMethods.all(id, id)
    const netAvg    = stmtNetworkAvg.get()
    const payRate   = stats.total_calls > 0 ? stats.paid_calls / stats.total_calls * 100 : 0

    const riskSignals = []
    if (payRate < 10 && stats.total_calls > 5) riskSignals.push('Low payment rate — mostly unpaid calls')
    if (stats.distinct_endpoints < 2)           riskSignals.push('Single-endpoint usage — narrow activity pattern')
    if ((Math.floor(Date.now() / 1000) - stats.last_seen) > 30 * 86400) riskSignals.push('Inactive for 30+ days')

    const out = {
      id,
      score:  result.score,
      label:  result.label,
      vs_network: {
        your_payment_rate: `${Math.round(payRate)}%`,
        network_avg_rate:  netAvg?.avg_paid_pct != null ? `${Math.round(netAvg.avg_paid_pct)}%` : 'n/a',
        your_endpoints:    stats.distinct_endpoints,
        network_avg_endpoints: netAvg?.avg_endpoints != null ? Math.round(netAvg.avg_endpoints) : 'n/a',
      },
      payment_methods: payments.map(p => ({ type: p.payment_type, count: p.n })),
      model_usage:     models.map(m => ({ model: m.model, calls: m.calls })),
      risk_signals:    riskSignals,
      recent_activity: timeline.map(t => ({
        ts:         new Date(t.ts * 1000).toISOString(),
        endpoint:   t.endpoint,
        status:     t.status,
        paid:       !!t.payment_type,
        payment:    t.payment_type || null,
        model:      t.model || null,
        latency_ms: t.response_ms,
      })),
    }

    sendWithProof(res, out)
  })

  // SVG badge — embeddable en cualquier servicio
  app.get('/reputation/:id/badge', (req, res) => {
    const id    = req.params.id.trim()
    const stats = fetchStats(id)

    let s = 0, label = 'unknown'
    if (stats.total_calls > 0 && stats.first_seen !== Infinity) {
      const r = score(stats)
      s = r.score
      label = r.label
    }

    res.set('Content-Type', 'image/svg+xml')
      .set('Cache-Control', 'max-age=3600')
      .send(badge(s, label))
  })

  // Lista de los agentes con mayor reputación (público, top 20)
  app.get('/reputation', (_req, res) => {
    const top    = stmtLeaderboard.all()
    const out = {
      description: 'Top agents by reputation on the AIRadar network.',
      leaderboard: top.map(r => {
        const s = score(r)
        return {
          id:       r.id,
          score:    s.score,
          label:    s.label,
          payments: r.paid_calls,
          services: r.distinct_endpoints,
          since:    new Date(r.first_seen * 1000).toISOString(),
        }
      }),
      integrate:  'GET /reputation/:wallet_or_agent_id — free reputation lookup for any service',
      powered_by: 'https://airadar.fyi',
    }

    sendWithProof(res, out)
  })
}
