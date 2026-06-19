import { createHash } from 'crypto'
import express from 'express'
import { NWCClient } from '@getalby/sdk'
import { facilitator, decodePaymentSignatureHeader, encodePaymentRequiredHeader } from './x402.js'
import db from './db.js'
import { registerMcpRoutes, setJsonMiddleware } from './mcp.js'
import { registerGatewayRoutes, INTERNAL_TOKEN } from './gateway.js'
import { searchWeb, searchBackend } from './search.js'
import { fetchUrl } from './fetch.js'
import { registerMemoryRoutes } from './memory.js'
import { registerDataRoutes } from './data.js'
import { registerAiRoutes } from './ai-tools.js'
import { registerComputeRoutes } from './compute.js'
import { registerStateRoutes } from './state.js'
import { analyticsMiddleware, registerAnalyticsRoutes } from './analytics.js'
import { registerReputationRoutes } from './reputation.js'
import { registerOpenApiRoutes } from './openapi.js'

const app = express()
const jsonMiddleware = express.json()
app.use(jsonMiddleware)
setJsonMiddleware(jsonMiddleware)
const PRICE_SATS  = parseInt(process.env.PRICE_SATS || '10')
const SEARCH_SATS = 5
const PORT = parseInt(process.env.PORT || '3000')

const EVM_ADDRESS  = '0x7698672ceE929D3f0fA3c773111b4D6b0095aa1A'
const SOL_ADDRESS  = 'AP8Q9QaYQ1etKFuUVQdd8RpGCWYH4QLDREfnd76KJX3m'
const PRICE_USDC   = '10000' // $0.01
const SEARCH_USDC  = '5000'  // $0.005

