import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { z } from 'zod'
import db from './db.js'
import { INTERNAL_TOKEN } from './gateway.js'
import { searchWeb } from './search.js'
import { fetchUrl } from './fetch.js'
import { getWeather, getCryptoPrices, getStockPrice, getIpInfo, dnsLookup, getWiki, getHnStories, getWhois, getWayback } from './data.js'
import { hashText, generateUuids, base64Encode, base64Decode, evalMath } from './compute.js'

const GATEWAY_URL = `http://localhost:${process.env.PORT || 3000}`

const stmtProviders = db.prepare(`
  SELECT p.*, GROUP_CONCAT(m.id) as model_ids
  FROM providers p
  LEFT JOIN models m ON m.provider_pubkey = p.pubkey AND m.enabled = 1
  WHERE p.is_online = 1
  GROUP BY p.pubkey
  ORDER BY p.response_ms ASC NULLS LAST
`)

function getProviders() {
  return stmtProviders.all()
}

async function callAiEndpoint(path, body, { timeout = 30000, pick } = {}) {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL_TOKEN },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  const data = await res.json()
  if (!res.ok) return { content: [{ type: 'text', text: `AI error: ${data.error}` }] }
  const text = (pick && data[pick] != null) ? String(data[pick]) : JSON.stringify(data, null, 2)
  return { content: [{ type: 'text', text: text }] }
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

  // ── Web & data tools ────────────────────────────────────────────────────────

  server.tool(
    'web_search',
    'Search the web and get clean JSON results. Use type=news for news articles.',
    {
      query:     z.string().describe('Search query'),
      n:         z.number().int().min(1).max(10).default(5).optional().describe('Number of results'),
      type:      z.enum(['web', 'news']).default('web').optional(),
      freshness: z.enum(['pd', 'pw', 'pm', 'py']).optional().describe('pd=day pw=week pm=month py=year'),
    },
    async ({ query, n = 5, type = 'web', freshness }) => {
      try {
        const result = await searchWeb(query, n, { type, freshness })
        return { content: [{ type: 'text', text: JSON.stringify({ query, count: result.results.length, results: result.results }, null, 2) }] }
      } catch (e) {
        return { content: [{ type: 'text', text: `Search failed: ${e.message}` }] }
      }
    }
  )

  server.tool(
    'fetch_url',
    'Fetch and extract clean readable text from any URL. Strips ads, nav, and boilerplate.',
    { url: z.string().url().describe('URL to fetch') },
    async ({ url }) => {
      try {
        const result = await fetchUrl(url)
        return { content: [{ type: 'text', text: `# ${result.title}\n\n${result.content}` }] }
      } catch (e) {
        return { content: [{ type: 'text', text: `Fetch failed: ${e.message}` }] }
      }
    }
  )

  server.tool(
    'get_weather',
    'Get current weather for any city or location.',
    { location: z.string().describe('City name or address, e.g. "Barcelona" or "New York, NY"') },
    async ({ location }) => {
      try {
        const w = await getWeather(location)
        return { content: [{ type: 'text', text: JSON.stringify(w, null, 2) }] }
      } catch (e) {
        return { content: [{ type: 'text', text: `Weather failed: ${e.message}` }] }
      }
    }
  )

  server.tool(
    'get_crypto_price',
    'Get real-time cryptocurrency prices in USD with 24h change. IDs from CoinGecko (bitcoin, ethereum, solana, etc.)',
    { ids: z.string().describe('Comma-separated coin IDs: bitcoin,ethereum,solana') },
    async ({ ids }) => {
      try {
        const coinIds = ids.split(',').map(s => s.trim()).slice(0, 10)
        const data = await getCryptoPrices(coinIds)
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
      } catch (e) {
        return { content: [{ type: 'text', text: `Crypto price failed: ${e.message}` }] }
      }
    }
  )

  server.tool(
    'get_stock_price',
    'Get real-time stock, ETF, or crypto price from Yahoo Finance. Examples: AAPL, TSLA, BTC-USD, ETH-USD, SPY',
    { symbol: z.string().describe('Ticker symbol: AAPL, TSLA, BTC-USD, SPY') },
    async ({ symbol }) => {
      try {
        const data = await getStockPrice(symbol.toUpperCase())
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
      } catch (e) {
        return { content: [{ type: 'text', text: `Stock lookup failed: ${e.message}` }] }
      }
    }
  )

  server.tool(
    'get_wikipedia',
    'Get a Wikipedia article summary for any topic.',
    { topic: z.string().describe('Topic or article title') },
    async ({ topic }) => {
      try {
        const data = await getWiki(topic)
        return { content: [{ type: 'text', text: `# ${data.title}\n\n${data.summary}\n\nSource: ${data.url}` }] }
      } catch (e) {
        return { content: [{ type: 'text', text: `Wikipedia lookup failed: ${e.message}` }] }
      }
    }
  )

  server.tool(
    'whois',
    'Look up domain WHOIS / RDAP info: registrar, nameservers, creation and expiry dates.',
    { domain: z.string().describe('Domain to look up, e.g. example.com') },
    async ({ domain }) => {
      try {
        const data = await getWhois(domain)
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
      } catch (e) {
        return { content: [{ type: 'text', text: `WHOIS failed: ${e.message}` }] }
      }
    }
  )

  server.tool(
    'dns_lookup',
    'DNS record lookup. Types: A, AAAA, MX, TXT, CNAME, NS, SOA, PTR.',
    {
      domain: z.string().describe('Domain to query'),
      type:   z.enum(['A', 'AAAA', 'MX', 'TXT', 'CNAME', 'NS', 'SOA', 'PTR']).default('A').optional(),
    },
    async ({ domain, type = 'A' }) => {
      try {
        const data = await dnsLookup(domain, type)
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
      } catch (e) {
        return { content: [{ type: 'text', text: `DNS lookup failed: ${e.message}` }] }
      }
    }
  )

  server.tool(
    'ip_info',
    'Get geolocation and ISP info for an IP address.',
    { ip: z.string().describe('IPv4 or IPv6 address') },
    async ({ ip }) => {
      try {
        const data = await getIpInfo(ip)
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
      } catch (e) {
        return { content: [{ type: 'text', text: `IP lookup failed: ${e.message}` }] }
      }
    }
  )

  server.tool(
    'wayback',
    'Check if a URL has been archived in the Wayback Machine and get the most recent snapshot.',
    { url: z.string().url().describe('URL to check') },
    async ({ url }) => {
      try {
        const data = await getWayback(url)
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
      } catch (e) {
        return { content: [{ type: 'text', text: `Wayback failed: ${e.message}` }] }
      }
    }
  )

  server.tool(
    'hacker_news',
    'Get top/new/best stories from Hacker News.',
    {
      feed:  z.enum(['top', 'new', 'best', 'ask', 'show']).default('top').optional(),
      limit: z.number().int().min(1).max(30).default(10).optional(),
    },
    async ({ feed = 'top', limit = 10 }) => {
      try {
        const stories = await getHnStories(feed, limit)
        return { content: [{ type: 'text', text: JSON.stringify({ feed, stories }, null, 2) }] }
      } catch (e) {
        return { content: [{ type: 'text', text: `HN failed: ${e.message}` }] }
      }
    }
  )

  // ── AI tools ─────────────────────────────────────────────────────────────────

  server.tool(
    'ai_summarize',
    'Summarize a text using AI. Returns a concise summary.',
    {
      text:   z.string().describe('Text to summarize'),
      length: z.enum(['short', 'medium', 'long']).default('medium').optional().describe('short=1-2 sentences, medium=3-5 sentences, long=paragraph'),
    },
    async ({ text, length = 'medium' }) => {
      try { return await callAiEndpoint('/ai/summarize', { text, length }, { pick: 'summary' }) }
      catch (e) { return { content: [{ type: 'text', text: `Summarize failed: ${e.message}` }] } }
    }
  )

  server.tool(
    'ai_translate',
    'Translate text to a target language using AI.',
    {
      text: z.string().describe('Text to translate'),
      to:   z.string().describe('Target language, e.g. Spanish, French, Japanese, Arabic'),
      from: z.string().optional().describe('Source language (auto-detected if omitted)'),
    },
    async ({ text, to, from }) => {
      try { return await callAiEndpoint('/ai/translate', { text, to, from }, { pick: 'translation' }) }
      catch (e) { return { content: [{ type: 'text', text: `Translate failed: ${e.message}` }] } }
    }
  )

  server.tool(
    'ai_sentiment',
    'Analyze the sentiment of text: positive, negative, or neutral with a confidence score.',
    { text: z.string().describe('Text to analyze') },
    async ({ text }) => {
      try { return await callAiEndpoint('/ai/sentiment', { text }, { timeout: 20000 }) }
      catch (e) { return { content: [{ type: 'text', text: `Sentiment failed: ${e.message}` }] } }
    }
  )

  server.tool(
    'ai_extract',
    'Extract structured data from text according to a schema. Schema maps field names to descriptions.',
    {
      text:   z.string().describe('Source text'),
      schema: z.record(z.string()).describe('Schema: { "field": "description of what to extract" }'),
    },
    async ({ text, schema }) => {
      try { return await callAiEndpoint('/ai/extract', { text, schema }) }
      catch (e) { return { content: [{ type: 'text', text: `Extract failed: ${e.message}` }] } }
    }
  )

  server.tool(
    'ai_vision',
    'Describe an image or answer a question about it. Pass a publicly accessible image URL.',
    {
      image_url: z.string().url().describe('URL of the image to analyze'),
      question:  z.string().optional().describe('Question about the image (default: describe it)'),
    },
    async ({ image_url, question }) => {
      try { return await callAiEndpoint('/ai/vision', { image_url, question: question || 'Describe this image in detail.' }, { pick: 'answer' }) }
      catch (e) { return { content: [{ type: 'text', text: `Vision failed: ${e.message}` }] } }
    }
  )

  // ── Compute tools ────────────────────────────────────────────────────────────

  server.tool(
    'hash_text',
    'Hash a string with md5, sha1, sha256, or sha512.',
    {
      text: z.string().describe('Text to hash'),
      algo: z.enum(['md5', 'sha1', 'sha256', 'sha512']).default('sha256').optional(),
    },
    async ({ text, algo = 'sha256' }) => {
      try {
        return { content: [{ type: 'text', text: JSON.stringify(hashText(text, algo), null, 2) }] }
      } catch (e) {
        return { content: [{ type: 'text', text: `Hash failed: ${e.message}` }] }
      }
    }
  )

  server.tool(
    'generate_uuid',
    'Generate one or more UUID v4 values.',
    { n: z.number().int().min(1).max(100).default(1).optional().describe('How many UUIDs to generate') },
    async ({ n = 1 }) => {
      return { content: [{ type: 'text', text: JSON.stringify(generateUuids(n), null, 2) }] }
    }
  )

  server.tool(
    'base64',
    'Encode or decode a string with base64.',
    {
      data:   z.string().describe('Data to encode or decode'),
      action: z.enum(['encode', 'decode']).default('encode').optional(),
    },
    async ({ data, action = 'encode' }) => {
      try {
        const result = action === 'decode' ? base64Decode(data) : base64Encode(data)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (e) {
        return { content: [{ type: 'text', text: `Base64 failed: ${e.message}` }] }
      }
    }
  )

  server.tool(
    'math_eval',
    'Evaluate a math expression safely. Supports all Math.* functions: Math.sqrt(2), Math.PI, Math.pow(2,10), etc.',
    { expr: z.string().describe('Math expression to evaluate, e.g. "Math.sqrt(2) * 100"') },
    async ({ expr }) => {
      try {
        return { content: [{ type: 'text', text: JSON.stringify(evalMath(expr), null, 2) }] }
      } catch (e) {
        return { content: [{ type: 'text', text: `Math eval failed: ${e.message}` }] }
      }
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
