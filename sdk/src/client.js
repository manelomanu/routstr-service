export class AIRadarClient {
  /**
   * @param {object} opts
   * @param {string}   [opts.baseUrl='https://airadar.fyi']
   * @param {function} [opts.lightning]  async (bolt11: string) => preimage: string
   * @param {function} [opts.x402]       async (requirements: object) => base64Payload: string
   * @param {'lightning'|'x402'} [opts.prefer='lightning']  which payment method to try first
   */
  constructor({ baseUrl = 'https://airadar.fyi', lightning, x402, prefer = 'lightning' } = {}) {
    this.base   = baseUrl.replace(/\/$/, '')
    this._pay   = { lightning, x402 }
    this.prefer = prefer
  }

  async request(method, path, { query, body, headers = {}, raw = false } = {}) {
    const url = new URL(this.base + path)
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v != null) url.searchParams.set(k, String(v))
      }
    }

    const init = {
      method,
      headers: { 'Content-Type': 'application/json', 'User-Agent': '@airadar/client/0.1.0', ...headers },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    }

    let res = await fetch(url, init)

    if (res.status === 402) {
      const data = await res.json().catch(() => null)
      const paymentHeader = await this._handle402(data)
      if (paymentHeader) {
        res = await fetch(url, { ...init, headers: { ...init.headers, ...paymentHeader } })
      }
    }

    if (raw) return res

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      const e = new Error(err?.error || res.statusText)
      e.status = res.status
      e.data   = err
      throw e
    }

    return res.json()
  }

  async _handle402(data) {
    const opts = data?.payment_options
    if (!opts) throw Object.assign(new Error('Payment required'), { status: 402 })

    const tryL402 = this._pay.lightning && opts.lightning
    const tryX402 = this._pay.x402     && opts.usdc

    const order = this.prefer === 'x402' ? [tryX402 && 'x402', tryL402 && 'l402']
                :                          [tryL402 && 'l402',  tryX402 && 'x402']

    for (const method of order) {
      if (method === 'l402') return this._payL402(opts.lightning)
      if (method === 'x402') return this._payX402(opts.usdc)
    }

    const e = new Error('Payment required — configure a lightning or x402 handler')
    e.status = 402
    e.payment_options = opts
    throw e
  }

  async _payL402({ invoice, payment_hash }) {
    const preimage = await this._pay.lightning(invoice)
    return { Authorization: `L402 ${payment_hash}:${preimage}` }
  }

  async _payX402({ payment_required_header }) {
    const requirements = JSON.parse(atob(payment_required_header))
    const payload = await this._pay.x402(requirements)
    return { 'X-PAYMENT': payload }
  }

  get  = (path, opts) => this.request('GET',    path, opts)
  post = (path, opts) => this.request('POST',   path, opts)
  put  = (path, opts) => this.request('PUT',    path, opts)
  del  = (path, opts) => this.request('DELETE', path, opts)
}
