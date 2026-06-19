// IOTA EVM native token payment support
// Chain ID: 8822 — https://json-rpc.evm.iotaledger.net
// Native token: IOTA, 6 decimal places (1 IOTA = 1_000_000 glow base units)

const IOTA_RPC      = 'https://json-rpc.evm.iotaledger.net'
const IOTA_DECIMALS = 6          // 1 IOTA = 10^6 glow
const PRICE_TTL     = 300_000    // 5-minute price cache

let priceCache = { usd: 0, ts: 0 }

export async function getIotaUsdPrice() {
  const now = Date.now()
  if (priceCache.usd > 0 && now - priceCache.ts < PRICE_TTL) return priceCache.usd
  const res = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=iota&vs_currencies=usd',
    { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }
  )
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`)
  const data = await res.json()
  const usd = data.iota?.usd
  if (!usd || usd <= 0) throw new Error('IOTA price unavailable')
  priceCache = { usd, ts: now }
  return usd
}

// Convert a USD amount to IOTA base units (glow). Returns BigInt.
export function usdToIotaBase(usdAmount, iotaUsd) {
  return BigInt(Math.ceil((usdAmount / iotaUsd) * 10 ** IOTA_DECIMALS))
}

// Human-readable IOTA amount from base units
export function iotaBaseToDisplay(baseUnits) {
  return (Number(baseUnits) / 10 ** IOTA_DECIMALS).toFixed(6).replace(/\.?0+$/, '')
}

// Verify an IOTA EVM native-token transfer on chain.
// Returns { txHash, value, from } or throws.
export async function verifyIotaPayment(txHash, minBaseUnits, recipientAddress) {
  const res = await fetch(IOTA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [txHash],
    }),
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`IOTA RPC ${res.status}`)
  const { result: tx, error } = await res.json()
  if (error) throw new Error(`IOTA RPC error: ${error.message}`)
  if (!tx)           throw new Error('Transaction not found on IOTA EVM')
  if (!tx.blockHash) throw new Error('Transaction not yet confirmed (no block)')
  if (tx.to?.toLowerCase() !== recipientAddress.toLowerCase()) {
    throw new Error(`Wrong recipient: got ${tx.to}, expected ${recipientAddress}`)
  }
  const value = BigInt(tx.value)
  if (value < minBaseUnits) {
    const got  = iotaBaseToDisplay(value)
    const need = iotaBaseToDisplay(minBaseUnits)
    throw new Error(`Underpayment: sent ${got} IOTA, need ${need} IOTA`)
  }
  return { txHash, value: value.toString(), from: tx.from }
}
