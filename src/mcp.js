import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { z } from 'zod'
import db from './db.js'
import { INTERNAL_TOKEN } from './gateway.js'

const GATEWAY_URL = `http://localhost:${process.env.PORT || 3000}`

function getProviders() {
  return db.prepare(`
    SELECT p.*, GROUP_CONCAT(m.id) as model_ids
    FROM providers p
    LEFT JOIN models m ON m.provider_pubkey = p.pubkey AND m.enabled = 1
    WHERE p.is_online = 1
    GROUP BY p.pubkey
    ORDER BY p.response_ms ASC NULLS LAST
  `).all()
}

function getModels({ modelId, modality, maxPriceSats, minContext } = {}) {
  let q = `
    SELECT m.*, p.name as provider_name, p.endpoint, p.is_online, p.response_ms,
           p.uptime_ok_24h, p.uptime_total_24h
    FROM models m
    JOIN providers p ON m.provider_pubkey = p.pubkey
    WHERE m.enabled = 1 AND p.is_online = 1
  `
  const params = []
  if (modelId) { q += ' AND (m.id = ? OR m.canonical_id = ?)'; params.push(modelId, modelId) }
  if (modality) { q += ' AND (m.modality LIKE ? OR m.input_modalities LIKE ?)'; params.push(`%${modality}%`, `%${modality}%`) }
  if (maxPriceSats != null) { q += ' AND m.pricing_sats_per_1k_prompt <= ?'; params.push(maxPriceSats) }
  if (minContext != null) { q += ' AND m.context_length >= ?'; params.push(minContext) }
  q += ' ORDER BY m.pricing_sats_per_1k_prompt ASC NULLS LAST, p.response_ms ASC NULLS LAST'
  return db.prepare(q).all(...params)
}

function formatProviderForAgent(p) {
  return {
    pubkey: p.pubkey,
    name: p.name,
    endpoint: p.endpoint,
    response_ms: p.response_ms,
    uptime_24h: p.uptime_total_24h > 0 ? Math.round((p.uptime_ok_24h / p.uptime_total_24h) * 100) : null,
    models: p.model_ids ? p.model_ids.split(',') : [],
    mints: (() => { try { return JSON.parse(p.mints || '[]') } catch { return [] } })(),
  }
}

function formatModelForAgent(m) {
  return {
    id: m.id,
    name: m.name,
    provider: m.provider_name,
    endpoint: m.endpoint,
    context_length: m.context_length,
    modality: m.modality,
    pricing: {
      sats_per_1k_prompt: m.pricing_sats_per_1k_prompt,
      sats_per_1k_completion: m.pricing_sats_per_1k_completion,
    },
    how_to_use: `POST ${m.endpoint}/v1/chat/completions with OpenAI-compatible payload`,
  }
}

