import { createHash, randomUUID } from 'crypto'
import { encode } from 'gpt-tokenizer'
import QRCode from 'qrcode'
import tls from 'tls'
import net from 'net'

// ── Token counter ─────────────────────────────────────────────────────────────
export function countTokens(text) {
  const tokens = encode(text)
  return { token_count: tokens.length, char_count: text.length, words_approx: Math.round(tokens.length * 0.75) }
}

// ── QR code ───────────────────────────────────────────────────────────────────
export async function makeQr(data, size = 300) {
  const px = Math.min(Math.max(parseInt(size) || 300, 100), 1000)
  return QRCode.toBuffer(String(data), { width: px, margin: 2, type: 'png', errorCorrectionLevel: 'M' })
}

// ── Safe math eval ────────────────────────────────────────────────────────────
const MATH_RE = /^[\d\s+\-*/.^%(),a-zA-Z]+$/

export function evalMath(expr) {
  if (!MATH_RE.test(expr)) throw new Error('Expression contains invalid characters')
  // eslint-disable-next-line no-new-func
  const result = new Function('Math', `"use strict"; return (${expr})`)(Math)
  if (typeof result !== 'number' || !isFinite(result)) throw new Error('Expression produced a non-finite result')
  return { expression: expr, result }
}

// ── SSL cert info ─────────────────────────────────────────────────────────────
export function getSslInfo(hostname) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(443, hostname, { servername: hostname }, () => {
      const cert = socket.getPeerCertificate()
      socket.destroy()
      if (!cert?.subject) return reject(new Error('No certificate found'))
      resolve({
        hostname,
        subject:        cert.subject?.CN,
        issuer:         cert.issuer?.O,
        valid_from:     cert.valid_from,
        valid_to:       cert.valid_to,
        days_remaining: Math.floor((new Date(cert.valid_to) - Date.now()) / 86400000),
        san:            cert.subjectaltname || null,
      })
    })
    socket.on('error', reject)
    socket.setTimeout(8000, () => { socket.destroy(); reject(new Error('SSL timeout')) })
  })
}

// ── Port check ────────────────────────────────────────────────────────────────
export function checkPort(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let open = false
    socket.setTimeout(5000)
    socket.on('connect', () => { open = true; socket.destroy() })
    socket.on('close',   () => resolve({ host, port: Number(port), open }))
    socket.on('error',   () => resolve({ host, port: Number(port), open: false }))
    socket.on('timeout', () => { socket.destroy(); resolve({ host, port: Number(port), open: false }) })
    socket.connect(Number(port), host)
  })
}

// ── Hash ──────────────────────────────────────────────────────────────────────
const HASH_ALGOS = new Set(['md5', 'sha1', 'sha256', 'sha512'])

export function hashText(text, algo = 'sha256') {
  if (!HASH_ALGOS.has(algo)) throw new Error(`Unsupported algorithm. Valid: ${[...HASH_ALGOS].join(', ')}`)
  return { algorithm: algo, input_length: text.length, hash: createHash(algo).update(text).digest('hex') }
}

// ── UUID ──────────────────────────────────────────────────────────────────────
export function generateUuids(n = 1) {
  const count = Math.min(Math.max(parseInt(n) || 1, 1), 100)
  const uuids = Array.from({ length: count }, () => randomUUID())
  return count === 1 ? { uuid: uuids[0] } : { uuids, count }
}

// ── Base64 ────────────────────────────────────────────────────────────────────
export function base64Encode(text) {
  const buf = Buffer.from(text, 'utf8')
  return { encoded: buf.toString('base64'), url_safe: buf.toString('base64url') }
}

export function base64Decode(encoded) {
  const clean = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const decoded = Buffer.from(clean, 'base64').toString('utf8')
  return { decoded }
}

// ── Route registration ────────────────────────────────────────────────────────
export function registerComputeRoutes(app, { req1, req2 }) {

  app.post('/compute/tokens', req1, (req, res) => {
    const { text } = req.body || {}
    if (!text) return res.status(400).json({ error: 'Missing "text"' })
    try { res.json(countTokens(text)) }
    catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.get('/compute/qr', req2, async (req, res) => {
    const data = req.query.data || req.query.url
    if (!data) return res.status(400).json({ error: 'Missing ?data=' })
    try {
      const buf = await makeQr(data, req.query.size)
      res.set('Content-Type', 'image/png').send(buf)
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.get('/compute/math', req1, (req, res) => {
    if (!req.query.expr) return res.status(400).json({ error: 'Missing ?expr=' })
    try { res.json(evalMath(req.query.expr)) }
    catch (e) { res.status(400).json({ error: e.message }) }
  })

  app.get('/compute/ssl', req2, async (req, res) => {
    if (!req.query.domain) return res.status(400).json({ error: 'Missing ?domain=' })
    try { res.json(await getSslInfo(req.query.domain)) }
    catch (e) { res.status(502).json({ error: e.message }) }
  })

  app.get('/compute/port', req1, async (req, res) => {
    const { host, port } = req.query
    if (!host || !port) return res.status(400).json({ error: 'Missing ?host= or ?port=' })
    if (isNaN(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'Invalid port' })
    try { res.json(await checkPort(host, port)) }
    catch (e) { res.status(502).json({ error: e.message }) }
  })

  app.get('/compute/hash', req1, (req, res) => {
    const { text, algo = 'sha256' } = req.query
    if (!text) return res.status(400).json({ error: 'Missing ?text=' })
    try { res.json(hashText(text, algo)) }
    catch (e) { res.status(400).json({ error: e.message }) }
  })

  app.get('/compute/uuid', req1, (req, res) => {
    res.json(generateUuids(req.query.n))
  })

  app.get('/compute/base64', req1, (req, res) => {
    const { action = 'encode', data } = req.query
    if (!data) return res.status(400).json({ error: 'Missing ?data=' })
    try { res.json(action === 'decode' ? base64Decode(data) : base64Encode(data)) }
    catch (e) { res.status(400).json({ error: e.message }) }
  })
}
