import { promises as dns } from 'dns'
import Parser from 'rss-parser'
import { searchWeb } from './search.js'

const rss = new Parser({ timeout: 8000 })

// ── Crypto prices ─────────────────────────────────────────────────────────────
export async function getCryptoPrices(ids) {
  const query = ids.map(encodeURIComponent).join(',')
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${query}&vs_currencies=usd&include_24hr_change=true`,
    { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(8000) }
  )
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`)
  return res.json()
}

// ── Bitcoin mempool fees ──────────────────────────────────────────────────────
export async function getBtcFees() {
  const res = await fetch('https://mempool.space/api/v1/fees/recommended', {
    signal: AbortSignal.timeout(8000)
  })
  if (!res.ok) throw new Error(`mempool.space HTTP ${res.status}`)
  return res.json()
}

// ── FX rates ──────────────────────────────────────────────────────────────────
export async function getFxRates(base = 'USD', to = []) {
  const sym = to.length ? `&symbols=${to.join(',')}` : ''
  const res = await fetch(`https://api.frankfurter.app/latest?base=${base}${sym}`, {
    signal: AbortSignal.timeout(8000)
  })
  if (!res.ok) throw new Error(`Frankfurter HTTP ${res.status}`)
  return res.json()
}

// ── Weather ───────────────────────────────────────────────────────────────────
export async function getWeather(location) {
  const geoRes = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&format=json`,
    { signal: AbortSignal.timeout(8000) }
  )
  if (!geoRes.ok) throw new Error(`Geocoding HTTP ${geoRes.status}`)
  const geo = await geoRes.json()
  if (!geo.results?.length) throw new Error(`Location not found: ${location}`)
  const { latitude, longitude, name, country } = geo.results[0]

  const wRes = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,precipitation&forecast_days=1`,
    { signal: AbortSignal.timeout(8000) }
  )
  if (!wRes.ok) throw new Error(`Open-Meteo HTTP ${wRes.status}`)
  const { current } = await wRes.json()
  return {
    location: `${name}, ${country}`,
    latitude, longitude,
    temperature_c:   current.temperature_2m,
    humidity_pct:    current.relative_humidity_2m,
    wind_kmh:        current.wind_speed_10m,
    precipitation_mm:current.precipitation,
    weather_code:    current.weather_code,
    time:            current.time,
  }
}

// ── IP geolocation ────────────────────────────────────────────────────────────
export async function getIpInfo(ip) {
  const fields = 'status,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,query'
  const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=${fields}`, {
    signal: AbortSignal.timeout(8000)
  })
  if (!res.ok) throw new Error(`ip-api.com HTTP ${res.status}`)
  const data = await res.json()
  if (data.status === 'fail') throw new Error('IP lookup failed')
  delete data.status
  return data
}

// ── DNS lookup ────────────────────────────────────────────────────────────────
const DNS_TYPES = new Set(['A','AAAA','MX','TXT','CNAME','NS','SOA','PTR'])

export async function dnsLookup(domain, type = 'A') {
  const t = type.toUpperCase()
  if (!DNS_TYPES.has(t)) throw new Error(`Unsupported type ${type}. Valid: ${[...DNS_TYPES].join(', ')}`)
  const records = await dns.resolve(domain, t)
  return { domain, type: t, records }
}

// ── Email validation (MX check) ───────────────────────────────────────────────
const DISPOSABLE = new Set([
  'mailinator.com','guerrillamail.com','tempmail.com','10minutemail.com',
  'throwaway.email','yopmail.com','trashmail.com','sharklasers.com',
])

export async function validateEmail(email) {
  const parts = email.split('@')
  if (parts.length !== 2) throw new Error('Invalid email format')
  const [, domain] = parts
  let mxExists = false
  try { mxExists = (await dns.resolveMx(domain)).length > 0 } catch {}
  return {
    email,
    format_valid: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    mx_exists:    mxExists,
    disposable:   DISPOSABLE.has(domain.toLowerCase()),
    domain,
  }
}

// ── Wikipedia ─────────────────────────────────────────────────────────────────
export async function getWiki(topic) {
  const res = await fetch(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}`,
    { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(8000) }
  )
  if (res.status === 404) throw new Error(`No Wikipedia article for: ${topic}`)
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`)
  const d = await res.json()
  return {
    title:   d.title,
    summary: d.extract,
    url:     d.content_urls?.desktop?.page || null,
    image:   d.thumbnail?.source           || null,
  }
}

// ── Hacker News ───────────────────────────────────────────────────────────────
const HN_FEEDS = { top:'topstories', new:'newstories', ask:'askstories', show:'showstories', best:'beststories' }

export async function getHnStories(feed = 'top', limit = 10) {
  const key = HN_FEEDS[feed] || 'topstories'
  const idsRes = await fetch(`https://hacker-news.firebaseio.com/v0/${key}.json`, {
    signal: AbortSignal.timeout(8000)
  })
  const ids = (await idsRes.json()).slice(0, Math.min(limit, 30))
  const sig = AbortSignal.timeout(5000)
  const stories = await Promise.all(
    ids.map(id =>
      fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { signal: sig })
        .then(r => r.json()).catch(() => null)
    )
  )
  return stories.filter(Boolean).map(s => ({
    id:       s.id,
    title:    s.title,
    url:      s.url || `https://news.ycombinator.com/item?id=${s.id}`,
    score:    s.score,
    comments: s.descendants || 0,
    by:       s.by,
    time:     new Date(s.time * 1000).toISOString(),
  }))
}

