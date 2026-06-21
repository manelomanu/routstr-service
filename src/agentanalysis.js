import db from './db.js'

// ── Timing signals ─────────────────────────────────────────────────────────
const stmtTimestamps = db.prepare(`
  SELECT ts FROM request_log
  WHERE (wallet_address = ? OR agent_id = ?)
  ORDER BY ts ASC
`)

function botScore(timestamps) {
  if (timestamps.length < 5) return { score: 0, verdict: 'insufficient_data', cv: null }
  const deltas = []
  for (let i = 1; i < timestamps.length; i++) {
    deltas.push(timestamps[i] - timestamps[i - 1])
  }
  const mean   = deltas.reduce((a, b) => a + b, 0) / deltas.length
  const stddev = Math.sqrt(deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / deltas.length)
  const cv     = mean > 0 ? stddev / mean : 999

  // Low CV = metronomic = bot. Humans are bursty (high CV)
  const score = cv < 0.10 ? 90
              : cv < 0.20 ? 70
              : cv < 0.40 ? 40
              : 10

  return {
    score,
    verdict:       score >= 70 ? 'likely_bot' : score >= 40 ? 'possibly_automated' : 'human_like',
    cv:            Math.round(cv * 100) / 100,
    avg_interval_s: Math.round(mean),
    calls_analyzed: timestamps.length,
  }
}

// ── Coordination detection ─────────────────────────────────────────────────
const stmtSharedIp = db.prepare(`
  SELECT r2.wallet_address, COUNT(*) AS shared_calls,
         MIN(r2.ts) AS first_overlap, MAX(r2.ts) AS last_overlap
  FROM request_log r2
  WHERE r2.ip_hash IN (
    SELECT DISTINCT ip_hash FROM request_log
    WHERE (wallet_address = ? OR agent_id = ?) AND ip_hash IS NOT NULL
  )
  AND r2.wallet_address != ? AND r2.wallet_address IS NOT NULL
  GROUP BY r2.wallet_address
  ORDER BY shared_calls DESC
  LIMIT 10
`)

// ── Fingerprint clustering (same user_agent → likely same entity) ──────────
const stmtSharedAgent = db.prepare(`
  SELECT r2.wallet_address, COUNT(*) AS n
  FROM request_log r2
  WHERE r2.user_agent IN (
    SELECT DISTINCT user_agent FROM request_log
    WHERE (wallet_address = ? OR agent_id = ?) AND user_agent IS NOT NULL AND user_agent != ''
  )
  AND r2.wallet_address != ? AND r2.wallet_address IS NOT NULL
  GROUP BY r2.wallet_address
  ORDER BY n DESC
  LIMIT 10
`)

// ── Volume anomaly ─────────────────────────────────────────────────────────
const stmtVolume = db.prepare(`
  SELECT
    SUM(CASE WHEN ts > ? - 3600  THEN 1 ELSE 0 END) AS last_hour,
    SUM(CASE WHEN ts > ? - 86400 THEN 1 ELSE 0 END) AS last_day,
    COUNT(*) AS total_7d
  FROM request_log
  WHERE (wallet_address = ? OR agent_id = ?) AND ts > ? - 604800
`)

const stmtHourlyBaseline = db.prepare(`
  SELECT CAST((ts / 3600) AS INTEGER) AS hour_bucket, COUNT(*) AS n
  FROM request_log
  WHERE (wallet_address = ? OR agent_id = ?) AND ts > ? - 604800
  GROUP BY hour_bucket ORDER BY hour_bucket
`)

function anomalyScore(lastHour, baseline) {
  if (!baseline.length) return { score: 0, verdict: 'no_baseline' }
  const avg = baseline.reduce((a, b) => a + b.n, 0) / baseline.length
  const stddev = Math.sqrt(baseline.reduce((a, b) => a + (b.n - avg) ** 2, 0) / baseline.length)
  const zscore = stddev > 0 ? (lastHour - avg) / stddev : 0

  return {
    score:         Math.min(100, Math.round(Math.max(0, zscore) * 20)),
    verdict:       zscore > 3 ? 'spike_detected' : zscore > 1.5 ? 'elevated' : 'normal',
    last_hour:     lastHour,
    hourly_avg_7d: Math.round(avg * 10) / 10,
    z_score:       Math.round(zscore * 10) / 10,
  }
}

