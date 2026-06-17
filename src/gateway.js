import { createHash } from 'crypto'
import { facilitator, decodePaymentSignatureHeader, encodePaymentRequiredHeader } from './x402.js'
import db from './db.js'

const OPENROUTER_API = 'https://openrouter.ai/api/v1'

const EVM_ADDRESS = '0x7698672ceE929D3f0fA3c773111b4D6b0095aa1A'
const SOL_ADDRESS = 'AP8Q9QaYQ1etKFuUVQdd8RpGCWYH4QLDREfnd76KJX3m'

// What we charge per call (sats and USDC micro-units), by model tier
const TIER_SATS = {
  free:   50,    // open/free models
  small:  150,   // cheap models (<$0.0005/1k tokens)
  medium: 400,   // mid models (<$0.003/1k tokens)
  large:  1000,  // frontier models (GPT-4o, Claude Sonnet+)
}

const TIER_USDC = {
  free:   '50000',   // $0.05
  small:  '150000',  // $0.15
  medium: '400000',  // $0.40
  large:  '1000000', // $1.00
}

function getModelTier(modelId) {
  if (!modelId) return 'medium'
  const m = db.prepare(
    "SELECT pricing_usd_per_1k_prompt FROM models WHERE id = ? AND provider_pubkey = 'openrouter'"
  ).get(modelId)
  if (!m) return 'medium'
  const p = m.pricing_usd_per_1k_prompt
  if (p === null || p <= 0) return 'free'
  if (p < 0.0005) return 'small'
  if (p < 0.003)  return 'medium'
  return 'large'
}

function getX402Requirements(tier) {
  const amount = TIER_USDC[tier] || TIER_USDC.medium
  const resource = 'https://airadar.fyi/v1/chat/completions'
  const description = `AIRadar Gateway — ${tier} tier`
  return [
    { scheme: 'exact', network: 'base',    maxAmountRequired: amount, resource, description, mimeType: 'application/json', payTo: EVM_ADDRESS, maxTimeoutSeconds: 300, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', extra: { name: 'USD Coin', version: '2' } },
    { scheme: 'exact', network: 'polygon', maxAmountRequired: amount, resource, description, mimeType: 'application/json', payTo: EVM_ADDRESS, maxTimeoutSeconds: 300, asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', extra: { name: 'USD Coin', version: '2' } },
    { scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', maxAmountRequired: amount, resource, description, mimeType: 'application/json', payTo: SOL_ADDRESS, maxTimeoutSeconds: 300, asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', extra: {} },
  ]
}

async function forwardToOpenRouter(body) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set')
  const res = await fetch(`${OPENROUTER_API}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization':  `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type':   'application/json',
      'HTTP-Referer':   'https://airadar.fyi',
      'X-Title':        'AIRadar Gateway',
    },
    body: JSON.stringify({ ...body, stream: false }),
    signal: AbortSignal.timeout(60000),
  })
  return res
}