function makeX402Reqs(amount, resource, description) {
  return [
    { scheme: 'exact', network: 'base',           maxAmountRequired: amount, resource, description, mimeType: 'application/json', payTo: EVM_ADDRESS, maxTimeoutSeconds: 300, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',         extra: { name: 'USD Coin', version: '2' } },
    { scheme: 'exact', network: 'polygon',        maxAmountRequired: amount, resource, description, mimeType: 'application/json', payTo: EVM_ADDRESS, maxTimeoutSeconds: 300, asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',         extra: { name: 'USD Coin', version: '2' } },
    { scheme: 'exact', network: 'eip155:42161',   maxAmountRequired: amount, resource, description, mimeType: 'application/json', payTo: EVM_ADDRESS, maxTimeoutSeconds: 300, asset: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',         extra: { name: 'USD Coin', version: '2' } },
    { scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', maxAmountRequired: amount, resource, description, mimeType: 'application/json', payTo: SOL_ADDRESS, maxTimeoutSeconds: 300, asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', extra: {} },
  ]
}

const X402_REQUIREMENTS        = makeX402Reqs(PRICE_USDC,  'https://airadar.fyi/providers', 'AIRadar — AI provider directory')
const SEARCH_X402_REQUIREMENTS = makeX402Reqs(SEARCH_USDC, 'https://airadar.fyi/search',    'AIRadar — web search')

function makeMiddleware(priceSats, priceUsdc, path, label) {
  const reqs = makeX402Reqs(String(priceUsdc), `https://airadar.fyi${path}`, label)
  return makeRequirePayment(priceSats, reqs, label)
}

// Compiled once at startup — shared across all makeRequirePayment instances
const stmtGetInvoice    = db.prepare('SELECT used_at, amount_sats FROM invoices WHERE payment_hash = ?')
const stmtMarkUsed      = db.prepare('UPDATE invoices SET used_at = ? WHERE payment_hash = ?')
const stmtInsertInvoice = db.prepare('INSERT OR IGNORE INTO invoices (payment_hash, bolt11, created_at, amount_sats) VALUES (?, ?, ?, ?)')
const stmtInsertSettle  = db.prepare('INSERT OR IGNORE INTO invoices (payment_hash, bolt11, created_at, used_at) VALUES (?, ?, ?, ?)')

let nwcClient

export function initServer() {
  nwcClient = new NWCClient({
    nostrWalletConnectUrl: process.env.NWC_SECRET,
  })

  app.use(analyticsMiddleware)

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
        'GET /search': {
          description: 'Web search. Returns clean JSON results. No account, no API key.',
          auth: 'pay-per-use',
          pricing: { sats: SEARCH_SATS, usdc: '$0.005' },
          params: { q: 'search query (required)', n: 'number of results (default 5, max 10)' },
          returns: '{ results: [{ title, url, snippet, engine }], source }',
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
        'GET /reputation/:id': {
          description: 'Agent reputation score (0-100) based on payment history and behaviour on this network. Free to query — designed for third-party services to verify agent trustworthiness before accepting payments.',
          auth: 'none',
          params: { id: 'USDC wallet address or agent_id' },
          returns: '{ score, label, breakdown, integrate }',
        },
        'GET /reputation': {
          description: 'Leaderboard of top agents by reputation score.',
          auth: 'none',
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

  const requirePayment       = makeRequirePayment(PRICE_SATS,  X402_REQUIREMENTS,        'AIRadar — provider directory')
  const requireSearchPayment = makeRequirePayment(SEARCH_SATS, SEARCH_X402_REQUIREMENTS,  'AIRadar — web search')
  const requireFetch         = makeMiddleware(3,  3000,  '/fetch',  'AIRadar — URL fetch')
  const requireEmbed         = makeMiddleware(3,  3000,  '/embed',  'AIRadar — embeddings')
  const requireCompare       = makeMiddleware(20, 20000, '/compare','AIRadar — model compare')
  const requireMemWrite      = makeMiddleware(2,  2000,  '/memory', 'AIRadar — memory write')
  const requireMemRead       = makeMiddleware(1,  1000,  '/memory', 'AIRadar — memory read')

  // Price tiers for all new service groups
  const req1  = makeMiddleware(1,   1000,  '/data',       'AIRadar — data')
  const req2  = makeMiddleware(2,   2000,  '/data',       'AIRadar — data')
  const req3  = makeMiddleware(3,   3000,  '/ai',         'AIRadar — AI tools')
  const req5  = makeMiddleware(5,   5000,  '/ai',         'AIRadar — AI tools')
  const req8  = makeMiddleware(8,   8000,  '/ai/vision',  'AIRadar — vision')
  const req50 = makeMiddleware(50,  50000, '/ai/image',   'AIRadar — image generation')
  const mw    = { req1, req2, req3, req5, req8, req50 }

  app.get('/ping', (_req, res) => res.json({ ok: true }))
  app.get('/search', requireSearchPayment, handleSearch)
  app.get('/free', getFreeProviders)
  app.get('/providers', requirePayment, getProviders)
  app.get('/providers/best', requirePayment, getBestProvider)
  app.get('/providers/:pubkey', requirePayment, getProviderDetail)
  app.get('/models', requirePayment, getModels)
  app.post('/route', requirePayment, routeRequest)
  app.get('/fetch',  requireFetch,  handleFetch)
  app.post('/embed', requireEmbed,  handleEmbed)
  app.post('/compare', requireCompare, handleCompare)
  registerMemoryRoutes(app, requireMemWrite, requireMemRead)
  registerDataRoutes(app, mw)
  registerAiRoutes(app, mw)
  registerComputeRoutes(app, mw)
  registerStateRoutes(app, mw)
  registerAnalyticsRoutes(app)
  registerReputationRoutes(app)
  registerOpenApiRoutes(app)
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

function makeRequirePayment(priceSats, x402Reqs, label) {
  const usdcDisplay = `$${(parseInt(x402Reqs[0].maxAmountRequired) / 1_000_000).toFixed(3)}`
  const x402Header  = encodePaymentRequiredHeader({ x402Version: 1, accepts: x402Reqs, error: 'Payment required' })

  return async function(req, res, next) {
    // ── 0. Internal token bypass (MCP server) ─────────────────────────
    if (req.headers['x-internal-token'] === INTERNAL_TOKEN) {
      res.locals.paymentType = 'internal'
      return next()
    }

    // ── 1. Check L402 (Lightning) ────────────────────────────────────
    const auth = req.headers.authorization
    if (auth?.startsWith('L402 ')) {
      const [paymentHash, preimage] = auth.slice(5).split(':')
      if (paymentHash && preimage) {
        const invoice = stmtGetInvoice.get(paymentHash)
        if (invoice?.used_at) {
          return res.status(402).json({ error: 'Payment already used. Please pay a new invoice.' })
        } else if (invoice) {
          if (invoice.amount_sats !== null && invoice.amount_sats < priceSats) {
            return res.status(402).json({ error: `Underpayment: this endpoint requires ${priceSats} sats.` })
          }
          try {
            const lookup = await nwcClient.lookupInvoice({ payment_hash: paymentHash })
            if (lookup.preimage || lookup.settled_at) {
              stmtMarkUsed.run(Math.floor(Date.now() / 1000), paymentHash)
              res.locals.paymentType = 'l402'
              res.locals.paymentId   = paymentHash
              return next()
            }
          } catch (e) {
            console.error('L402 lookup failed:', e.message)
          }
        }
      }
    }

    // ── 2. Check x402 (USDC) ─────────────────────────────────────────
    const xPayment = req.headers['x-payment']
    if (xPayment) {
      try {
        const payload = decodePaymentSignatureHeader(xPayment)
        const matchedReq = x402Reqs.find(r => r.network === payload.network && r.scheme === payload.scheme)
        if (!matchedReq) throw new Error(`No requirement for scheme=${payload.scheme} network=${payload.network}`)
        const verifyResult = await facilitator.verify(payload, matchedReq)
        if (verifyResult.isValid) {
          const settleId = createHash('sha256').update(xPayment).digest('hex').slice(0, 40)
          const now = Math.floor(Date.now() / 1000)
          const dedup = stmtInsertSettle.run(settleId, `x402:${payload.network}`, now, now)
          if (dedup.changes === 0) throw new Error('x402 payment already processed')
          await facilitator.settle(payload, matchedReq)
          res.locals.paymentType   = 'x402'
          res.locals.paymentId     = settleId
          res.locals.walletAddress = payload?.payload?.authorization?.from
                                  || payload?.authorization?.from
                                  || null
          return next()
        }
      } catch (e) {
        console.error('x402 verification failed:', e.message)
      }
    }

    // ── 3. No valid payment — issue 402 ───────────────────────────────
    try {
      const invoice = await nwcClient.makeInvoice({
        amount: priceSats * 1000,
        description: label,
      })

      stmtInsertInvoice.run(invoice.payment_hash, invoice.invoice, Math.floor(Date.now() / 1000), priceSats)

      res
        .status(402)
        .set('WWW-Authenticate', `L402 macaroon="${invoice.payment_hash}", invoice="${invoice.invoice}"`)
        .set('X-PAYMENT-REQUIRED', x402Header)
        .json({
          error: 'Payment required',
          payment_options: {
            lightning: {
              protocol: 'L402', invoice: invoice.invoice,
              payment_hash: invoice.payment_hash, amount_sats: priceSats,
              how_to_pay: `Pay the invoice, then retry with header: Authorization: L402 ${invoice.payment_hash}:<preimage>`,
            },
            crypto: {
              protocol: 'x402', amount_usdc: usdcDisplay,
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
}


async function handleSearch(req, res) {
  const query = req.query.q?.trim()
  if (!query) return res.status(400).json({ error: 'Missing ?q= parameter' })
  const n         = Math.min(parseInt(req.query.n) || 5, 10)
  const type      = req.query.type === 'news' ? 'news' : 'web'
  const freshness = req.query.freshness || undefined  // pd=day, pw=week, pm=month, py=year
  try {
    const result = await searchWeb(query, n, { type, freshness })
    res.json({ query, type, count: result.results.length, backend: result.source, results: result.results })
  } catch (e) {
    console.error('[search] failed:', e.message)
    res.status(502).json({ error: 'Search backend unavailable', backend: searchBackend() })
  }
}

async function handleFetch(req, res) {
  const url = req.query.url?.trim()
  if (!url) return res.status(400).json({ error: 'Missing ?url= parameter' })
  try {
    const result = await fetchUrl(url)
    res.json(result)
  } catch (e) {
    console.error('[fetch] failed:', e.message)
    const status = e.message.startsWith('HTTP ') ? 502 : 400
    res.status(status).json({ error: e.message })
  }
}

async function handleEmbed(req, res) {
  const { input, model = 'openai/text-embedding-3-small' } = req.body || {}
  if (!input) return res.status(400).json({ error: 'Missing "input" in request body' })
  if (!process.env.OPENROUTER_API_KEY) return res.status(503).json({ error: 'Embedding backend not configured' })
  try {
    const upstream = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type':  'application/json',
        'HTTP-Referer':  'https://airadar.fyi',
        'X-Title':       'AIRadar Embeddings',
      },
      body: JSON.stringify({ model, input }),
      signal: AbortSignal.timeout(30000),
    })
    const data = await upstream.json()
    if (!upstream.ok) return res.status(upstream.status).json(data)
    res.json(data)
  } catch (e) {
    console.error('[embed] failed:', e.message)
    res.status(502).json({ error: 'Embedding backend unavailable' })
  }
}

async function handleCompare(req, res) {
  const { prompt, models, system } = req.body || {}
  if (!prompt) return res.status(400).json({ error: 'Missing "prompt" in request body' })
  if (!Array.isArray(models) || models.length === 0) return res.status(400).json({ error: 'Missing "models" array in request body' })
  if (models.length > 5) return res.status(400).json({ error: 'Maximum 5 models per comparison' })
  if (!process.env.OPENROUTER_API_KEY) return res.status(503).json({ error: 'Compare backend not configured' })

  const messages = system
    ? [{ role: 'system', content: system }, { role: 'user', content: prompt }]
    : [{ role: 'user', content: prompt }]

  const callModel = async (modelId) => {
    const start = Date.now()
    try {
      const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type':  'application/json',
          'HTTP-Referer':  'https://airadar.fyi',
          'X-Title':       'AIRadar Compare',
        },
        body: JSON.stringify({ model: modelId, messages, max_tokens: 512 }),
        signal: AbortSignal.timeout(30000),
      })
      const data = await upstream.json()
      if (!upstream.ok) return { model: modelId, error: data.error?.message || `HTTP ${upstream.status}`, latency_ms: Date.now() - start }
      return {
        model:        modelId,
        response:     data.choices?.[0]?.message?.content || '',
        latency_ms:   Date.now() - start,
        input_tokens:  data.usage?.prompt_tokens     || null,
        output_tokens: data.usage?.completion_tokens || null,
      }
    } catch (e) {
      return { model: modelId, error: e.message, latency_ms: Date.now() - start }
    }
  }

  const results = await Promise.all(models.map(callModel))
  res.json({ prompt, system: system || null, results, compared_at: new Date().toISOString() })
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
