import db from './db.js'

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

// ── Routes ────────────────────────────────────────────────────────────────────
export function registerReputationRoutes(app) {

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

    res.json({
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
    })
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
    const top = stmtLeaderboard.all()

    res.json({
      description:  'Top agents by reputation on the AIRadar network.',
      leaderboard:  top.map(r => {
        const s = score(r)
        return {
          id:        r.id,
          score:     s.score,
          label:     s.label,
          payments:  r.paid_calls,
          services:  r.distinct_endpoints,
          since:     new Date(r.first_seen * 1000).toISOString(),
        }
      }),
      integrate: 'GET /reputation/:wallet_or_agent_id — free reputation lookup for any service',
      powered_by: 'https://airadar.fyi',
    })
  })
}