export function registerGatewayRoutes(app, nwcClient) {

  // OpenAI-compatible inference gateway
  app.post('/v1/chat/completions', async (req, res) => {
    const body      = req.body || {}
    const modelId   = body.model || null
    const tier      = getModelTier(modelId)
    const priceSats = TIER_SATS[tier]
    const x402Reqs  = getX402Requirements(tier)

    // ── 1. Check L402 (Lightning) ───────────────────────────────────────
    const auth = req.headers.authorization
    if (auth?.startsWith('L402 ')) {
      const [paymentHash, preimage] = auth.slice(5).split(':')
      if (paymentHash && preimage) {
        const invoice = db.prepare(
          'SELECT used_at, amount_sats FROM invoices WHERE payment_hash = ?'
        ).get(paymentHash)

        if (!invoice) {
          // Not an invoice we created — reject to prevent use of external hashes
        } else if (invoice.used_at) {
          return res.status(402).json({ error: 'Invoice already used — pay a new one.' })
        } else if (invoice.amount_sats < priceSats) {
          return res.status(402).json({
            error: `Underpayment: ${tier} tier requires ${priceSats} sats, invoice was for ${invoice.amount_sats}.`,
          })
        } else {
          try {
            const lookup = await nwcClient.lookupInvoice({ payment_hash: paymentHash })
            if (lookup.preimage || lookup.settled_at) {
              db.prepare('UPDATE invoices SET used_at = ? WHERE payment_hash = ?')
                .run(Math.floor(Date.now() / 1000), paymentHash)

              try {
                const upstream = await forwardToOpenRouter(body)
                const data = await upstream.json()
                if (!upstream.ok) return res.status(upstream.status).json(data)
                return res.json(data)
              } catch (e) {
                console.error('Gateway forward error:', e.message)
                return res.status(502).json({ error: 'Upstream provider error. Your payment has been recorded — contact support.' })
              }
            }
          } catch (e) {
            console.error('Gateway L402 lookup failed:', e.message)
          }
        }
      }
    }

    // ── 2. Check x402 (USDC) ───────────────────────────────────────────
    const xPayment = req.headers['x-payment']
    if (xPayment) {
      try {
        const payload = decodePaymentSignatureHeader(xPayment)
        const matchedReq = x402Reqs.find(r => r.network === payload.network && r.scheme === payload.scheme)
        if (!matchedReq) throw new Error(`No requirement found for scheme=${payload.scheme} network=${payload.network}`)
        const verifyResult = await facilitator.verify(payload, matchedReq)
        if (verifyResult.isValid) {
          await facilitator.settle(payload, matchedReq)

          // Write settlement record before forwarding so any upstream failure is auditable
          const settleId = createHash('sha256').update(xPayment).digest('hex').slice(0, 40)
          db.prepare(
            'INSERT OR IGNORE INTO invoices (payment_hash, bolt11, created_at, used_at) VALUES (?, ?, ?, ?)'
          ).run(settleId, `x402:${payload.network}`, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000))

          try {
            const upstream = await forwardToOpenRouter(body)
            const data = await upstream.json()
            if (!upstream.ok) return res.status(upstream.status).json(data)
            return res.json(data)
          } catch (e) {
            console.error('Gateway forward error (x402):', e.message)
            return res.status(502).json({ error: `Upstream provider error. Your USDC payment was settled (ref: ${settleId}). Contact support.` })
          }
        }
      } catch (e) {
        console.error('Gateway x402 verification failed:', e.message)
      }
    }

    // ── 3. No valid payment — issue both L402 + x402 ────────────────────
    try {
      const invoice = await nwcClient.makeInvoice({
        amount:      priceSats * 1000, // msats
        description: `AIRadar — ${modelId || 'AI inference'} (${tier})`,
      })

      db.prepare(
        'INSERT OR IGNORE INTO invoices (payment_hash, bolt11, created_at, amount_sats) VALUES (?, ?, ?, ?)'
      ).run(invoice.payment_hash, invoice.invoice, Math.floor(Date.now() / 1000), priceSats)

      const x402Header = encodePaymentRequiredHeader({
        x402Version: 1,
        accepts: x402Reqs,
        error: 'Payment required',
      })

      return res
        .status(402)
        .set('WWW-Authenticate', `L402 macaroon="${invoice.payment_hash}", invoice="${invoice.invoice}"`)
        .set('X-PAYMENT-REQUIRED', x402Header)
        .json({
          error: 'Payment required',
          model: modelId,
          tier,
          payment_options: {
            lightning: {
              protocol:     'L402',
              invoice:      invoice.invoice,
              payment_hash: invoice.payment_hash,
              amount_sats:  priceSats,
              instructions: `1. Pay this Lightning invoice. 2. Retry with header: Authorization: L402 ${invoice.payment_hash}:<preimage>`,
            },
            crypto: {
              protocol:    'x402',
              amount_usdc: `$${(parseInt(TIER_USDC[tier]) / 1_000_000).toFixed(2)}`,
              networks:    ['Base (eip155:8453)', 'Polygon (eip155:137)', 'Arbitrum (eip155:42161)', 'Solana'],
              instructions: 'Sign USDC payment and retry with header: X-PAYMENT: <base64-payload>',
              payment_required_header: x402Header,
            },
          },
        })
    } catch (e) {
      console.error('Gateway makeInvoice failed:', e.message)
      return res.status(500).json({ error: 'Could not generate payment invoice' })
    }
  })

  // List available models through the gateway (free)
  app.get('/v1/models', (_req, res) => {
    const models = db.prepare(`
      SELECT id, name, context_length, modality,
             pricing_usd_per_1k_prompt, pricing_usd_per_1k_completion
      FROM models
      WHERE provider_pubkey = 'openrouter' AND enabled = 1
      ORDER BY pricing_usd_per_1k_prompt ASC NULLS LAST
    `).all()

    res.json({
      object: 'list',
      data: models.map(m => {
        const tier = getModelTier(m.id)
        return {
          id:             m.id,
          object:         'model',
          name:           m.name,
          context_length: m.context_length,
          modality:       m.modality,
          pricing_usd_per_1k_prompt:     m.pricing_usd_per_1k_prompt,
          pricing_usd_per_1k_completion: m.pricing_usd_per_1k_completion,
          airadar_tier:       tier,
          airadar_price_sats: TIER_SATS[tier],
          airadar_price_usdc: `$${(parseInt(TIER_USDC[tier]) / 1_000_000).toFixed(2)}`,
        }
      }),
    })
  })
}
