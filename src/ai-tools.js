import { assertPublicUrl } from './net-guard.js'

const OR_BASE = 'https://openrouter.ai/api/v1'

function orHeaders(title = 'AIRadar') {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not configured')
  return {
    'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
    'Content-Type':  'application/json',
    'HTTP-Referer':  'https://airadar.fyi',
    'X-Title':       title,
  }
}

async function llm(system, user, model = 'openai/gpt-4o-mini', maxTokens = 512) {
  const res = await fetch(`${OR_BASE}/chat/completions`, {
    method: 'POST',
    headers: orHeaders(),
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user   },
      ],
      max_tokens:  maxTokens,
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message || `OpenRouter HTTP ${res.status}`)
  }
  const data = await res.json()
  return data.choices?.[0]?.message?.content?.trim() || ''
}

function tryJson(raw, fallback) {
  try { return JSON.parse(raw) } catch { return fallback || { raw } }
}

// ── TTS ───────────────────────────────────────────────────────────────────────
export async function textToSpeech(text, voice = 'alloy', model = 'openai/tts-1') {
  const res = await fetch(`${OR_BASE}/audio/speech`, {
    method: 'POST',
    headers: orHeaders('AIRadar TTS'),
    body: JSON.stringify({ model, input: text, voice }),
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message || `TTS HTTP ${res.status}`)
  }
  return res
}

// ── Image generation ──────────────────────────────────────────────────────────
export async function generateImage(prompt, model = 'openai/dall-e-3', size = '1024x1024') {
  const res = await fetch(`${OR_BASE}/images/generations`, {
    method: 'POST',
    headers: orHeaders('AIRadar Image'),
    body: JSON.stringify({ model, prompt, n: 1, size }),
    signal: AbortSignal.timeout(60000),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message || `Image gen HTTP ${res.status}`)
  }
  return res.json()
}

// ── Vision (image → text) ─────────────────────────────────────────────────────
export async function askVision(imageUrl, question, model = 'openai/gpt-4o-mini') {
  const res = await fetch(`${OR_BASE}/chat/completions`, {
    method: 'POST',
    headers: orHeaders('AIRadar Vision'),
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl } },
          { type: 'text', text: question },
        ],
      }],
      max_tokens: 1024,
    }),
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message || `Vision HTTP ${res.status}`)
  }
  const data = await res.json()
  return { answer: data.choices?.[0]?.message?.content?.trim() || '', model }
}

// ── STT (audio URL → transcript) ──────────────────────────────────────────────
export async function transcribeAudio(audioUrl, model = 'openai/whisper-1') {
  await assertPublicUrl(audioUrl)
  const audioRes = await fetch(audioUrl, { signal: AbortSignal.timeout(30000), redirect: 'error' })
  if (!audioRes.ok) throw new Error(`Could not fetch audio: HTTP ${audioRes.status}`)
  const audioBuffer = await audioRes.arrayBuffer()
  const contentType = audioRes.headers.get('content-type') || 'audio/mpeg'
  const ext = contentType.includes('wav') ? 'wav' : contentType.includes('ogg') ? 'ogg' : 'mp3'

  const form = new FormData()
  form.append('file', new Blob([audioBuffer], { type: contentType }), `audio.${ext}`)
  form.append('model', model)

  const headers = orHeaders('AIRadar STT')
  delete headers['Content-Type'] // let FormData set it with boundary

  const res = await fetch(`${OR_BASE}/audio/transcriptions`, {
    method: 'POST', headers, body: form, signal: AbortSignal.timeout(60000),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message || `STT HTTP ${res.status}`)
  }
  const data = await res.json()
  return { transcript: data.text || '', model }
}

// ── LLM wrappers ──────────────────────────────────────────────────────────────
export async function translate(text, to, from = 'auto') {
  const from_ = from !== 'auto' ? `Source: ${from}.` : ''
  const result = await llm(
    `You are a professional translator. ${from_} Translate to ${to}. Return ONLY the translation, no explanation.`,
    text, 'openai/gpt-4o-mini', 2048
  )
  return { translation: result, target: to, source: from }
}

export async function summarize(text, length = 'medium') {
  const lengths = { short: '1–2 sentences', medium: '3–5 sentences', long: 'one concise paragraph' }
  const result = await llm(
    `Summarize in ${lengths[length] || lengths.medium}. Return ONLY the summary.`,
    text, 'openai/gpt-4o-mini', 512
  )
  return { summary: result, length }
}

export async function sentiment(text) {
  const raw = await llm(
    'Analyse sentiment. Return ONLY JSON: {"label":"positive|negative|neutral","score":0.0-1.0,"reasoning":"one sentence"}',
    text.slice(0, 4000), 'openai/gpt-4o-mini', 100
  )
  return tryJson(raw, { label: raw, score: null, reasoning: null })
}

export async function detectLanguage(text) {
  const raw = await llm(
    'Detect the language. Return ONLY JSON: {"language":"English","code":"en","confidence":0.0-1.0}',
    text.slice(0, 500), 'openai/gpt-4o-mini', 60
  )
  return tryJson(raw, { language: raw, code: null, confidence: null })
}

