import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

export async function fetchUrl(url) {
  let parsed
  try { parsed = new URL(url) } catch { throw new Error('Invalid URL') }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) throw new Error('Only http/https URLs are allowed')

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'AIRadar/2.0 (agent-content-fetcher)',
      'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
    },
    signal: AbortSignal.timeout(15000),
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const contentType = res.headers.get('content-type') || ''
  const body = await res.text()

  if (contentType.includes('application/json')) {
    return { url, title: '', content: body, word_count: body.split(/\s+/).length, format: 'json' }
  }

  const { document } = parseHTML(body)
  const reader = new Readability(document)
  const article = reader.parse()

  if (!article) {
    const stripped = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    return { url, title: '', content: stripped, word_count: stripped.split(' ').length, format: 'html-stripped' }
  }

  const content = (article.textContent || '').replace(/\s+/g, ' ').trim()
  return {
    url,
    title:      article.title   || '',
    content,
    word_count: content.split(' ').length,
    byline:     article.byline  || null,
    format:     'article',
  }
}