// ── GitHub repo ───────────────────────────────────────────────────────────────
export async function getGithubRepo(repoPath) {
  const headers = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'AIRadar/2.0' }
  if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`
  const res = await fetch(`https://api.github.com/repos/${repoPath}`, { headers, signal: AbortSignal.timeout(8000) })
  if (res.status === 404) throw new Error(`Repository not found: ${repoPath}`)
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`)
  const d = await res.json()
  return {
    full_name:    d.full_name,
    description:  d.description,
    stars:        d.stargazers_count,
    forks:        d.forks_count,
    open_issues:  d.open_issues_count,
    language:     d.language,
    topics:       d.topics,
    license:      d.license?.spdx_id || null,
    created_at:   d.created_at,
    pushed_at:    d.pushed_at,
    url:          d.html_url,
    default_branch: d.default_branch,
  }
}

// ── RSS/Atom feed ─────────────────────────────────────────────────────────────
export async function parseFeed(feedUrl, limit = 10) {
  const feed = await rss.parseURL(feedUrl)
  return {
    title: feed.title || '',
    url:   feed.link  || feedUrl,
    items: feed.items.slice(0, limit).map(item => ({
      title:   item.title           || '',
      url:     item.link            || '',
      date:    item.isoDate         || null,
      summary: (item.contentSnippet || '').slice(0, 400),
    })),
  }
}

// ── WHOIS / domain RDAP ───────────────────────────────────────────────────────
export async function getWhois(domain) {
  const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
    headers: { 'Accept': 'application/rdap+json,application/json', 'User-Agent': 'AIRadar/2.0' },
    signal: AbortSignal.timeout(10000),
  })
  if (res.status === 404) throw new Error(`Domain not found: ${domain}`)
  if (!res.ok) throw new Error(`RDAP HTTP ${res.status}`)
  const d = await res.json()
  const getDate = (action) => d.events?.find(e => e.eventAction === action)?.eventDate || null
  const registrar  = d.entities?.find(e => e.roles?.includes('registrar'))
  const registrant = d.entities?.find(e => e.roles?.includes('registrant'))
  return {
    domain:          d.ldhName?.toLowerCase() || domain,
    status:          (d.status || []).map(s => s.replace('client', '').trim()),
    registrar:       registrar?.vcardArray?.[1]?.find(f => f[0] === 'fn')?.[3] || null,
    registrant_org:  registrant?.vcardArray?.[1]?.find(f => f[0] === 'org')?.[3] || null,
    nameservers:     (d.nameservers || []).map(ns => ns.ldhName?.toLowerCase()).filter(Boolean),
    created_at:      getDate('registration'),
    updated_at:      getDate('last changed'),
    expires_at:      getDate('expiration'),
  }
}

// ── Stock / ETF prices ────────────────────────────────────────────────────────
export async function getStockPrice(symbol) {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
    { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) }
  )
  if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status}`)
  const d = await res.json()
  const meta = d.chart?.result?.[0]?.meta
  if (!meta) throw new Error(`No data for symbol: ${symbol}`)
  return {
    symbol:               meta.symbol,
    name:                 meta.longName || meta.shortName || symbol,
    price:                meta.regularMarketPrice,
    previous_close:       meta.previousClose,
    change:               meta.previousClose != null ? +(meta.regularMarketPrice - meta.previousClose).toFixed(4) : null,
    change_pct:           meta.previousClose > 0 ? +((meta.regularMarketPrice - meta.previousClose) / meta.previousClose * 100).toFixed(2) : null,
    currency:             meta.currency,
    exchange:             meta.exchangeName,
    market_state:         meta.marketState,
    volume:               meta.regularMarketVolume,
    day_high:             meta.regularMarketDayHigh,
    day_low:              meta.regularMarketDayLow,
    fifty_two_week_high:  meta.fiftyTwoWeekHigh,
    fifty_two_week_low:   meta.fiftyTwoWeekLow,
    market_cap:           meta.marketCap || null,
    timestamp:            new Date(meta.regularMarketTime * 1000).toISOString(),
  }
}

// ── Wayback Machine ───────────────────────────────────────────────────────────
export async function getWayback(url) {
  const res = await fetch(
    `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`,
    { signal: AbortSignal.timeout(10000) }
  )
  if (!res.ok) throw new Error(`Wayback Machine HTTP ${res.status}`)
  const d = await res.json()
  const snap = d.archived_snapshots?.closest
  if (!snap?.available) return { url, available: false, snapshot: null }
  const ts = snap.timestamp
  return {
    url,
    available: true,
    snapshot: {
      url:    snap.url,
      status: snap.status,
      date:   new Date(`${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}T${ts.slice(8,10)}:${ts.slice(10,12)}:${ts.slice(12,14)}Z`).toISOString(),
    },
  }
}