// ── Endpoint call pattern ──────────────────────────────────────────────────
const stmtCallPattern = db.prepare(`
  SELECT endpoint, COUNT(*) AS calls,
         SUM(CASE WHEN payment_type IS NOT NULL THEN 1 ELSE 0 END) AS paid
  FROM request_log
  WHERE wallet_address = ? OR agent_id = ?
  GROUP BY endpoint ORDER BY calls DESC LIMIT 12
`)

// ── Main route ─────────────────────────────────────────────────────────────
export function registerChainAnalysisRoutes(app, requirePayment) {

  app.get('/agentanalysis/:id', requirePayment, (req, res) => {
    const id  = req.params.id.trim().slice(0, 200)
    const now = Math.floor(Date.now() / 1000)

    // Basic existence check
    const timestamps   = stmtTimestamps.all(id, id).map(r => r.ts)
    if (!timestamps.length) return res.status(404).json({ error: 'No activity found for this identifier.' })

    const bot          = botScore(timestamps)
    const coordRaw     = stmtSharedIp.all(id, id, id)
    const fingerprintRaw = stmtSharedAgent.all(id, id, id)
    const vol          = stmtVolume.get(now, now, id, id, now)
    const baseline     = stmtHourlyBaseline.all(id, id, now)
    const anomaly      = anomalyScore(vol?.last_hour || 0, baseline)
    const callPattern  = stmtCallPattern.all(id, id)

    // Risk: bot(35%) + coordination(30%) + anomaly(20%) + fingerprint(15%) = 100%
    const riskScore = Math.round(
      bot.score                                * 0.35 +
      Math.min(100, coordRaw.length * 15)      * 0.30 +
      anomaly.score                            * 0.20 +
      Math.min(100, fingerprintRaw.length * 20) * 0.15
    )

    const riskLabel = riskScore >= 70 ? 'high'
                    : riskScore >= 40 ? 'medium'
                    : 'low'

    res.json({
      id,
      analyzed_at: new Date().toISOString(),
      risk: {
        score: riskScore,
        label: riskLabel,
        summary: riskLabel === 'high'
          ? 'Multiple signals suggest automated/coordinated behavior. Verify before accepting payments.'
          : riskLabel === 'medium'
          ? 'Some signals of automation or coordination. Monitor closely.'
          : 'Behavior appears consistent with a legitimate human or well-behaved agent.',
      },
      signals: {
        bot_detection: bot,
        coordination: {
          shared_ip_wallets: coordRaw.length,
          verdict: coordRaw.length >= 3 ? 'coordinated_cluster'
                 : coordRaw.length >= 1 ? 'possible_coordination'
                 : 'none_detected',
          related_wallets: coordRaw.map(r => ({
            // Never expose ip_hash — only the fact of sharing
            wallet:       r.wallet_address,
            shared_calls: r.shared_calls,
            overlap_period: {
              from: new Date(r.first_overlap * 1000).toISOString(),
              to:   new Date(r.last_overlap  * 1000).toISOString(),
            },
          })),
        },
        fingerprint: {
          linked_wallets: fingerprintRaw.length,
          verdict: fingerprintRaw.length >= 2 ? 'same_entity_likely'
                 : fingerprintRaw.length === 1 ? 'possible_link'
                 : 'unique',
          linked: fingerprintRaw.map(r => ({ wallet: r.wallet_address, shared_calls: r.n })),
        },
        volume_anomaly: anomaly,
      },
      behavior: {
        total_calls:  timestamps.length,
        first_seen:   new Date(timestamps[0]      * 1000).toISOString(),
        last_seen:    new Date(timestamps[timestamps.length - 1] * 1000).toISOString(),
        calls_last_24h: vol?.last_day || 0,
        top_endpoints: callPattern.map(r => ({
          endpoint:    r.endpoint,
          calls:       r.calls,
          paid_rate:   `${Math.round(r.paid / r.calls * 100)}%`,
        })),
      },
    })
  })
}
