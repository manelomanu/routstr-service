import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http'
import { x402Facilitator } from '@x402/core/facilitator'
import { registerExactEvmScheme } from '@x402/evm/exact/facilitator'
import { createWalletClient, http, publicActions } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, polygon, arbitrum } from 'viem/chains'

export { decodePaymentSignatureHeader, encodePaymentRequiredHeader }

// Per-chain RPC and viem chain objects
// Base/Polygon use v1 short names as keys (matched by payload.network from clients)
// Arbitrum has no v1 name so uses v2 eip155 format as key
const CHAIN_CONFIGS = {
  base:           { viemChain: base,     rpc: 'https://mainnet.base.org',     v2: 'eip155:8453'  },
  polygon:        { viemChain: polygon,  rpc: 'https://polygon-rpc.com',      v2: 'eip155:137'   },
  'eip155:42161': { viemChain: arbitrum, rpc: 'https://arb1.arbitrum.io/rpc', v2: 'eip155:42161' },
}

function makeSigner(account, cfg) {
  const wc = createWalletClient({
    account,
    chain: cfg.viemChain,
    transport: http(cfg.rpc),
  }).extend(publicActions)
  // @x402/evm reads signer.address directly — viem puts it at account.address
  return Object.assign(wc, { address: account.address })
}

function createPerChainFacilitator(signer, v2Network) {
  const f = new x402Facilitator()
  registerExactEvmScheme(f, { signer, networks: [v2Network] })
  return f
}

function createFacilitator() {
  if (!process.env.EVM_PRIVATE_KEY) {
    console.warn('[x402] EVM_PRIVATE_KEY not set — USDC/x402 payments disabled (L402 still works)')
    return { verify: async () => ({ isValid: false }), settle: async () => ({}) }
  }

  const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY)

  // One facilitator per chain — each uses the correct RPC for verify + settle
  const chainFacilitators = {}
  for (const [v1Name, cfg] of Object.entries(CHAIN_CONFIGS)) {
    const signer = makeSigner(account, cfg)
    chainFacilitators[v1Name] = createPerChainFacilitator(signer, cfg.v2)
    console.log(`[x402] ${v1Name} facilitator ready (signer ${account.address})`)
  }

  // Route by payload.network (v1 name: 'base' | 'polygon') or fall back to base
  function route(network) {
    return chainFacilitators[network] ?? chainFacilitators.base
  }

  return {
    verify: (payload, req) => route(payload.network).verify(payload, req),
    settle: (payload, req) => route(payload.network).settle(payload, req),
  }
}

export const facilitator = createFacilitator()
