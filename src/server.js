import express from 'express'
import { NWCClient } from '@getalby/sdk'
import { facilitator, decodePaymentSignatureHeader, encodePaymentRequiredHeader } from './x402.js'
import db from './db.js'
import { registerMcpRoutes, setJsonMiddleware } from './mcp.js'
import { registerGatewayRoutes } from './gateway.js'

const app = express()
const jsonMiddleware = express.json()
app.use(jsonMiddleware)
setJsonMiddleware(jsonMiddleware)
const PRICE_SATS = parseInt(process.env.PRICE_SATS || '10')
const PORT = parseInt(process.env.PORT || '3000')

const EVM_ADDRESS = '0x7698672ceE929D3f0fA3c773111b4D6b0095aa1A'
const SOL_ADDRESS = 'AP8Q9QaYQ1etKFuUVQdd8RpGCWYH4QLDREfnd76KJX3m'
const PRICE_USDC  = '10000' // $0.01 in USDC micro-units (6 decimals)

const X402_REQUIREMENTS = [
  { scheme: 'exact', network: 'base',           maxAmountRequired: PRICE_USDC, resource: 'https://airadar.fyi/providers', description: 'AIRadar — AI provider directory', mimeType: 'application/json', payTo: EVM_ADDRESS, maxTimeoutSeconds: 300, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',         extra: { name: 'USD Coin', version: '2' } },
  { scheme: 'exact', network: 'polygon',        maxAmountRequired: PRICE_USDC, resource: 'https://airadar.fyi/providers', description: 'AIRadar — AI provider directory', mimeType: 'application/json', payTo: EVM_ADDRESS, maxTimeoutSeconds: 300, asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',         extra: { name: 'USD Coin', version: '2' } },
  { scheme: 'exact', network: 'eip155:42161',   maxAmountRequired: PRICE_USDC, resource: 'https://airadar.fyi/providers', description: 'AIRadar — AI provider directory', mimeType: 'application/json', payTo: EVM_ADDRESS, maxTimeoutSeconds: 300, asset: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',         extra: { name: 'USD Coin', version: '2' } },
  { scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', maxAmountRequired: PRICE_USDC, resource: 'https://airadar.fyi/providers', description: 'AIRadar — AI provider directory', mimeType: 'application/json', payTo: SOL_ADDRESS, maxTimeoutSeconds: 300, asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', extra: {} },
]

let nwcClient

export function initServer() {
  nwcClient = new NWCClient({
    nostrWalletConnectUrl: process.env.NWC_SECRET,
  })

  app.get('/info', (_req, res) => {
    res.json({
      name: 'AIRadar — AI Provider Directory',
      url: 'https://airadar.fyi',
      description: 'Real-time directory of AI inference providers on the Routstr/Nostr decentralized network. Find which providers are online, what models they offer, their speed and pricing. Pay per query — no registration, no API key, no subscription.',
      version: '2.0.0',
      endpoints: {
        'POST /v1/chat/completions': {
          description: 'AI inference gateway — OpenAI-compatible. Pay per call in sats (L402/Lightning). No API key needed. Supports 337+ models via OpenRouter.',
          auth: 'pay-per-use',
          pricing_tiers: {
            free:   { sats: 50,   models: 'Free/open models (Llama, Mistral, etc.)' },
            small:  { sats: 150,  models: 'Small paid models' },
            medium: { sats: 400,  models: 'Mid-tier models (GPT-4o mini, Claude Haiku)' },
            large:  { sats: 1000, models: 'Frontier models (GPT-4o, Claude Sonnet+)' },
          },
          how_to_pay: [
            '1. POST /v1/chat/completions with standard OpenAI body — receive 402 with Lightning invoice.',
            '2. Pay the invoice.',
            '3. Retry with header: Authorization: L402 <payment_hash>:<preimage>',
          ],
        },
        'GET /v1/models': {
          description: 'List all 337+ models available through the gateway with tier pricing in sats.',
          auth: 'none',
        },
        'GET /info': {
          description: 'This document. Service metadata for AI agents.',
          auth: 'none',
        },
        'GET /health': {
          description: 'Service liveness check.',
          auth: 'none',
          returns: '{ status, price_sats, price_usdc }',
        },
        'GET /providers': {
          description: 'Full list of Routstr AI inference providers with models, pricing, uptime, mints and endpoint. Sorted by availability then speed.',
          auth: 'pay-per-use',
          payment_options: [
            {
              protocol: 'L402',
              asset: 'BTC',
              network: 'Lightning',
              amount: `${PRICE_SATS} sats`,
              how_to_pay: [
                '1. Call GET /providers — receive HTTP 402 with Lightning invoice in body and WWW-Authenticate header.',
                '2. Pay the invoice with any Lightning wallet (Phoenix, Alby, Wallet of Satoshi, etc.).',
                '3. Retry with header: Authorization: L402 <payment_hash>:<preimage>',
              ],
            },
            {
              protocol: 'x402',
              asset: 'USDC',
              networks: ['Base (eip155:8453)', 'Polygon (eip155:137)', 'Arbitrum (eip155:42161)', 'Solana'],
              amount: '$0.01 USDC',
              receive_address_evm: EVM_ADDRESS,
              receive_address_solana: SOL_ADDRESS,
              how_to_pay: [
                '1. Call GET /providers — receive HTTP 402 with X-PAYMENT-REQUIRED header (base64 JSON).',
                '2. Decode header, sign USDC transfer on your preferred network.',
                '3. Retry with header: X-PAYMENT: <base64-encoded-signed-payment-payload>',
                'Compatible with: Coinbase AgentKit, ElizaOS, Vercel AI SDK, @x402/fetch',
              ],
            },
          ],
        },
        'GET /free': {
          description: 'Free preview: top 3 online providers. No payment required.',
          auth: 'none',
        },
        'GET /providers/best': {
          description: 'Returns the single best provider for a given model. Designed for agents: one call, one answer.',
          auth: 'pay-per-use',
          params: { model: 'model ID (optional)', optimize: 'price (default) | speed | reliability' },
          returns: '{ best: { provider, model, endpoint, pricing, response_ms }, how_to_use, alternatives[] }',
        },
        'GET /providers/:pubkey': {
          description: 'Full detail for a single provider including all models.',
          auth: 'pay-per-use',
        },
        'GET /models': {
          description: 'List all models across all providers. Filter by ?id=<model-id> or ?modality=text|image|audio. Sorted by price ascending.',
          auth: 'pay-per-use',
          filters: ['id', 'modality'],
        },
        'POST /route': {
          description: 'Intelligent routing: send your requirements, receive the best provider + usage instructions.',
          auth: 'pay-per-use',
          body: { model_id: 'optional', modality: 'text|image|audio', max_price_sats_per_1k: 'number', min_context_length: 'number' },
        },
        'GET /mcp': {
          description: 'MCP server (SSE transport). Compatible with Claude, ElizaOS, and any MCP-compatible agent framework.',
          auth: 'none',
          tools: ['list_providers', 'find_model', 'route', 'compare_prices', 'run_inference'],
        },
      },
      data_source: {
        protocol: 'Nostr',
        event_kind: 38421,
        description: 'Routstr Provider Announcements (NIP-91)',
        relays: ['wss://relay.routstr.com', 'wss://relay.nostr.band', 'wss://relay.damus.io', 'wss://nos.lol'],
      },
      payment_protocols: [
        'L402 — https://docs.lightning.engineering/the-lightning-network/l402',
        'x402 — https://x402.org',
      ],
    })
  })

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', price_sats: PRICE_SATS, price_usdc: '$0.01' })
  })

  app.get('/free', getFreeProviders)
  app.get('/providers', requirePayment, getProviders)
  app.get('/providers/best', requirePayment, getBestProvider)
  app.get('/providers/:pubkey', requirePayment, getProviderDetail)
  app.get('/models', requirePayment, getModels)
  app.post('/route', requirePayment, routeRequest)
  registerGatewayRoutes(app, nwcClient)
  registerMcpRoutes(app)

  // Clean up unpaid invoices older than 24 hours
  setInterval(() => {
    const cutoff = Math.floor(Date.now() / 1000) - 86400
    db.prepare('DELETE FROM invoices WHERE used_at IS NULL AND created_at < ?').run(cutoff)
  }, 60 * 60 * 1000)

  app.listen(PORT, () => {
    console.log(`Server ready at http://localhost:${PORT}`)
    console.log(`Accepting: L402 (${PRICE_SATS} sats) | x402 USDC on Base/Polygon/Arbitrum/Solana ($0.01)`)
  })
}

async function requirePayment(req, res, next) {
  // ── 1. Check L402 (Lightning) ──────────────────────────────────────
  const auth = req.headers.authorization
  if (auth?.startsWith('L402 ')) {
    const [paymentHash, preimage] = auth.slice(5).split(':')
    if (paymentHash && preimage) {
      const invoice = db.prepare('SELECT used_at FROM invoices WHERE payment_hash = ?').get(paymentHash)
      if (!invoice) {
        // Not an invoice we created — reject to prevent use of external hashes
      } else if (invoice.used_at) {
        return res.status(402).json({ error: 'Payment already used. Please pay a new invoice.' })
      } else {
        try {
          const lookup = await nwcClient.lookupInvoice({ payment_hash: paymentHash })
          if (lookup.preimage || lookup.settled_at) {
            db.prepare('UPDATE invoices SET used_at = ? WHERE payment_hash = ?')
              .run(Math.floor(Date.now() / 1000), paymentHash)
            return next()
          }
        } catch (e) {
          console.error('L402 lookup failed:', e.message)
        }
      }
    }
  }

  // ── 2. Check x402 (USDC) ───────────────────────────────────────────
  const xPayment = req.headers['x-payment']
  if (xPayment) {
    try {
      const payload = decodePaymentSignatureHeader(xPayment)
      const matchedReq = X402_REQUIREMENTS.find(r => r.network === payload.network && r.scheme === payload.scheme)
      if (!matchedReq) throw new Error(`No requirement for scheme=${payload.scheme} network=${payload.network}`)
      const verifyResult = await facilitator.verify(payload, matchedReq)
      if (verifyResult.isValid) {
        await facilitator.settle(payload, matchedReq)
        return next()
      }
    } catch (e) {
      console.error('x402 verification failed:', e.message)
    }
  }

  // ── 3. No valid payment — return 402 with both options ─────────────
  try {
    const invoice = await nwcClient.makeInvoice({
      amount: PRICE_SATS * 1000,
      description: 'AIRadar provider directory',
    })

    db.prepare('INSERT OR IGNORE INTO invoices (payment_hash, bolt11, created_at) VALUES (?, ?, ?)')
      .run(invoice.payment_hash, invoice.invoice, Math.floor(Date.now() / 1000))

    const x402Header = encodePaymentRequiredHeader({
      x402Version: 1,
      accepts: X402_REQUIREMENTS,
      error: 'Payment required',
    })

    res
      .status(402)
      .set('WWW-Authenticate', `L402 macaroon="${invoice.payment_hash}", invoice="${invoice.invoice}"`)
      .set('X-PAYMENT-REQUIRED', x402Header)
      .json({
        error: 'Payment required',
        payment_options: {
          lightning: {
            protocol: 'L402',
            invoice: invoice.invoice,
            payment_hash: invoice.payment_hash,
            amount_sats: PRICE_SATS,
            how_to_pay: `Pay the invoice, then retry with header: Authorization: L402 ${invoice.payment_hash}:<preimage>`,
          },
          crypto: {
            protocol: 'x402',
            amount_usdc: '$0.01',
            networks: ['Base', 'Polygon', 'Arbitrum', 'Solana'],
            how_to_pay: 'Sign USDC payment and retry with header: X-PAYMENT: <base64-payload>',
            payment_required_header: x402Header,
          },
        },
      })
  } catch (e) {
    console.error('makeInvoice failed:', e.message)
    return res.status(500).json({ error: 'Could not generate invoice' })
  }
}

function formatProvider(p, models) {
  const parsedMints = (() => { try { return JSON.parse(p.mints || '[]') } catch { return [] } })()
  return {
    pubkey:      p.pubkey,
    name:        p.name,
    description: p.description || null,
    version:     p.version || null,
    endpoint:    p.endpoint,
    onion_url:   p.onion_url || null,
    mints:       parsedMints,
    network:     p.network || 'routstr',
    access_type: p.network === 'antseed' ? 'p2p' : 'http',
    auth_type:   p.auth_type || 'lightning',
    child_key_cost_msats: p.child_key_cost_msats || 0,
    status: {
      online:       p.is_online === 1,
      response_ms:  p.response_ms || null,
      last_checked: p.last_check  ? new Date(p.last_check  * 1000).toISOString() : null,
      last_seen:    p.last_seen   ? new Date(p.last_seen   * 1000).toISOString() : null,
      uptime_24h:   p.uptime_total_24h > 0
        ? Math.round((p.uptime_ok_24h / p.uptime_total_24h) * 100)
        : null,
    },
    models: (models || []).map(formatModel),
  }
}

function formatModel(m) {
  return {
    id:                             m.id,
    name:                           m.name,
    context_length:                 m.context_length,
    max_completion_tokens:          m.max_completion_tokens,
    modality:                       m.modality,
    input_modalities:               (() => { try { return JSON.parse(m.input_modalities || '[]') } catch { return [] } })(),
    output_modalities:              (() => { try { return JSON.parse(m.output_modalities || '[]') } catch { return [] } })(),
    pricing: {
      sats_per_prompt_token:        m.pricing_sats_prompt        || null,
      sats_per_completion_token:    m.pricing_sats_completion    || null,
      sats_per_1k_prompt:           m.pricing_sats_per_1k_prompt || null,
      sats_per_1k_completion:       m.pricing_sats_per_1k_completion || null,
      usd_per_1k_prompt:            m.pricing_usd_per_1k_prompt  || null,
      usd_per_1k_completion:        m.pricing_usd_per_1k_completion || null,
    },
    supported_parameters:           (() => { try { return JSON.parse(m.supported_parameters || '[]') } catch { return [] } })(),
    is_moderated:                   m.is_moderated === 1,
    enabled:                        m.enabled === 1,
    provider_pubkey:                m.provider_pubkey,
  }
}

function getProviders(req, res) {
  const { network } = req.query
  let query = `
    SELECT pubkey, name, description, version, endpoint, onion_url, mints,
           child_key_cost_msats, is_online, response_ms, last_check, last_seen,
           uptime_ok_24h, uptime_total_24h, network, auth_type
    FROM providers
  `
  const params = []
  if (network) { query += ' WHERE network = ?'; params.push(network) }
  query += ' ORDER BY is_online DESC, response_ms ASC NULLS LAST'
  const providers = db.prepare(query).all(...params)

  const modelsMap = {}
  db.prepare('SELECT * FROM models WHERE enabled = 1').all()
    .forEach(m => {
      if (!modelsMap[m.provider_pubkey]) modelsMap[m.provider_pubkey] = []
      modelsMap[m.provider_pubkey].push(m)
    })

  res.json({
    updated_at: new Date().toISOString(),
    count: providers.length,
    providers: providers.map(p => formatProvider(p, modelsMap[p.pubkey] || [])),
  })
}

function getProviderDetail(req, res) {
  const p = db.prepare(`
    SELECT * FROM providers WHERE pubkey = ?
  `).get(req.params.pubkey)

  if (!p) return res.status(404).json({ error: 'Provider not found' })

  const models = db.prepare('SELECT * FROM models WHERE provider_pubkey = ?').all(p.pubkey)
  res.json(formatProvider(p, models))
}

function getModels(req, res) {
  const { id, modality, network } = req.query

  let query = `
    SELECT m.*, p.name as provider_name, p.endpoint, p.is_online,
           p.response_ms, p.uptime_ok_24h, p.uptime_total_24h, p.mints,
           p.network as provider_network, p.auth_type
    FROM models m
    JOIN providers p ON m.provider_pubkey = p.pubkey
    WHERE m.enabled = 1
  `
  const params = []

  if (id) {
    query += ' AND (m.id = ? OR m.canonical_id = ?)'
    params.push(id, id)
  }
  if (modality) {
    query += ' AND (m.modality LIKE ? OR m.input_modalities LIKE ?)'
    params.push(`%${modality}%`, `%${modality}%`)
  }
  if (network) {
    query += ' AND p.network = ?'
    params.push(network)
  }

  query += ' ORDER BY p.is_online DESC, m.pricing_sats_per_1k_prompt ASC NULLS LAST'

  const rows = db.prepare(query).all(...params)

  res.json({
    updated_at: new Date().toISOString(),
    count: rows.length,
    models: rows.map(m => ({
      ...formatModel(m),
      provider: {
        pubkey:      m.provider_pubkey,
        name:        m.provider_name,
        endpoint:    m.endpoint,
        network:     m.provider_network || 'routstr',
        auth_type:   m.auth_type || 'lightning',
        online:      m.is_online === 1,
        response_ms: m.response_ms,
        uptime_24h:  m.uptime_total_24h > 0
          ? Math.round((m.uptime_ok_24h / m.uptime_total_24h) * 100)
          : null,
        mints: (() => { try { return JSON.parse(m.mints || '[]') } catch { return [] } })(),
      },
    })),
  })
}

function getFreeProviders(_req, res) {
  const providers = db.prepare(`
    SELECT pubkey, name, description, endpoint, onion_url, mints,
           is_online, response_ms, uptime_ok_24h, uptime_total_24h
    FROM providers
    WHERE is_online = 1
    ORDER BY response_ms ASC NULLS LAST
    LIMIT 3
  `).all()

  const modelsMap = {}
  if (providers.length > 0) {
    const placeholders = providers.map(() => '?').join(',')
    db.prepare(`SELECT * FROM models WHERE provider_pubkey IN (${placeholders}) AND enabled = 1`)
      .all(...providers.map(p => p.pubkey))
      .forEach(m => {
        if (!modelsMap[m.provider_pubkey]) modelsMap[m.provider_pubkey] = []
        modelsMap[m.provider_pubkey].push(m)
      })
  }

  res.json({
    note: 'Free preview — top 3 online providers. Pay 10 sats or $0.01 USDC at /providers for the full directory.',
    updated_at: new Date().toISOString(),
    count: providers.length,
    providers: providers.map(p => formatProvider(p, modelsMap[p.pubkey] || [])),
  })
}

function getBestProvider(req, res) {
  const { model, optimize = 'price' } = req.query

  let query = `
    SELECT m.*, p.name as provider_name, p.endpoint, p.is_online,
           p.response_ms, p.uptime_ok_24h, p.uptime_total_24h,
           p.network as provider_network, p.auth_type
    FROM models m
    JOIN providers p ON m.provider_pubkey = p.pubkey
    WHERE m.enabled = 1 AND p.is_online = 1
  `
  const params = []

  if (model) {
    query += ' AND (m.id = ? OR m.canonical_id = ?)'
    params.push(model, model)
  }

  if (optimize === 'speed') {
    query += ' ORDER BY p.response_ms ASC NULLS LAST, m.pricing_usd_per_1k_prompt ASC NULLS LAST'
  } else if (optimize === 'reliability') {
    query += ` ORDER BY CASE WHEN p.uptime_total_24h > 0
      THEN CAST(p.uptime_ok_24h AS REAL) / p.uptime_total_24h ELSE NULL END DESC NULLS LAST,
      p.response_ms ASC NULLS LAST`
  } else {
    query += ' ORDER BY m.pricing_usd_per_1k_prompt ASC NULLS LAST, p.response_ms ASC NULLS LAST'
  }

  query += ' LIMIT 5'

  const results = db.prepare(query).all(...params)

  if (results.length === 0) {
    const msg = model ? `No online provider found for model "${model}"` : 'No online providers found'
    return res.status(404).json({ error: msg })
  }

  const best = results[0]
  res.json({
    optimized_for: optimize,
    model: model || best.id,
    best: {
      provider:    best.provider_name,
      pubkey:      best.provider_pubkey,
      model:       best.id,
      endpoint:    best.endpoint,
      network:     best.provider_network || 'routstr',
      auth_type:   best.auth_type || 'lightning',
      response_ms: best.response_ms,
      uptime_24h:  best.uptime_total_24h > 0
        ? Math.round((best.uptime_ok_24h / best.uptime_total_24h) * 100)
        : null,
      pricing: {
        usd_per_1k_prompt:     best.pricing_usd_per_1k_prompt,
        usd_per_1k_completion: best.pricing_usd_per_1k_completion,
      },
    },
    how_to_use: {
      url:    `${best.endpoint}/v1/chat/completions`,
      method: 'POST',
      body:   { model: best.id, messages: [{ role: 'user', content: '...' }] },
    },
    alternatives: results.slice(1).map(m => ({
      provider:    m.provider_name,
      pubkey:      m.provider_pubkey,
      model:       m.id,
      endpoint:    m.endpoint,
      response_ms: m.response_ms,
      pricing:     { usd_per_1k_prompt: m.pricing_usd_per_1k_prompt },
    })),
  })
}

function routeRequest(req, res) {
  const { modality, max_price_sats_per_1k, min_context_length, model_id } = req.body || {}

  let query = `
    SELECT m.*, p.name as provider_name, p.endpoint, p.is_online,
           p.response_ms, p.uptime_ok_24h, p.uptime_total_24h, p.mints,
           p.child_key_cost_msats
    FROM models m
    JOIN providers p ON m.provider_pubkey = p.pubkey
    WHERE m.enabled = 1 AND p.is_online = 1
  `
  const params = []

  if (model_id) {
    query += ' AND (m.id = ? OR m.canonical_id = ?)'
    params.push(model_id, model_id)
  }
  if (modality) {
    query += ' AND (m.modality LIKE ? OR m.input_modalities LIKE ?)'
    params.push(`%${modality}%`, `%${modality}%`)
  }
  if (max_price_sats_per_1k != null) {
    query += ' AND (m.pricing_sats_per_1k_prompt IS NULL OR m.pricing_sats_per_1k_prompt <= ?)'
    params.push(max_price_sats_per_1k)
  }
  if (min_context_length != null) {
    query += ' AND (m.context_length IS NULL OR m.context_length >= ?)'
    params.push(min_context_length)
  }

  query += ' ORDER BY m.pricing_sats_per_1k_prompt ASC NULLS LAST, p.response_ms ASC NULLS LAST LIMIT 5'

  const results = db.prepare(query).all(...params)

  if (results.length === 0) {
    return res.status(404).json({ error: 'No providers match your requirements. Try relaxing constraints.' })
  }

  const best = results[0]
  res.json({
    recommendation: {
      provider:    best.provider_name,
      pubkey:      best.provider_pubkey,
      model:       best.id,
      endpoint:    best.endpoint,
      response_ms: best.response_ms,
      pricing: {
        sats_per_1k_prompt:     best.pricing_sats_per_1k_prompt,
        sats_per_1k_completion: best.pricing_sats_per_1k_completion,
      },
      context_length:      best.context_length,
      modality:            best.modality,
      mints:               (() => { try { return JSON.parse(best.mints || '[]') } catch { return [] } })(),
    },
    how_to_use: {
      url:     `${best.endpoint}/v1/chat/completions`,
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    { model: best.id, messages: [{ role: 'user', content: '...' }] },
      note:    'OpenAI-compatible API. Payment handled via Lightning/Cashu at provider level.',
    },
    alternatives: results.slice(1).map(m => ({
      provider: m.provider_name,
      model:    m.id,
      endpoint: m.endpoint,
      pricing:  { sats_per_1k_prompt: m.pricing_sats_per_1k_prompt },
    })),
  })
}
