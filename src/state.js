import db from './db.js'

const stmtGetCounter = db.prepare('SELECT value FROM counters WHERE agent_id = ? AND name = ?')
const stmtDelta      = db.prepare(`
  INSERT INTO counters (agent_id, name, value, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(agent_id, name) DO UPDATE SET value = value + excluded.value, updated_at = excluded.updated_at
`)
const stmtLogInsert  = db.prepare('INSERT INTO agent_log (agent_id, event, data, created_at) VALUES (?, ?, ?, ?)')
const stmtLogRead    = db.prepare('SELECT id, event, data, created_at FROM agent_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?')
const stmtQueueAdd   = db.prepare('INSERT INTO job_queue (type, payload, status, created_at) VALUES (?, ?, ?, ?)')
const stmtQueueGet   = db.prepare('SELECT * FROM job_queue WHERE id = ?')

export function registerStateRoutes(app, { req1, req2 }) {

  // ── Counters ────────────────────────────────────────────────────────────────
  app.get('/state/counter/:agent_id/:name', req1, (req, res) => {
    const { agent_id, name } = req.params
    const row = stmtGetCounter.get(agent_id, name)
    res.json({ agent_id, name, value: row?.value ?? 0 })
  })

  app.post('/state/counter/:agent_id/:name/increment', req1, (req, res) => {
    const { agent_id, name } = req.params
    const parsed = parseInt(req.body?.by)
    const by = (!isNaN(parsed) && parsed > 0) ? parsed : 1
    stmtDelta.run(agent_id, name, by, Math.floor(Date.now() / 1000))
    const row = stmtGetCounter.get(agent_id, name)
    res.json({ agent_id, name, value: row?.value ?? by })
  })

  app.post('/state/counter/:agent_id/:name/decrement', req1, (req, res) => {
    const { agent_id, name } = req.params
    const parsed = parseInt(req.body?.by)
    const by = (!isNaN(parsed) && parsed > 0) ? parsed : 1
    stmtDelta.run(agent_id, name, -by, Math.floor(Date.now() / 1000))
    const row = stmtGetCounter.get(agent_id, name)
    res.json({ agent_id, name, value: row?.value ?? -by })
  })

  // ── Event log ───────────────────────────────────────────────────────────────
  app.post('/state/log/:agent_id', req1, (req, res) => {
    const { agent_id } = req.params
    const { event, data } = req.body || {}
    if (!event) return res.status(400).json({ error: 'Missing "event"' })
    const now = Math.floor(Date.now() / 1000)
    const result = stmtLogInsert.run(agent_id, event, data ? JSON.stringify(data) : null, now)
    res.json({ ok: true, id: result.lastInsertRowid, agent_id, event, created_at: now })
  })

  app.get('/state/log/:agent_id', req2, (req, res) => {
    const { agent_id } = req.params
    const limit = Math.min(parseInt(req.query.limit || 50), 500)
    const rows = stmtLogRead.all(agent_id, limit)
    res.json({
      agent_id,
      count: rows.length,
      entries: rows.map(r => ({
        id:         r.id,
        event:      r.event,
        data:       r.data ? (() => { try { return JSON.parse(r.data) } catch { return r.data } })() : null,
        created_at: new Date(r.created_at * 1000).toISOString(),
      })),
    })
  })

  // ── Job queue ───────────────────────────────────────────────────────────────
  app.post('/state/queue', req2, (req, res) => {
    const { type, payload } = req.body || {}
    if (!type) return res.status(400).json({ error: 'Missing "type"' })
    const now = Math.floor(Date.now() / 1000)
    const r   = stmtQueueAdd.run(type, payload ? JSON.stringify(payload) : null, 'pending', now)
    res.json({ ok: true, job_id: r.lastInsertRowid, type, status: 'pending', created_at: now })
  })

  app.get('/state/queue/:job_id', req1, (req, res) => {
    const row = stmtQueueGet.get(req.params.job_id)
    if (!row) return res.status(404).json({ error: 'Job not found' })
    res.json({
      job_id:       row.id,
      type:         row.type,
      status:       row.status,
      payload:      row.payload ? (() => { try { return JSON.parse(row.payload) } catch { return row.payload } })() : null,
      result:       row.result  ? (() => { try { return JSON.parse(row.result)  } catch { return row.result  } })() : null,
      created_at:   new Date(row.created_at  * 1000).toISOString(),
      completed_at: row.completed_at ? new Date(row.completed_at * 1000).toISOString() : null,
    })
  })
}
