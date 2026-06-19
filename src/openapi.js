// OpenAPI 3.0 spec + OpenAI plugin manifest
// GET /openapi.json  — standard tool discovery for all agent frameworks
// GET /.well-known/ai-plugin.json — OpenAI plugin / ChatGPT action format

const BASE = 'https://airadar.fyi'
const VERSION = '2.1.0'

const PAYMENT_NOTE = 'Pay-per-use: L402 (Lightning sats) or x402 (USDC on Base/Polygon/Arbitrum/Solana). No account or API key needed. Call endpoint → receive HTTP 402 with invoice → pay → retry with Authorization header.'

function spec() {
  return {
    openapi: '3.0.3',
    info: {
      title: 'AIRadar API',
      version: VERSION,
      description: `AI agent service hub — pay-per-use, no registration. ${PAYMENT_NOTE}\n\nSupports L402 (Lightning) and x402 (USDC). Use the SDK: npm i @airadar/airadar`,
      contact: { url: BASE },
      license: { name: 'MIT' },
    },
    servers: [{ url: BASE, description: 'Production' }],
    security: [],
    tags: [
      { name: 'providers',  description: 'AI inference provider directory (Routstr/Nostr network)' },
      { name: 'gateway',    description: 'OpenAI-compatible inference gateway (340+ models)' },
      { name: 'search',     description: 'Web and news search' },
      { name: 'fetch',      description: 'URL content extraction' },
      { name: 'data',       description: 'Real-time data APIs' },
      { name: 'ai',         description: 'AI utility tools (summarize, translate, vision, etc.)' },
      { name: 'compute',    description: 'Computation utilities' },
      { name: 'state',      description: 'Agent state persistence (counters, logs, queues)' },
      { name: 'memory',     description: 'Key-value memory store' },
      { name: 'reputation', description: 'Agent reputation scoring' },
      { name: 'mcp',        description: 'Model Context Protocol server' },
    ],
    paths: {

      // ── Public / free ───────────────────────────────────────────────────────
      '/health': {
        get: {
          tags: ['providers'], operationId: 'health', summary: 'Service health check', security: [],
          responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, price_sats: { type: 'integer' } } } } } } },
        },
      },
      '/info': {
        get: {
          tags: ['providers'], operationId: 'serviceInfo', summary: 'Full service description and endpoint catalogue', security: [],
          responses: { 200: { description: 'Service metadata', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/free': {
        get: {
          tags: ['providers'], operationId: 'freeProviders', summary: 'Free preview: top 3 online AI providers', security: [],
          responses: { 200: { description: 'Provider list' } },
        },
      },

      // ── Providers / models ──────────────────────────────────────────────────
      '/providers': {
        get: {
          tags: ['providers'], operationId: 'listProviders', summary: 'Full directory of online AI inference providers',
          description: `${PAYMENT_NOTE}\n\nReturns all providers with models, pricing (sats), uptime, and Lightning payment endpoints.`,
          parameters: [{ name: 'network', in: 'query', schema: { type: 'string' }, description: 'Filter by network: routstr | antseed' }],
          responses: { 200: { description: 'Provider list with models' }, 402: { description: 'Payment required' } },
        },
      },
      '/providers/best': {
        get: {
          tags: ['providers'], operationId: 'bestProvider', summary: 'Best provider for a model, optimized by price/speed/reliability',
          parameters: [
            { name: 'model', in: 'query', schema: { type: 'string' }, description: 'Model ID (e.g. gpt-4o, claude-3-5-sonnet)' },
            { name: 'optimize', in: 'query', schema: { type: 'string', enum: ['price', 'speed', 'reliability'] } },
          ],
          responses: { 200: { description: 'Best provider with usage instructions' }, 402: { description: 'Payment required' } },
        },
      },
      '/models': {
        get: {
          tags: ['gateway'], operationId: 'listAllModels', summary: 'All models across all providers (340+)',
          parameters: [
            { name: 'id', in: 'query', schema: { type: 'string' } },
            { name: 'modality', in: 'query', schema: { type: 'string', enum: ['text', 'image', 'audio', 'text+image'] } },
          ],
          responses: { 200: { description: 'Model list with pricing in sats' }, 402: { description: 'Payment required' } },
        },
      },
      '/v1/models': {
        get: {
          tags: ['gateway'], operationId: 'openaiModels', summary: 'OpenAI-compatible model list (free)', security: [],
          responses: { 200: { description: 'OpenAI format model list' } },
        },
      },
      '/v1/chat/completions': {
        post: {
          tags: ['gateway'], operationId: 'chatCompletion', summary: 'OpenAI-compatible chat inference gateway (340+ models)',
          description: `${PAYMENT_NOTE}\n\nPricing in sats: free models (50 sats), small (150), medium (400), large frontier (1000+).`,
          requestBody: {
            required: true,
            content: { 'application/json': { schema: {
              type: 'object', required: ['model', 'messages'],
              properties: {
                model:       { type: 'string', example: 'openai/gpt-4o' },
                messages:    { type: 'array', items: { type: 'object', properties: { role: { type: 'string' }, content: { type: 'string' } } } },
                temperature: { type: 'number' },
                max_tokens:  { type: 'integer' },
                stream:      { type: 'boolean' },
              },
            } } },
          },
          responses: { 200: { description: 'OpenAI-format completion' }, 402: { description: 'Payment required' } },
        },
      },
      '/route': {
        post: {
          tags: ['providers'], operationId: 'routeRequest', summary: 'Find best provider for your requirements',
          requestBody: {
            content: { 'application/json': { schema: {
              type: 'object', properties: {
                modality:              { type: 'string', enum: ['text', 'image', 'audio'] },
                max_price_sats_per_1k: { type: 'number' },
                min_context_length:    { type: 'integer' },
                model_id:              { type: 'string' },
              },
            } } },
          },
          responses: { 200: { description: 'Recommended provider with endpoint and usage instructions' }, 402: { description: 'Payment required' } },
        },
      },

      // ── Search ──────────────────────────────────────────────────────────────
      '/search': {
        get: {
          tags: ['search'], operationId: 'webSearch', summary: 'Web search — returns clean JSON results',
          parameters: [
            { name: 'q', in: 'query', required: true, schema: { type: 'string' }, description: 'Search query' },
            { name: 'n', in: 'query', schema: { type: 'integer', default: 5, maximum: 10 } },
            { name: 'type', in: 'query', schema: { type: 'string', enum: ['web', 'news'], default: 'web' } },
            { name: 'freshness', in: 'query', schema: { type: 'string', enum: ['pd', 'pw', 'pm', 'py'] }, description: 'pd=day, pw=week, pm=month, py=year' },
          ],
          responses: { 200: { description: 'Search results' }, 402: { description: 'Payment required' } },
        },
      },

      // ── Fetch ───────────────────────────────────────────────────────────────
      '/fetch': {
        get: {
          tags: ['fetch'], operationId: 'fetchUrl', summary: 'Fetch and extract clean text from any URL (Readability)',
          parameters: [{ name: 'url', in: 'query', required: true, schema: { type: 'string', format: 'uri' } }],
          responses: { 200: { description: 'Extracted article: { url, title, content, word_count }' }, 402: { description: 'Payment required' } },
        },
      },

      // ── Data ────────────────────────────────────────────────────────────────
      '/data/crypto': {
        get: {
          tags: ['data'], operationId: 'cryptoPrices', summary: 'Cryptocurrency prices (CoinGecko)',
          parameters: [{ name: 'ids', in: 'query', schema: { type: 'string' }, description: 'Comma-separated coin IDs: bitcoin,ethereum,solana', example: 'bitcoin,ethereum' }],
          responses: { 200: { description: 'Prices in USD with 24h change' }, 402: { description: 'Payment required' } },
        },
      },
      '/data/btc/fees': {
        get: {
          tags: ['data'], operationId: 'btcFees', summary: 'Bitcoin mempool fee estimates (mempool.space)',
          responses: { 200: { description: 'Sat/vB fee estimates' }, 402: { description: 'Payment required' } },
        },
      },
      '/data/fx': {
        get: {
          tags: ['data'], operationId: 'fxRates', summary: 'Foreign exchange rates (Frankfurter)',
          parameters: [
            { name: 'base', in: 'query', schema: { type: 'string', default: 'USD' } },
            { name: 'to', in: 'query', schema: { type: 'string' }, description: 'Comma-separated target currencies: EUR,GBP,JPY' },
          ],
          responses: { 200: { description: 'Exchange rates' }, 402: { description: 'Payment required' } },
        },
      },
      '/data/stock': {
        get: {
          tags: ['data'], operationId: 'stockPrice', summary: 'Stock / ETF / crypto price (Yahoo Finance)',
          parameters: [{ name: 'symbol', in: 'query', required: true, schema: { type: 'string' }, description: 'Ticker: AAPL, TSLA, BTC-USD, ETH-USD, SPY', example: 'AAPL' }],
          responses: { 200: { description: 'Price, change, volume, 52w range' }, 402: { description: 'Payment required' } },
        },
      },
      '/data/weather': {
        get: {
          tags: ['data'], operationId: 'weather', summary: 'Current weather for any location (Open-Meteo)',
          parameters: [{ name: 'location', in: 'query', required: true, schema: { type: 'string' }, description: 'City name or address', example: 'Barcelona' }],
          responses: { 200: { description: 'Temperature, humidity, wind, precipitation' }, 402: { description: 'Payment required' } },
        },
      },
      '/data/ip': {
        get: {
          tags: ['data'], operationId: 'ipInfo', summary: 'IP geolocation (ip-api.com)',
          parameters: [{ name: 'ip', in: 'query', schema: { type: 'string' }, description: 'IPv4 or IPv6 address (omit for caller IP)' }],
          responses: { 200: { description: 'Country, city, ISP, coordinates' }, 402: { description: 'Payment required' } },
        },
      },
      '/data/dns': {
        get: {
          tags: ['data'], operationId: 'dnsLookup', summary: 'DNS lookup',
          parameters: [
            { name: 'domain', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'type', in: 'query', schema: { type: 'string', enum: ['A', 'AAAA', 'MX', 'TXT', 'CNAME', 'NS', 'SOA', 'PTR'], default: 'A' } },
          ],
          responses: { 200: { description: 'DNS records' }, 402: { description: 'Payment required' } },
        },
      },
      '/data/whois': {
        get: {
          tags: ['data'], operationId: 'whois', summary: 'Domain WHOIS / RDAP info',
          parameters: [{ name: 'domain', in: 'query', required: true, schema: { type: 'string' }, example: 'example.com' }],
          responses: { 200: { description: 'Registrar, nameservers, dates, status' }, 402: { description: 'Payment required' } },
        },
      },
      '/data/email': {
        get: {
          tags: ['data'], operationId: 'emailValidate', summary: 'Email address validation + MX check',
          parameters: [{ name: 'email', in: 'query', required: true, schema: { type: 'string', format: 'email' } }],
          responses: { 200: { description: 'format_valid, mx_exists, disposable' }, 402: { description: 'Payment required' } },
        },
      },
      '/data/wiki': {
        get: {
          tags: ['data'], operationId: 'wikipedia', summary: 'Wikipedia article summary',
          parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' }, description: 'Topic or article title' }],
          responses: { 200: { description: 'title, summary, url, image' }, 402: { description: 'Payment required' } },
        },
      },
      '/data/hn': {
        get: {
          tags: ['data'], operationId: 'hackerNews', summary: 'Hacker News stories',
          parameters: [
            { name: 'feed', in: 'query', schema: { type: 'string', enum: ['top', 'new', 'best', 'ask', 'show'], default: 'top' } },
            { name: 'n', in: 'query', schema: { type: 'integer', default: 10, maximum: 30 } },
          ],
          responses: { 200: { description: 'Stories with title, url, score, comments' }, 402: { description: 'Payment required' } },
        },
      },
      '/data/news': {
        get: {
          tags: ['data', 'search'], operationId: 'newsSearch', summary: 'News search (SearXNG aggregator)',
          parameters: [
            { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'n', in: 'query', schema: { type: 'integer', default: 5, maximum: 10 } },
          ],
          responses: { 200: { description: 'News results: title, url, snippet' }, 402: { description: 'Payment required' } },
        },
      },
      '/data/github': {
        get: {
          tags: ['data'], operationId: 'githubRepo', summary: 'GitHub repository stats',
          parameters: [{ name: 'repo', in: 'query', required: true, schema: { type: 'string' }, example: 'anthropics/claude-code' }],
          responses: { 200: { description: 'Stars, forks, issues, language, topics' }, 402: { description: 'Payment required' } },
        },
      },
      '/data/feed': {
        get: {
          tags: ['data'], operationId: 'rssFeed', summary: 'Parse RSS/Atom feed',
          parameters: [
            { name: 'url', in: 'query', required: true, schema: { type: 'string', format: 'uri' } },
            { name: 'n', in: 'query', schema: { type: 'integer', default: 10, maximum: 50 } },
          ],
          responses: { 200: { description: 'Feed title + items array' }, 402: { description: 'Payment required' } },
        },
      },
      '/data/wayback': {
        get: {
          tags: ['data'], operationId: 'wayback', summary: 'Wayback Machine — check if a URL is archived',
          parameters: [{ name: 'url', in: 'query', required: true, schema: { type: 'string', format: 'uri' } }],
          responses: { 200: { description: '{ available, snapshot: { url, date } }' }, 402: { description: 'Payment required' } },
        },
      },

      // ── AI tools ────────────────────────────────────────────────────────────
      '/ai/summarize': {
        post: {
          tags: ['ai'], operationId: 'summarize', summary: 'Summarize text',
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, max_words: { type: 'integer', default: 150 } } } } } },
          responses: { 200: { description: 'Summary text' }, 402: { description: 'Payment required' } },
        },
      },
      '/ai/translate': {
        post: {
          tags: ['ai'], operationId: 'translate', summary: 'Translate text to a target language',
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['text', 'to'], properties: { text: { type: 'string' }, to: { type: 'string', example: 'Spanish' }, from: { type: 'string' } } } } } },
          responses: { 200: { description: 'Translated text' }, 402: { description: 'Payment required' } },
        },
      },
      '/ai/sentiment': {
        post: {
          tags: ['ai'], operationId: 'sentiment', summary: 'Sentiment analysis',
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } } } },
          responses: { 200: { description: 'positive/negative/neutral + score' }, 402: { description: 'Payment required' } },
        },
      },
      '/ai/classify': {
        post: {
          tags: ['ai'], operationId: 'classify', summary: 'Zero-shot text classification',
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['text', 'labels'], properties: { text: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } } } } } },
          responses: { 200: { description: 'Ranked labels with scores' }, 402: { description: 'Payment required' } },
        },
      },
      '/ai/extract': {
        post: {
          tags: ['ai'], operationId: 'extract', summary: 'Structured data extraction from text',
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['text', 'schema'], properties: { text: { type: 'string' }, schema: { type: 'object', description: '{ fieldName: "description" }' } } } } } },
          responses: { 200: { description: 'Extracted structured data' }, 402: { description: 'Payment required' } },
        },
      },
      '/ai/entities': {
        post: {
          tags: ['ai'], operationId: 'entities', summary: 'Named entity recognition (NER)',
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } } } },
          responses: { 200: { description: 'Entities: people, orgs, locations, dates' }, 402: { description: 'Payment required' } },
        },
      },
      '/ai/lang': {
        post: {
          tags: ['ai'], operationId: 'detectLang', summary: 'Language detection',
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } } } },
          responses: { 200: { description: 'Detected language + confidence' }, 402: { description: 'Payment required' } },
        },
      },
      '/ai/grammar': {
        post: {
          tags: ['ai'], operationId: 'grammar', summary: 'Grammar and spelling correction',
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } } } },
          responses: { 200: { description: 'Corrected text with diff' }, 402: { description: 'Payment required' } },
        },
      },
      '/ai/vision': {
        post: {
          tags: ['ai'], operationId: 'vision', summary: 'Vision — describe or answer questions about an image URL',
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['image_url'], properties: { image_url: { type: 'string', format: 'uri' }, question: { type: 'string' } } } } } },
          responses: { 200: { description: 'Description or answer' }, 402: { description: 'Payment required' } },
        },
      },
      '/ai/tts': {
        post: {
          tags: ['ai'], operationId: 'tts', summary: 'Text-to-speech — returns MP3 audio',
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, voice: { type: 'string', default: 'alloy' } } } } } },
          responses: { 200: { description: 'audio/mpeg stream' }, 402: { description: 'Payment required' } },
        },
      },
      '/ai/stt': {
        post: {
          tags: ['ai'], operationId: 'stt', summary: 'Speech-to-text from audio URL',
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['audio_url'], properties: { audio_url: { type: 'string', format: 'uri' }, model: { type: 'string' } } } } } },
          responses: { 200: { description: 'Transcription text' }, 402: { description: 'Payment required' } },
        },
      },
      '/ai/image': {
        post: {
          tags: ['ai'], operationId: 'generateImage', summary: 'Text-to-image generation — returns PNG',
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' }, size: { type: 'string', enum: ['256x256', '512x512', '1024x1024'], default: '512x512' } } } } } },
          responses: { 200: { description: 'image/png stream' }, 402: { description: 'Payment required' } },
        },
      },

      // ── Compute ─────────────────────────────────────────────────────────────
      '/compute/tokens': {
        post: {
          tags: ['compute'], operationId: 'countTokens', summary: 'Count tokens in text (GPT tokenizer)',
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } } } },
          responses: { 200: { description: '{ token_count, char_count, words_approx }' }, 402: { description: 'Payment required' } },
        },
      },
      '/compute/hash': {
        get: {
          tags: ['compute'], operationId: 'hashText', summary: 'Hash text (md5/sha1/sha256/sha512)',
          parameters: [
            { name: 'text', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'algo', in: 'query', schema: { type: 'string', enum: ['md5', 'sha1', 'sha256', 'sha512'], default: 'sha256' } },
          ],
          responses: { 200: { description: '{ algorithm, hash }' }, 402: { description: 'Payment required' } },
        },
      },
      '/compute/uuid': {
        get: {
          tags: ['compute'], operationId: 'generateUuid', summary: 'Generate UUID v4',
          parameters: [{ name: 'n', in: 'query', schema: { type: 'integer', default: 1, maximum: 100 }, description: 'How many UUIDs to generate' }],
          responses: { 200: { description: '{ uuid } or { uuids: [] }' }, 402: { description: 'Payment required' } },
        },
      },
      '/compute/base64': {
        get: {
          tags: ['compute'], operationId: 'base64', summary: 'Base64 encode or decode',
          parameters: [
            { name: 'data', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'action', in: 'query', schema: { type: 'string', enum: ['encode', 'decode'], default: 'encode' } },
          ],
          responses: { 200: { description: '{ encoded } or { decoded }' }, 402: { description: 'Payment required' } },
        },
      },
      '/compute/math': {
        get: {
          tags: ['compute'], operationId: 'mathEval', summary: 'Evaluate a math expression safely',
          parameters: [{ name: 'expr', in: 'query', required: true, schema: { type: 'string' }, example: 'Math.sqrt(2) * 100' }],
          responses: { 200: { description: '{ expression, result }' }, 402: { description: 'Payment required' } },
        },
      },
      '/compute/qr': {
        get: {
          tags: ['compute'], operationId: 'qrCode', summary: 'Generate QR code PNG',
          parameters: [
            { name: 'data', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'size', in: 'query', schema: { type: 'integer', default: 300, minimum: 100, maximum: 1000 } },
          ],
          responses: { 200: { description: 'image/png' }, 402: { description: 'Payment required' } },
        },
      },
      '/compute/ssl': {
        get: {
          tags: ['compute'], operationId: 'sslInfo', summary: 'SSL certificate info for a domain',
          parameters: [{ name: 'domain', in: 'query', required: true, schema: { type: 'string' }, example: 'airadar.fyi' }],
          responses: { 200: { description: 'Issuer, expiry, SANs' }, 402: { description: 'Payment required' } },
        },
      },
      '/compute/port': {
        get: {
          tags: ['compute'], operationId: 'portCheck', summary: 'Check if a TCP port is open',
          parameters: [
            { name: 'host', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'port', in: 'query', required: true, schema: { type: 'integer', minimum: 1, maximum: 65535 } },
          ],
          responses: { 200: { description: '{ host, port, open }' }, 402: { description: 'Payment required' } },
        },
      },

      // ── Agent state ─────────────────────────────────────────────────────────
      '/state/counter/:agent_id/:name': {
        get: {
          tags: ['state'], operationId: 'counterGet', summary: 'Get a named counter value',
          parameters: [
            { name: 'agent_id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { 200: { description: '{ agent_id, name, value }' }, 402: { description: 'Payment required' } },
        },
      },
      '/state/counter/:agent_id/:name/increment': {
        post: {
          tags: ['state'], operationId: 'counterIncrement', summary: 'Increment a named counter',
          parameters: [
            { name: 'agent_id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { by: { type: 'integer', default: 1 } } } } } },
          responses: { 200: { description: '{ value }' }, 402: { description: 'Payment required' } },
        },
      },
      '/state/log/:agent_id': {
        get: {
          tags: ['state'], operationId: 'logRead', summary: 'Read agent log entries',
          parameters: [
            { name: 'agent_id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
          ],
          responses: { 200: { description: 'Log entries array' }, 402: { description: 'Payment required' } },
        },
        post: {
          tags: ['state'], operationId: 'logAppend', summary: 'Append event to agent log',
          parameters: [{ name: 'agent_id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['event'], properties: { event: { type: 'string' }, data: {} } } } } },
          responses: { 200: { description: 'Written entry' }, 402: { description: 'Payment required' } },
        },
      },
      '/state/queue': {
        post: {
          tags: ['state'], operationId: 'queueSubmit', summary: 'Submit a job to the queue',
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['type'], properties: { type: { type: 'string' }, payload: {} } } } } },
          responses: { 200: { description: '{ job_id }' }, 402: { description: 'Payment required' } },
        },
      },

      // ── Memory ──────────────────────────────────────────────────────────────
      '/memory/:agent_id': {
        get: {
          tags: ['memory'], operationId: 'memoryList', summary: 'List all memory keys for an agent',
          parameters: [{ name: 'agent_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Key list' }, 402: { description: 'Payment required' } },
        },
      },
      '/memory/:agent_id/:key': {
        get: {
          tags: ['memory'], operationId: 'memoryGet', summary: 'Get a memory value',
          parameters: [
            { name: 'agent_id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'key', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { 200: { description: '{ value }' }, 402: { description: 'Payment required' } },
        },
        put: {
          tags: ['memory'], operationId: 'memorySet', summary: 'Set a memory value (TTL optional)',
          parameters: [
            { name: 'agent_id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'key', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['value'], properties: { value: {}, ttl_seconds: { type: 'integer' } } } } } },
          responses: { 200: { description: 'OK' }, 402: { description: 'Payment required' } },
        },
        delete: {
          tags: ['memory'], operationId: 'memoryDelete', summary: 'Delete a memory key',
          parameters: [
            { name: 'agent_id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'key', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'Deleted' }, 402: { description: 'Payment required' } },
        },
      },

      // ── Reputation ──────────────────────────────────────────────────────────
      '/reputation': {
        get: {
          tags: ['reputation'], operationId: 'reputationLeaderboard', summary: 'Top agents by reputation (free)', security: [],
          responses: { 200: { description: 'Leaderboard' } },
        },
      },
      '/reputation/:id': {
        get: {
          tags: ['reputation'], operationId: 'reputationGet', summary: 'Agent reputation score 0–100 (free)', security: [],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'USDC wallet address or agent ID' }],
          responses: { 200: { description: '{ score, label, breakdown }' } },
        },
      },

      // ── MCP ─────────────────────────────────────────────────────────────────
      '/mcp': {
        get: {
          tags: ['mcp'], operationId: 'mcpServer', summary: 'MCP server (SSE transport) — all tools exposed as MCP tools', security: [],
          description: 'Compatible with Claude Desktop, ElizaOS, and any MCP client. Tools: list_providers, find_model, route, run_inference, compare_prices, web_search, fetch_url, weather, crypto, stock, wiki, news, hash, uuid, translate, summarize, sentiment',
          responses: { 200: { description: 'SSE stream' } },
        },
      },

      // ── Utility ─────────────────────────────────────────────────────────────
      '/embed': {
        post: {
          tags: ['ai'], operationId: 'embeddings', summary: 'Text embeddings (OpenAI-compatible)',
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['input'], properties: { input: {}, model: { type: 'string', default: 'openai/text-embedding-3-small' } } } } } },
          responses: { 200: { description: 'OpenAI-format embeddings response' }, 402: { description: 'Payment required' } },
        },
      },
      '/compare': {
        post: {
          tags: ['gateway'], operationId: 'compareModels', summary: 'Run same prompt on multiple models and compare responses',
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['prompt', 'models'], properties: { prompt: { type: 'string' }, models: { type: 'array', items: { type: 'string' }, maxItems: 5 }, system: { type: 'string' } } } } } },
          responses: { 200: { description: 'Responses from each model with latency' }, 402: { description: 'Payment required' } },
        },
      },
    },

    components: {
      securitySchemes: {
        L402: {
          type: 'http', scheme: 'bearer',
          description: 'L402 Lightning payment. Format: "L402 <payment_hash>:<preimage>". Call endpoint without auth → receive 402 with invoice → pay → retry.',
        },
        x402: {
          type: 'apiKey', in: 'header', name: 'X-PAYMENT',
          description: 'x402 USDC payment. Sign USDC transfer on Base/Polygon/Arbitrum/Solana → retry with X-PAYMENT header.',
        },
      },
    },
  }
}

