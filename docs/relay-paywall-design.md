# Relay paywall — design (monetización de relay.airadar.fyi)

Estado: DISEÑO. Nada desplegado. Requiere OK antes de tocar el VPS.

## Objetivo
Cobrar sats a pubkeys externas por publicar **anuncios** en el relay strfry
(`relay.airadar.fyi`). Modelo **admisión**: pagas una vez → tu pubkey queda en
una allowlist 30 días → escribes libre hasta que caduca.

## Contexto verificado (2026-06-21)
- strfry v1-7984f80, bind `127.0.0.1:7777`, tras nginx.
- **No hay writePolicy plugin** configurado → relay abierto.
- NIP-11 no anuncia pago (sin `payment_required`).
- DB de la app: `providers.db` (better-sqlite3) en `/root/routstr-service/`.
- App Express (entry `index.js`), Lightning vía Alby NWC, patrón `/pay` ya existe.
- Pubkey AIRadar (SIEMPRE libre): `23ec964f9161e41a7a633463e0c49391f052bfc3acfbadfbc636ef494792c14e`.

## Parámetros
- `RELAY_ADMISSION_SATS = 100`  (escala coherente con marketplace 50 sats/30d; barato a propósito = filtro Sybil, no ingreso)
- `RELAY_ADMISSION_DAYS = 30`
- Kinds gateados: **38421** (provider announcements) y **30421** (attestations).
- Todo lo demás (lectura, kind 1, coordinación, efímeros) = libre.

## Pieza 1 — Tabla allowlist (`providers.db`)
```sql
CREATE TABLE IF NOT EXISTS relay_admissions (
  pubkey       TEXT PRIMARY KEY,   -- 32-byte hex nostr pubkey
  paid_at      INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  payment_hash TEXT,
  amount_sats  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_relay_adm_exp ON relay_admissions(expires_at);
```
Tabla pending de invoices: se reutiliza la `invoices` existente, o una columna/
prefijo que marque que el invoice es de admisión y a qué pubkey aplica.

## Pieza 2 — Endpoint de pago (`src/relay-paywall.js`, wired en server.js)
Dos pasos (Lightning es asíncrono), reutiliza NWC + patrón `/pay`:

1. `GET /relay/admission?pubkey=<hex>`
   - valida pubkey (64-hex), genera invoice Lightning (NWC makeInvoice, 100 sats),
     guarda pending {payment_hash → pubkey}, devuelve `{ invoice, payment_hash,
     amount_sats:100, days:30 }` (+ QR como en `/pay`).
2. `GET /relay/admission/status?payment_hash=<h>`
   - NWC lookupInvoice; si settled y no aplicado aún →
     `UPSERT relay_admissions(pubkey, paid_at=now, expires_at=now+30d, ...)`.
   - devuelve `{ paid:true, expires_at }`.

Página/hint humano en `GET /relay` para el `payments_url` del NIP-11.

## Pieza 3 — Plugin de write policy (`scripts/relay-write-policy.mjs`)
Protocolo strfry: proceso de larga vida; por cada evento recibe una línea JSON
en stdin `{"type":"new","event":{...},...}` y responde una línea
`{"id":"<event.id>","action":"accept|reject|shadowReject","msg":"..."}`.

Lógica:
```
loop sobre líneas de stdin:
  ev = msg.event
  if ev.pubkey === AIRADAR_PUBKEY:            accept   // footgun guard
  else if ev.kind not in {38421,30421}:       accept   // solo gateamos anuncios
  else:
     row = SELECT 1 FROM relay_admissions WHERE pubkey=ev.pubkey AND expires_at>now
     if row: accept
     else:   reject "blocked: pay 100 sats at https://airadar.fyi/relay to publish announcements"
```
- Abre `providers.db` en **readonly** una vez al arrancar; lookup por PK = rápido.
- strfry valida la FIRMA del evento ANTES del policy → `ev.pubkey` es de fiar
  (no hace falta NIP-42 AUTH).
- **Fail-open**: ante error de parseo/DB → accept + log. Un fallo transitorio NO
  debe tumbar el relay ni rechazar a un pagador legítimo. (AIRadar nunca se
  bloquea: su check es por pubkey, no toca la DB.)
- Necesita shebang `#!/usr/bin/env node` + `chmod +x`, o wrapper `.sh`.

## Pieza 4 — strfry.conf (CAMBIO EN PRODUCCIÓN — requiere OK)
```
relay {
    writePolicy {
        plugin = "/root/routstr-service/scripts/relay-write-policy.mjs"
    }
}
```
Luego `systemctl restart strfry`. Reversible al instante: quitar la línea + restart.

## Pieza 5 — NIP-11 (anunciar pago)
Añadir `limitation.payment_required=true` + `payments_url="https://airadar.fyi/relay"`.
**A VERIFICAR en implementación:** si strfry.conf permite estos campos custom en
`relay.info`; si no, fallback = nginx sirve un NIP-11 propio para
`Accept: application/nostr+json`. (No lo afirmo aún — hay que comprobarlo.)

## Plan de pruebas ANTES de tocar el relay vivo
1. Test del plugin offline: pipe de eventos de muestra y assert:
   - pubkey AIRadar → accept
   - kind 1 de pubkey random → accept
   - kind 38421 de pubkey NO pagada → reject
   - kind 38421 de pubkey pagada (fila en tabla) → accept
2. Solo tras pasar (1): configurar strfry.conf + restart, y **verificar que las
   attestations propias de AIRadar siguen publicando** (el footgun).

## Riesgos / decisiones abiertas
- **Gancho real:** "pagar por escribir aquí" tiene poco valor si el provider se
  anuncia gratis en otro relay y AIRadar igual lo indexa. Fast-follow recomendado:
  ligar admisión de relay a inclusión/prioridad en el directorio. No bloquea el MVP.
- NIP-11 custom fields en strfry (pieza 5) — verificar.
- Política fail-open deja pasar no-pagadores ante error de DB (aceptado para MVP).
