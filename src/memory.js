import db from './db.js'

const stmtGet    = db.prepare('SELECT value, updated_at FROM memory WHERE agent_id = ? AND key = ?')
const stmtList   = db.prepare('SELECT key, updated_at FROM memory WHERE agent_id = ? ORDER BY key')
const stmtUpsert = db.prepare(`
  INSERT INTO memory (agent_id, key, value, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(agent_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`)
const stmtDelete = db.prepare('DELETE FROM memory WHERE agent_id = ? AND key = ?')

export function registerMemoryRoutes(app, requireMemWrite, requireMemRead) {
  // List all keys for an agent_id
  app.get('/memory/:agent_id', requireMemRead, (req, res) => {
    const rows = stmtList.all(req.params.agent_id)
    res.json({ agent_id: req.params.agent_id, count: rows.length, keys: rows })
  })

  // Read a single value
  app.get('/memory/:agent_id/:key', requireMemRead, (req, res) => {
    const row = stmtGet.get(req.params.agent_id, req.params.key)
    if (!row) return res.status(404).json({ error: 'Key not found' })
    res.json({
      agent_id:   req.params.agent_id,
      key:        req.params.key,
      value:      row.value,
      updated_at: new Date(row.updated_at * 1000).toISOString(),
    })
  })

  // Write or update a value
  app.put('/memory/:agent_id/:key', requireMemWrite, (req, res) => {
    const { value } = req.body || {}
    if (value === undefined) return res.status(400).json({ error: 'Missing "value" in request body' })
    stmtUpsert.run(req.params.agent_id, req.params.key, String(value), Math.floor(Date.now() / 1000))
    res.json({ ok: true, agent_id: req.params.agent_id, key: req.params.key })
  })

  // Delete a key
  app.delete('/memory/:agent_id/:key', requireMemWrite, (req, res) => {
    stmtDelete.run(req.params.agent_id, req.params.key)
    res.json({ ok: true })
  })
}
