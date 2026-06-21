import db from './db.js'

const DAY  = 86400
const WEEK = 7 * 86400

function since(s) { return Math.floor(Date.now() / 1000) - s }

const stmtSummary = db.prepare(`
  SELECT COUNT(*)                                                        AS total_requests,
         SUM(CASE WHEN payment_type IS NOT NULL THEN 1 ELSE 0 END)      AS paid_requests,
         COUNT(DISTINCT wallet_address)                                  AS unique_wallets,
         COUNT(DISTINCT ip_hash)                                         AS unique_agents,
         COUNT(DISTINCT model)                                           AS distinct_models,
         AVG(response_ms)                                                AS avg_latency_ms
  FROM request_log WHERE ts > ?
`)

const stmtTrendingModels = db.prepare(`
  SELECT model,
         COUNT(*)                                                        AS calls,
         SUM(CASE WHEN status = 200 THEN 1 ELSE 0 END)                  AS success,
         AVG(response_ms)                                                AS avg_ms
  FROM request_log
  WHERE ts > ? AND model IS NOT NULL
  GROUP BY model ORDER BY calls DESC LIMIT 20
`)

const stmtProviderReliability = db.prepare(`
  SELECT name, network, is_online, response_ms,
         uptime_ok_24h, uptime_total_24h,
         CAST(uptime_ok_24h AS REAL) / MAX(uptime_total_24h, 1) * 100 AS uptime_pct
  FROM providers
  WHERE is_online IS NOT NULL
  ORDER BY uptime_pct DESC, response_ms ASC
  LIMIT 30
`)

const stmtEndpointLatencies = db.prepare(`
  SELECT endpoint, COUNT(*) AS calls,
         AVG(response_ms) AS avg_ms,
         MIN(response_ms) AS min_ms,
         MAX(response_ms) AS max_ms
  FROM request_log
  WHERE ts > ? AND status = 200 AND response_ms IS NOT NULL
  GROUP BY endpoint HAVING calls >= 5
  ORDER BY calls DESC LIMIT 15
`)

const stmtPayVolume = db.prepare(`
  SELECT payment_type, COUNT(*) AS n, DATE(ts, 'unixepoch') AS day
  FROM request_log
  WHERE ts > ? AND payment_type IS NOT NULL
  GROUP BY payment_type, day ORDER BY day DESC
`)

const stmtErrorRates = db.prepare(`
  SELECT endpoint,
         COUNT(*) AS total,
         SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS errors,
         SUM(CASE WHEN status = 402 THEN 1 ELSE 0 END)  AS unpaid
  FROM request_log WHERE ts > ?
  GROUP BY endpoint HAVING total >= 10
  ORDER BY errors DESC LIMIT 10
`)

export function registerIntelligenceRoutes(app, requirePayment) {
  app.get('/intelligence', requirePayment, (_req, res) => {
    const day  = since(DAY)
    const week = since(WEEK)

    const summary   = stmtSummary.get(day)
    const models    = stmtTrendingModels.all(day)
    const providers = stmtProviderReliability.all()
    const latencies = stmtEndpointLatencies.all(day)
    const errors    = stmtErrorRates.all(day)
    const payRaw    = stmtPayVolume.all(week)

    const payByDay = {}
    for (const r of payRaw) {
      if (!payByDay[r.day]) payByDay[r.day] = { l402: 0, x402: 0 }
      payByDay[r.day][r.payment_type] = (payByDay[r.day][r.payment_type] || 0) + r.n
    }

    res.json({
      period: 'last_24h',
      generated_at: new Date().toISOString(),
      network_summary: {
        total_requests:  summary.total_requests,
        paid_requests:   summary.paid_requests,
        payment_rate:    summary.total_requests > 0
          ? `${Math.round(summary.paid_requests / summary.total_requests * 100)}%` : '0%',
        unique_wallets:  summary.unique_wallets,
        unique_agents:   summary.unique_agents,
        distinct_models_used: summary.distinct_models,
        avg_latency_ms:  Math.round(summary.avg_latency_ms || 0),
      },
      trending_models: models.map(m => ({
        model:          m.model,
        calls_24h:      m.calls,
        success_rate:   m.calls > 0 ? `${Math.round(m.success / m.calls * 100)}%` : '0%',
        avg_latency_ms: Math.round(m.avg_ms || 0),
      })),
      provider_reliability: providers.map(p => ({
        name:       p.name,
        network:    p.network,
        online:     !!p.is_online,
        uptime_24h: `${Math.round(p.uptime_pct || 0)}%`,
        latency_ms: p.response_ms || null,
      })),
      endpoint_performance: latencies.map(l => ({
        endpoint: l.endpoint,
        calls_24h: l.calls,
        avg_ms:    Math.round(l.avg_ms),
        min_ms:    l.min_ms,
        max_ms:    l.max_ms,
      })),
      error_hotspots: errors.map(e => ({
        endpoint:   e.endpoint,
        total:      e.total,
        errors:     e.errors,
        unpaid_402: e.unpaid,
        error_rate: e.total > 0 ? `${(e.errors / e.total * 100).toFixed(1)}%` : '0%',
      })),
      payment_volume_7d: Object.entries(payByDay)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, counts]) => ({ day, l402: counts.l402 || 0, x402: counts.x402 || 0 })),
    })
  })
}
