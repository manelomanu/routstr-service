/**
 * x402/USDC end-to-end test — throwaway wallet, Base network
 * Tests GET /providers (directory endpoint, $0.01 USDC)
 */
import { createWalletClient, http, publicActions } from '/root/routstr-service/node_modules/viem/_esm/index.js'
import { privateKeyToAccount } from '/root/routstr-service/node_modules/viem/_esm/accounts/index.js'
import { base } from '/root/routstr-service/node_modules/viem/_esm/chains/index.js'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const { x402Client }              = require('/root/routstr-service/node_modules/@x402/core/dist/cjs/client/index.js')
const { registerExactEvmScheme }  = require('/root/routstr-service/node_modules/@x402/evm/dist/cjs/exact/client/index.js')
const { decodePaymentRequiredHeader, encodePaymentSignatureHeader } = require('/root/routstr-service/node_modules/@x402/core/dist/cjs/http/index.js')

// Throwaway test wallet — funded with $0.01 USDC on Base for this test
// Usage: TEST_PRIVATE_KEY=0x... node test-x402.mjs
const PRIVATE_KEY = process.env.TEST_PRIVATE_KEY
if (!PRIVATE_KEY) { console.error('Set TEST_PRIVATE_KEY env var'); process.exit(1) }
const ENDPOINT    = 'https://airadar.fyi/providers'

const account = privateKeyToAccount(PRIVATE_KEY)
console.log('Client wallet:', account.address)

const walletClient = createWalletClient({
  account, chain: base, transport: http('https://mainnet.base.org'),
}).extend(publicActions)

const signer = Object.assign(walletClient, { address: account.address })

const client = new x402Client()
registerExactEvmScheme(client, { signer })
console.log('x402 client ready\n')

// Step 1 — call without payment, expect 402
console.log('[1] GET', ENDPOINT, '(no payment)...')
const r1 = await fetch(ENDPOINT)
console.log('    Status:', r1.status)
if (r1.status !== 402) {
  console.error('Expected 402, got:', r1.status, await r1.text())
  process.exit(1)
}
const xPayReqHdr = r1.headers.get('x-payment-required')
if (!xPayReqHdr) { console.error('No X-PAYMENT-REQUIRED header'); process.exit(1) }
console.log('    ✓ Got 402 with X-PAYMENT-REQUIRED')

// Step 2 — decode + sign
console.log('\n[2] Signing USDC payment on Base...')
const paymentRequired = decodePaymentRequiredHeader(xPayReqHdr)
console.log('    x402Version:', paymentRequired.x402Version)
console.log('    Networks:', paymentRequired.accepts?.map(a => a.network).join(', '))

const paymentPayload = await client.createPaymentPayload(paymentRequired)
const xPayment = encodePaymentSignatureHeader(paymentPayload)
console.log('    ✓ Payment signed')

// Step 3 — retry with X-PAYMENT
console.log('\n[3] Retrying with X-PAYMENT header...')
const r2 = await fetch(ENDPOINT, { headers: { 'X-PAYMENT': xPayment } })
console.log('    Status:', r2.status)

if (r2.ok) {
  const data = await r2.json()
  console.log('\n✅ x402 SUCCESS!')
  console.log('   Providers returned:', data.count)
  console.log('   First provider:', data.providers?.[0]?.name)
} else {
  const err = await r2.text()
  console.error('\n❌ FAILED:', r2.status, err.slice(0, 300))
}
