// Search backends (priority: Brave → Serper → SearXNG)
// Configure via env: BRAVE_API_KEY or SERPER_API_KEY

const SEARXNG_INSTANCES = [
  'https://searx.be',
  'https://search.bus-hit.me',
  'https://searx.tiekoetter.com',
  'https://search.inetol.net',
  'https://opnxng.com',
]

async function braveSearch(query, n, type, freshness) {
  const url = new URL('https://api.search.brave.com/res/v1/' + (type === 'news' ? 'news' : 'web') + '/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', Math.min(n, 20))
  url.searchParams.set('search_lang', 'en')
  if (freshness) url.searchParams.set('freshness', freshness)

  const res = await fetch(url, {
    headers: {
      'Accept':               'application/json',
      'Accept-Encoding':      'gzip',
      'X-Subscription-Token': process.env.BRAVE_API_KEY,
    },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`Brave API ${res.status}`)
  const data = await res.json()
  const raw  = type === 'news' ? (data.news?.results || []) : (data.web?.results || [])
  return {
    results: raw.slice(0, n).map(r => ({
      title:   r.title       || '',
      url:     r.url         || '',
      snippet: r.description || r.content || '',
      age:     r.page_age    || r.age     || null,
      source:  r.meta_url?.hostname || null,
    })),
    source: 'brave',
  }
}

async function serperSearch(query, n) {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: Math.min(n, 10) }),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`Serper API ${res.status}`)
  const data = await res.json()
  return {
    results: (data.organic || []).slice(0, n).map(r => ({
      title:   r.title   || '',
      url:     r.link    || '',
      snippet: r.snippet || '',
      age:     r.date    || null,
      source:  null,
    })),
    source: 'serper',
  }
}

async function searxngSearch(query, n) {
  const params = new URLSearchParams({ q: query, format: 'json', categories: 'general', language: 'en' })

  const tryInstance = async (instance, signal = AbortSignal.timeout(8000)) => {
    const res = await fetch(`${instance}/search?${params}`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const results = (data.results || []).slice(0, n).map(r => ({
      title: r.title || '', url: r.url || '', snippet: r.content || '', age: null, source: null,
    }))
    if (results.length === 0) throw new Error('no results')
    return { results, source: instance }
  }

  // Self-hosted instance takes priority — fast and reliable
  if (process.env.SEARXNG_URL) {
    return tryInstance(process.env.SEARXNG_URL, AbortSignal.timeout(10000))
  }

  // Fallback: race public instances; cancel losers once a winner resolves
  const ac = new AbortController()
  try {
    const result = await Promise.any(SEARXNG_INSTANCES.map(inst =>
      tryInstance(inst, AbortSignal.any([AbortSignal.timeout(8000), ac.signal]))
    ))
    ac.abort()
    return result
  } catch {
    throw new Error('All search backends unavailable')
  }
}

export async function searchWeb(query, n = 5, opts = {}) {
  const { type = 'web', freshness } = opts

  if (process.env.BRAVE_API_KEY) {
    try {
      return await braveSearch(query, n, type, freshness)
    } catch (e) {
      if (!process.env.SERPER_API_KEY) throw e  // no fallback available
      console.warn('[search] Brave failed, falling back to Serper:', e.message)
    }
  }

  if (process.env.SERPER_API_KEY) return serperSearch(query, n)

  return searxngSearch(query, n)
}

export function searchBackend() {
  if (process.env.BRAVE_API_KEY)  return 'brave'
  if (process.env.SERPER_API_KEY) return 'serper'
  if (process.env.SEARXNG_URL)    return 'searxng-self'
  return 'searxng-public'
}
