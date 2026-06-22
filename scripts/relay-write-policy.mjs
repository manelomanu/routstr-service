#!/usr/bin/env node
/**
 * strfry write-policy plugin — relay paywall (admisión por sats).
 *
 * Protocolo strfry: proceso de larga vida. Por cada evento entrante recibe una
 * línea JSON en stdin {"type":"new","event":{...},...} y debe responder una
 * línea JSON {"id":"<event.id>","action":"accept|reject|shadowReject","msg":""}.
 *
 * Política:
 *   - pubkey del owner (AIRadar)         -> accept   (footgun guard, nunca se bloquea)
 *   - kind NO en GATED_KINDS             -> accept   (lectura/coordinación libres)
 *   - kind gateado + pubkey pagada+vigente -> accept
 *   - kind gateado + no pagada           -> reject (aviso de pago)
 *
 * Fail-open: ante cualquier error de DB/parseo se ACEPTA y se loguea a stderr.
 * Un fallo transitorio no debe tumbar el relay ni rechazar a un pagador legítimo.
 *
 * Config por env:
 *   RELAY_DB_PATH       (default: ../providers.db junto a este script)
 *   RELAY_OWNER_PUBKEY  (default: pubkey AIRadar)
 *
 * Test offline (sin strfry):
 *   printf '%s\n' '<json>' | RELAY_DB_PATH=/tmp/test.db node scripts/relay-write-policy.mjs
 */

import { createInterface } from 'readline'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import Database from 'better-sqlite3'

const __dir = dirname(fileURLToPath(import.meta.url))

const DB_PATH = process.env.RELAY_DB_PATH || resolve(__dir, '../providers.db')
const OWNER_PUBKEY = (process.env.RELAY_OWNER_PUBKEY ||
  '23ec964f9161e41a7a633463e0c49391f052bfc3acfbadfbc636ef494792c14e').toLowerCase()
const GATED_KINDS = new Set([38421, 30421])

// ── DB (readonly, abierta una vez) ──────────────────────────────────────────
let lookup = null
try {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  lookup = db.prepare(
    'SELECT 1 AS ok FROM relay_admissions WHERE pubkey = ? AND expires_at > ? LIMIT 1'
  )
} catch (e) {
  // Sin DB/tabla: fail-open. Logueamos una vez al arrancar.
  console.error(`[relay-policy] DB no disponible (${DB_PATH}): ${e.message} — fail-open`)
}

// ── Decisión ────────────────────────────────────────────────────────────────
function decide(event) {
  if (!event || typeof event.pubkey !== 'string') return { action: 'accept', msg: '' }

  if (event.pubkey.toLowerCase() === OWNER_PUBKEY) return { action: 'accept', msg: '' }
  if (!GATED_KINDS.has(event.kind))               return { action: 'accept', msg: '' }

  // kind gateado de pubkey externa: requiere admisión vigente
  if (!lookup) return { action: 'accept', msg: '' } // fail-open: sin DB no bloqueamos
  try {
    const now = Math.floor(Date.now() / 1000)
    const row = lookup.get(event.pubkey.toLowerCase(), now)
    if (row) return { action: 'accept', msg: '' }
    return {
      action: 'reject',
      msg: 'blocked: pay 100 sats at https://airadar.fyi/relay to publish announcements (30 days)',
    }
  } catch (e) {
    console.error(`[relay-policy] lookup error: ${e.message} — fail-open`)
    return { action: 'accept', msg: '' }
  }
}

// ── Loop stdin → stdout ─────────────────────────────────────────────────────
const rl = createInterface({ input: process.stdin })

rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return // sin id no podemos responder; descartamos línea inválida
  }
  if (msg.type !== 'new' || !msg.event) return

  const { action, msg: reason } = decide(msg.event)
  process.stdout.write(JSON.stringify({ id: msg.event.id, action, msg: reason }) + '\n')
})
