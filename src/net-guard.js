import { lookup } from 'dns/promises'

// Private IPv4: loopback, RFC-1918, link-local, CGNAT
const PRIVATE_V4 = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/
// Private IPv6: loopback, ULA (fc/fd), link-local (fe80)
const PRIVATE_V6 = /^(::1$|fc|fd|fe80)/i
const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal'])

async function resolveAndCheck(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '') // strip IPv6 brackets
  if (BLOCKED_HOSTS.has(h) || PRIVATE_V4.test(h) || PRIVATE_V6.test(h)) {
    throw new Error('Private/internal addresses are not allowed')
  }
  let address
  try { ({ address } = await lookup(hostname, { verbatim: false })) }
  catch { throw new Error(`Cannot resolve host: ${hostname}`) }
  if (PRIVATE_V4.test(address) || PRIVATE_V6.test(address) || address === '::1') {
    throw new Error('Private/internal addresses are not allowed')
  }
}

// Validate a full URL string — checks protocol, hostname, and resolved IP.
// Throws on private targets. Use before any server-side fetch of a user-supplied URL.
export async function assertPublicUrl(urlString) {
  let parsed
  try { parsed = new URL(urlString) } catch { throw new Error('Invalid URL') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed')
  }
  await resolveAndCheck(parsed.hostname)
}

// Validate a bare hostname — for non-URL targets like port checks and SSL checks.
export async function assertPublicHost(hostname) {
  await resolveAndCheck(hostname)
}
