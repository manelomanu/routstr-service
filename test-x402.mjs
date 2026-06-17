/**
 * Test x402/USDC payment on AIRadar gateway.
 * Usage: PRIVATE_KEY=0x... node test-x402.mjs
 */

import { createWalletClient, http, publicActions } from '/root/routstr-service/node_modules/viem/_esm/index.js'
import { privateKeyToAccount } from '/root/routstr-service/node_modules/viem/_esm/accounts/index.js'
import { base } from '/root/routstr-service/node_modules/viem/_esm/chains/index.js'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const { x402Client }              = require('/root/routstr-service/node_modules/@x402/core/dist/cjs/client/index.js')
const { registerExactEvmScheme }  = require('/root/routstr-service/node_modules/@x402/evm/dist/cjs/exact/client/index.js')
const { decodePaymentRequiredHeader, encodePaymentSignatureHeader } = require('/root/routstr-service/node_modules/@x402/core/dist/cjs/http/index.js')

const PRIVATE_KEY = process.env.PRIVATE_KEY
if (!PRIVATE_KEY) { console.error('Set PRIVATE_KEY=0x...'); process.exit(1) }

const GATEWAY = 'http://localhost:3000'
const MODEL   = 'google/gemma-4-31b-it:free'

const account = privateKeyToAccount(PRIVATE_KEY)
console.log('Wallet:', account.address)

const walletClient = createWalletClient({
  account,
  chain: base,
  transport: http('https://mainnet.base.org'),
}).extend(publicActions)

// x402/evm accesses signer.address directly — viem puts it in account.address
const signer = Object.assign(walletClient, { address: account.address })

// Build x402 client and register exact EVM scheme
const client = new x402Client()
registerExactEvmScheme(client, { signer })
console.log('x402 client ready')

// Step 1 — call gateway without payment, expect 402
console.log('\n[1] Calling gateway...')
const r1 = await fetch(`${GATEWAY}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
})

if (r1.status !== 402) {
  console.error('Expected 402, got:', r1.status, await r1.text())
  process.exit(1)
}

const body402     = await r1.json()
const xPayReqHdr  = r1.headers.get('x-payment-required')
if (!xPayReqHdr) { console.error('No X-PAYMENT-REQUIRED header'); process.exit(1) }

console.log('Got 402. Tier:', body402.tier, '| Amount:', body402.payment_options?.crypto?.amount_usdc)

// Step 2 — decode requirements and sign payment
console.log('\n[2] Signing x402 USDC payment on Base...')
const paymentRequired = decodePaymentRequiredHeader(xPayReqHdr)
console.log('x402Version:', paymentRequired.x402Version, '| accepts:', paymentRequired.accepts?.length, 'networks')
console.log('first network:', paymentRequired.accepts?.[0]?.network)

const paymentPayload = await client.createPaymentPayload(paymentRequired)
const xPayment = encodePaymentSignatureHeader(paymentPayload)
console.log('Payment signed.')

// Step 3 — retry with X-PAYMENT header
console.log('\n[3] Retrying with payment...')
const r2 = await fetch(`${GATEWAY}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-PAYMENT': xPayment,
  },
  body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
})

const body2 = await r2.json()
console.log('Response status:', r2.status)
if (r2.ok) {
  console.log('\nSUCCESS ✓')
  console.log('Reply:', body2.choices?.[0]?.message?.content)
} else {
  console.error('\nFAILED:', JSON.stringify(body2, null, 2))
}