export async function classify(text, labels) {
  const safeLabels = labels.slice(0, 20).map(l => String(l).slice(0, 100))
  const raw = await llm(
    `Classify into one of these categories: ${JSON.stringify(safeLabels)}. Return ONLY JSON: {"label":"chosen","confidence":0.0-1.0}`,
    text, 'openai/gpt-4o-mini', 80
  )
  return tryJson(raw, { label: raw, confidence: null })
}

export async function fixGrammar(text) {
  const result = await llm(
    'Fix grammar, spelling and punctuation. Return ONLY the corrected text.',
    text, 'openai/gpt-4o-mini', 2048
  )
  return { corrected: result }
}

export async function extractEntities(text) {
  const raw = await llm(
    'Extract named entities. Return ONLY JSON: {"people":[],"places":[],"organizations":[],"dates":[],"other":[]}',
    text, 'openai/gpt-4o-mini', 512
  )
  return tryJson(raw, { people:[], places:[], organizations:[], dates:[], other:[] })
}

export async function extractStructured(text, schema) {
  const raw = await llm(
    `Extract data according to this JSON schema and return ONLY valid JSON matching it:\n${JSON.stringify(schema, null, 2)}`,
    text, 'openai/gpt-4o-mini', 2048
  )
  return tryJson(raw, { raw })
}

// ── Route registration ────────────────────────────────────────────────────────
export function registerAiRoutes(app, { req3, req5, req8, req50 }) {

  // TTS — returns audio bytes
  app.post('/ai/tts', req5, async (req, res) => {
    const { text, voice = 'alloy', model = 'openai/tts-1' } = req.body || {}
    if (!text) return res.status(400).json({ error: 'Missing "text"' })
    try {
      const upstream = await textToSpeech(text, voice, model)
      res.set('Content-Type', 'audio/mpeg')
      upstream.body.pipe(res)
    } catch (e) { res.status(502).json({ error: e.message }) }
  })

  // Image generation
  app.post('/ai/image', req50, async (req, res) => {
    const { prompt, model = 'openai/dall-e-3', size = '1024x1024' } = req.body || {}
    if (!prompt) return res.status(400).json({ error: 'Missing "prompt"' })
    try {
      res.locals.model = model
      res.json(await generateImage(prompt, model, size))
    } catch (e) { res.status(502).json({ error: e.message }) }
  })

  // Vision
  app.post('/ai/vision', req8, async (req, res) => {
    const { image_url, question, model } = req.body || {}
    if (!image_url || !question) return res.status(400).json({ error: 'Missing "image_url" or "question"' })
    try {
      res.locals.model = model || 'openai/gpt-4o-mini'
      res.json(await askVision(image_url, question, model))
    } catch (e) { res.status(502).json({ error: e.message }) }
  })

  // STT
  app.post('/ai/stt', req5, async (req, res) => {
    const { audio_url, model } = req.body || {}
    if (!audio_url) return res.status(400).json({ error: 'Missing "audio_url"' })
    try { res.json(await transcribeAudio(audio_url, model)) }
    catch (e) { res.status(502).json({ error: e.message }) }
  })

  // LLM wrappers
  app.post('/ai/translate', req5, async (req, res) => {
    const { text, to, from } = req.body || {}
    if (!text || !to) return res.status(400).json({ error: 'Missing "text" or "to"' })
    try { res.json(await translate(text, to, from)) }
    catch (e) { res.status(502).json({ error: e.message }) }
  })

  app.post('/ai/summarize', req3, async (req, res) => {
    const { text, length } = req.body || {}
    if (!text) return res.status(400).json({ error: 'Missing "text"' })
    try { res.json(await summarize(text, length)) }
    catch (e) { res.status(502).json({ error: e.message }) }
  })

  app.post('/ai/sentiment', req3, async (req, res) => {
    const { text } = req.body || {}
    if (!text) return res.status(400).json({ error: 'Missing "text"' })
    try { res.json(await sentiment(text)) }
    catch (e) { res.status(502).json({ error: e.message }) }
  })

  app.post('/ai/lang', req3, async (req, res) => {
    const { text } = req.body || {}
    if (!text) return res.status(400).json({ error: 'Missing "text"' })
    try { res.json(await detectLanguage(text)) }
    catch (e) { res.status(502).json({ error: e.message }) }
  })

  app.post('/ai/classify', req3, async (req, res) => {
    const { text, labels } = req.body || {}
    if (!text || !Array.isArray(labels) || !labels.length) return res.status(400).json({ error: 'Missing "text" or "labels"' })
    try { res.json(await classify(text, labels)) }
    catch (e) { res.status(502).json({ error: e.message }) }
  })

  app.post('/ai/grammar', req3, async (req, res) => {
    const { text } = req.body || {}
    if (!text) return res.status(400).json({ error: 'Missing "text"' })
    try { res.json(await fixGrammar(text)) }
    catch (e) { res.status(502).json({ error: e.message }) }
  })

  app.post('/ai/entities', req5, async (req, res) => {
    const { text } = req.body || {}
    if (!text) return res.status(400).json({ error: 'Missing "text"' })
    try { res.json(await extractEntities(text)) }
    catch (e) { res.status(502).json({ error: e.message }) }
  })

  app.post('/ai/extract', req5, async (req, res) => {
    const { text, schema } = req.body || {}
    if (!text || !schema) return res.status(400).json({ error: 'Missing "text" or "schema"' })
    try { res.json(await extractStructured(text, schema)) }
    catch (e) { res.status(502).json({ error: e.message }) }
  })
}