function createMcpServer() {
  const server = new McpServer({
    name: 'AIRadar',
    version: '1.0.0',
    description: 'Real-time directory of AI inference providers on the Routstr/Nostr network',
  })

  server.tool(
    'list_providers',
    'List all online AI inference providers on the Routstr network with their endpoints and available models',
    {},
    async () => {
      const providers = getProviders()
      if (providers.length === 0) {
        return { content: [{ type: 'text', text: 'No providers currently online on the Routstr network.' }] }
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ count: providers.length, providers: providers.map(formatProviderForAgent) }, null, 2),
        }],
      }
    }
  )

  server.tool(
    'find_model',
    'Find which providers offer a specific AI model and at what price in sats',
    { model_id: z.string().describe('Model ID to search (e.g. gpt-4o, llama-3.1-8b, claude-3-5-sonnet)') },
    async ({ model_id }) => {
      const models = getModels({ modelId: model_id })
      if (models.length === 0) {
        return { content: [{ type: 'text', text: `No online providers found for model: ${model_id}` }] }
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ model_id, providers_offering: models.map(formatModelForAgent) }, null, 2),
        }],
      }
    }
  )

  server.tool(
    'route',
    'Find the best AI provider matching your requirements. Returns endpoint and usage instructions.',
    {
      modality:             z.enum(['text', 'image', 'audio', 'text+image']).optional().describe('Input type required'),
      max_price_sats_per_1k: z.number().optional().describe('Max price in sats per 1k tokens'),
      min_context_length:   z.number().optional().describe('Minimum context window in tokens'),
      model_id:             z.string().optional().describe('Specific model ID if you need a particular model'),
    },
    async ({ modality, max_price_sats_per_1k, min_context_length, model_id }) => {
      const models = getModels({ modelId: model_id, modality, maxPriceSats: max_price_sats_per_1k, minContext: min_context_length })
      if (models.length === 0) {
        return { content: [{ type: 'text', text: 'No providers match your requirements. Try relaxing constraints.' }] }
      }
      const best = models[0]
      const result = {
        recommendation: formatModelForAgent(best),
        alternatives: models.slice(1, 3).map(formatModelForAgent),
        usage: {
          endpoint: `${best.endpoint}/v1/chat/completions`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body_example: {
            model: best.id,
            messages: [{ role: 'user', content: 'Hello' }],
          },
          note: 'OpenAI-compatible API. No API key required — payment handled via Lightning/Cashu at the provider level.',
        },
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  server.tool(
    'run_inference',
    'Run AI inference through the AIRadar gateway. Supports 337+ models via OpenRouter. No payment required when called from this MCP server.',
    {
      model:       z.string().describe('Model ID — use find_model or list from GET /v1/models (e.g. openai/gpt-4o, google/gemma-3-27b-it:free, anthropic/claude-3-5-sonnet)'),
      messages:    z.array(z.object({
        role:    z.enum(['user', 'assistant', 'system']),
        content: z.string(),
      })).describe('Conversation messages in OpenAI format'),
      temperature: z.number().min(0).max(2).optional().describe('Sampling temperature 0–2 (default: model default)'),
      max_tokens:  z.number().int().positive().optional().describe('Maximum tokens to generate'),
    },
    async ({ model, messages, temperature, max_tokens }) => {
      const body = { model, messages }
      if (temperature != null) body.temperature = temperature
      if (max_tokens   != null) body.max_tokens   = max_tokens

      let response, data
      try {
        response = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
          method:  'POST',
          headers: {
            'Content-Type':      'application/json',
            'X-Internal-Token':  INTERNAL_TOKEN,
          },
          body:    JSON.stringify(body),
          signal:  AbortSignal.timeout(60000),
        })
        data = await response.json()
      } catch (e) {
        return { content: [{ type: 'text', text: `Gateway error: ${e.message}` }] }
      }

      if (!response.ok) {
        return { content: [{ type: 'text', text: `Upstream error (${response.status}): ${JSON.stringify(data)}` }] }
      }

      const reply = data.choices?.[0]?.message?.content
      if (!reply) return { content: [{ type: 'text', text: JSON.stringify(data) }] }
      return { content: [{ type: 'text', text: reply }] }
    }
  )

  server.tool(
    'compare_prices',
    'Compare prices across all providers for a given model or category',
    {
      model_id: z.string().optional().describe('Model ID to compare'),
      modality: z.string().optional().describe('Modality to compare (text, image, audio)'),
    },
    async ({ model_id, modality }) => {
      const models = getModels({ modelId: model_id, modality })
      if (models.length === 0) {
        return { content: [{ type: 'text', text: 'No results found for comparison.' }] }
      }
      const comparison = models.map(m => ({
        model:               m.id,
        provider:            m.provider_name,
        sats_per_1k_prompt:  m.pricing_sats_per_1k_prompt,
        sats_per_1k_completion: m.pricing_sats_per_1k_completion,
        context_length:      m.context_length,
        response_ms:         m.response_ms,
        endpoint:            m.endpoint,
      }))
      return { content: [{ type: 'text', text: JSON.stringify({ count: comparison.length, sorted_by: 'price_asc', results: comparison }, null, 2) }] }
    }
  )

  return server
}

const activeTransports = {}

export function registerMcpRoutes(app) {
  app.get('/mcp', async (req, res) => {
    const transport = new SSEServerTransport('/mcp/message', res)
    activeTransports[transport.sessionId] = transport
    req.on('close', () => { delete activeTransports[transport.sessionId] })
    const server = createMcpServer()
    await server.connect(transport)
  })

  app.post('/mcp/message', express_json_middleware, async (req, res) => {
    const transport = activeTransports[req.query.sessionId]
    if (!transport) return res.status(404).json({ error: 'Session not found' })
    await transport.handlePostMessage(req, res)
  })
}

// express.json() middleware reference (injected at registration time)
let express_json_middleware
export function setJsonMiddleware(fn) { express_json_middleware = fn }