export function registerOpenApiRoutes(app) {
  const openApiSpec = spec()

  app.get('/openapi.json', (_req, res) => {
    res.set('Access-Control-Allow-Origin', '*')
    res.json(openApiSpec)
  })

  app.get('/openapi.yaml', (_req, res) => {
    res.redirect(301, '/openapi.json')
  })

  app.get('/.well-known/ai-plugin.json', (_req, res) => {
    res.set('Access-Control-Allow-Origin', '*')
    res.json({
      schema_version: 'v1',
      name_for_model: 'airadar',
      name_for_human: 'AIRadar',
      description_for_model: `AIRadar is an AI agent service hub. It provides: web search, URL fetch+extract, real-time data (crypto, stocks, FX, weather, IP, DNS, WHOIS, Wikipedia, HN, GitHub, RSS, news, Wayback Machine), AI tools (summarize, translate, sentiment, classify, extract, entities, grammar, lang, vision, TTS, STT, image generation, embeddings), compute utilities (hash, UUID, base64, math, QR code, SSL, port check, token count), agent state (counters, logs, queues), key-value memory, reputation scoring, and an OpenAI-compatible inference gateway with 340+ models. All endpoints are pay-per-use via L402 Lightning or x402 USDC. No registration needed.`,
      description_for_human: 'Pay-per-use AI services hub: search, data APIs, AI tools, compute utilities, agent state, and 340+ model inference gateway.',
      auth: {
        type: 'none',
        instructions: 'Endpoints return HTTP 402 with a Lightning invoice or x402 USDC payment request. Pay and retry with Authorization header.',
      },
      api: {
        type: 'openapi',
        url: `${BASE}/openapi.json`,
        is_user_authenticated: false,
      },
      logo_url: `${BASE}/logo.png`,
      contact_email: 'hi@airadar.fyi',
      legal_info_url: `${BASE}/info`,
    })
  })
}
