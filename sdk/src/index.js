import { AIRadarClient } from './client.js'
import { buildEndpoints } from './endpoints.js'

export class AIRadar {
  /**
   * @example
   * // L402 (Lightning)
   * const client = new AIRadar({
   *   lightning: async (bolt11) => {
   *     const { preimage } = await myLightningWallet.pay(bolt11)
   *     return preimage
   *   }
   * })
   *
   * @example
   * // x402 (USDC on Base/Polygon/Arbitrum/Solana)
   * import { createWalletClient } from 'viem'
   * import { signX402 } from '@airadar/client/x402-viem'
   *
   * const client = new AIRadar({
   *   x402: signX402(walletClient),
   *   prefer: 'x402',
   * })
   *
   * @example
   * // Both payment methods configured (uses prefer to decide which to try first)
   * const client = new AIRadar({ lightning, x402, prefer: 'x402' })
   */
  constructor(opts = {}) {
    const c = new AIRadarClient(opts)
    const endpoints = buildEndpoints(c)
    this.data       = endpoints.data
    this.ai         = endpoints.ai
    this.compute    = endpoints.compute
    this.state      = endpoints.state
    this.reputation = endpoints.reputation
    this._client    = c
  }

  /** Raw HTTP access for any endpoint not covered above */
  request(method, path, opts) {
    return this._client.request(method, path, opts)
  }
}

export { AIRadarClient }