// ── Route registration ────────────────────────────────────────────────────────
export function registerDataRoutes(app, { req1, req2, req3 }) {

  app.get('/data/crypto', req2, async (req, res) => {
    const ids = (req.query.ids || 'bitcoin,ethereum').split(',').map(s => s.trim()).slice(0, 20)
    try { res.json(await getCryptoPrices(ids)) }
    catch (e) { res.status(502).json({ error: e.message }) }
  })

  app.get('/data/btc/fees', req1, async (_req, res) => {
    try { res.json(await getBtcFees()) }
    catch (e) { res.status(502).json({ error: e.message }) }
  })

  app.get('/data/fx', req1, async (req, res) => {
    const base = (req.query.base || 'USD').toUpperCase()
    const to   = req.query.to ? req.query.to.split(',').map(s => s.trim().toUpperCase()) : []
    try { res.json(await getFxRates(base, to)) }
    catch (e) { res.status(502).json({ error: e.message }) }
  })

  app.get('/data/weather', req2, async (req, res) => {
    if (!req.query.location) return res.status(400).json({ error: 'Missing ?location=' })
    try { res.json(await getWeather(req.query.location)) }
    catch (e) { res.status(e.message.includes('not found') ? 404 : 502).json({ error: e.message }) }
  })

  app.get('/data/ip', req1, async (req, res) => {
    const ip = req.query.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress
    if (!ip) return res.status(400).json({ error: 'Missing ?ip=' })
    try { res.json(await getIpInfo(ip)) }
    catch (e) { res.status(502).json({ error: e.message }) }
  })

  app.get('/data/dns', req1, async (req, res) => {
    if (!req.query.domain) return res.status(400).json({ error: 'Missing ?domain=' })
    try { res.json(await dnsLookup(req.query.domain, req.query.type || 'A')) }
    catch (e) { res.status(400).json({ error: e.message }) }
  })

  app.get('/data/email', req1, async (req, res) => {
    if (!req.query.email) return res.status(400).json({ error: 'Missing ?email=' })
    try { res.json(await validateEmail(req.query.email)) }
    catch (e) { res.status(400).json({ error: e.message }) }
  })

  app.get('/data/wiki', req2, async (req, res) => {
    const topic = req.query.q || req.query.topic
    if (!topic) return res.status(400).json({ error: 'Missing ?q=' })
    try { res.json(await getWiki(topic)) }
    catch (e) { res.status(e.message.includes('No Wikipedia') ? 404 : 502).json({ error: e.message }) }
  })

  app.get('/data/hn', req1, async (req, res) => {
    const feed  = req.query.feed  || 'top'
    const limit = Math.min(parseInt(req.query.n || 10), 30)
    try { res.json({ feed, stories: await getHnStories(feed, limit) }) }
    catch (e) { res.status(502).json({ error: e.message }) }
  })

  app.get('/data/github', req3, async (req, res) => {
    if (!req.query.repo) return res.status(400).json({ error: 'Missing ?repo=owner/name' })
    try { res.json(await getGithubRepo(req.query.repo)) }
    catch (e) { res.status(e.message.includes('not found') ? 404 : 502).json({ error: e.message }) }
  })

  app.get('/data/feed', req3, async (req, res) => {
    if (!req.query.url) return res.status(400).json({ error: 'Missing ?url=' })
    const limit = Math.min(parseInt(req.query.n || 10), 50)
    try { res.json(await parseFeed(req.query.url, limit)) }
    catch (e) { res.status(502).json({ error: e.message }) }
  })

  app.get('/data/whois', req2, async (req, res) => {
    if (!req.query.domain) return res.status(400).json({ error: 'Missing ?domain=' })
    try { res.json(await getWhois(req.query.domain)) }
    catch (e) { res.status(e.message.includes('not found') ? 404 : 502).json({ error: e.message }) }
  })

  app.get('/data/stock', req1, async (req, res) => {
    const symbol = (req.query.symbol || req.query.q || '').toUpperCase().trim()
    if (!symbol) return res.status(400).json({ error: 'Missing ?symbol= (e.g. AAPL, TSLA, BTC-USD)' })
    try { res.json(await getStockPrice(symbol)) }
    catch (e) { res.status(502).json({ error: e.message }) }
  })

  app.get('/data/news', req2, async (req, res) => {
    const q = req.query.q?.trim()
    if (!q) return res.status(400).json({ error: 'Missing ?q=' })
    const n = Math.min(parseInt(req.query.n) || 5, 10)
    try {
      const result = await searchWeb(q, n, { type: 'news' })
      res.json({ query: q, count: result.results.length, results: result.results })
    } catch (e) { res.status(502).json({ error: e.message }) }
  })

  app.get('/data/wayback', req1, async (req, res) => {
    if (!req.query.url) return res.status(400).json({ error: 'Missing ?url=' })
    try { res.json(await getWayback(req.query.url)) }
    catch (e) { res.status(502).json({ error: e.message }) }
  })
}
