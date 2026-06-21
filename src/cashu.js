import { Wallet, Mint, MeltQuoteState, getDecodedToken, sumProofs } from '@cashu/cashu-ts'

// Trusted mints — comma-separated in CASHU_TRUSTED_MINTS env var.
// Tokens from unknown mints are rejected before any network call.
const TRUSTED_MINTS = new Set(
  (process.env.CASHU_TRUSTED_MINTS || '')
    .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean)
)

// Tokens must cover price + this buffer for Lightning melt fees
const FEE_BUFFER_SATS = 3

// Max proofs per token (DoS guard — avoids huge swap transactions)
const MAX_PROOFS = 50

function cashuError(msg, hint) {
  const e = new Error(msg)
  e.cashuHint = hint || null
  return e
}

/**
 * Verify a Cashu token (X-CASHU header value) and melt it to Lightning.
 *
 * Flow (Option A — melt immediately):
 *   decode → check mint trusted → check amount → generate invoice →
 *   create melt quote → melt proofs → confirm PAID
 *
 * Returns { preimage, mintUrl, amountSats } on success.
 * Throws on failure (caller returns 402).
 */
export async function verifyCashu(tokenStr, priceSats, nwcClient) {
  // 1. Decode token
  let decoded
  try { decoded = getDecodedToken(tokenStr) } catch {
    throw cashuError('Invalid Cashu token format')
  }

  const entry  = decoded.token?.[0]
  const proofs = entry?.proofs || []
  const mintUrl = (entry?.mint || '').replace(/\/$/, '')

  if (!mintUrl)         throw cashuError('Token missing mint URL')
  if (!proofs.length)   throw cashuError('Token has no proofs')
  if (proofs.length > MAX_PROOFS) throw cashuError(`Too many proofs (max ${MAX_PROOFS})`)

  // 2. Mint trust check (before any network call)
  if (!TRUSTED_MINTS.has(mintUrl)) {
    throw cashuError(`Mint not trusted: ${mintUrl}`, `Accepted mints: ${[...TRUSTED_MINTS].join(', ')}`)
  }

  // 3. Amount check (before any network call)
  const totalSats = sumProofs(proofs)
  if (totalSats < priceSats + FEE_BUFFER_SATS) {
    throw cashuError(
      `Token too small: ${totalSats} sats (need ${priceSats} + ~${FEE_BUFFER_SATS} for melt fees)`
    )
  }

  // 4. Generate a Lightning invoice for exactly priceSats
  const invoice = await nwcClient.makeInvoice({
    amount:      priceSats * 1000,
    description: 'AIRadar Cashu payment',
  })

  // 5. Create melt quote at mint
  const mint   = new Mint(mintUrl)
  const wallet = new Wallet(mint, { unit: 'sat' })

  let meltQuote
  try {
    meltQuote = await wallet.createMeltQuoteBolt11(invoice.invoice)
  } catch (e) {
    throw cashuError(`Mint melt quote failed: ${e.message}`)
  }

  // Re-check amount including actual fee reserve
  if (totalSats < meltQuote.fee_reserve + priceSats) {
    throw cashuError(
      `Token too small after fees: ${totalSats} sats (need ${priceSats + meltQuote.fee_reserve})`
    )
  }

  // 6. Melt proofs → pay the Lightning invoice
  let meltResult
  try {
    meltResult = await wallet.meltProofsBolt11(meltQuote, proofs)
  } catch (e) {
    throw cashuError(`Melt failed: ${e.message}`)
  }

  // 7. Handle result states
  const state = meltResult.state ?? meltResult.quote?.state

  if (state === MeltQuoteState.PAID) {
    const preimage = meltResult.preimage ?? meltResult.quote?.payment_preimage ?? null
    return { preimage: preimage || invoice.payment_hash, mintUrl, amountSats: totalSats }
  }

  if (state === MeltQuoteState.PENDING) {
    throw cashuError('Payment pending — retry in a few seconds')
  }

  throw cashuError('Melt did not succeed — token may still be valid, try again')
}

export function cashuPaymentInfo(trustedMints, priceSats) {
  return {
    protocol:      'Cashu',
    how_to_pay:    `Send a Cashu token in header: X-CASHU: cashuA<token>`,
    trusted_mints: [...trustedMints],
    min_amount_sats: priceSats + FEE_BUFFER_SATS,
    note:          `Token must cover ${priceSats} sats + ~${FEE_BUFFER_SATS} sats Lightning melt fee`,
  }
}

export { TRUSTED_MINTS }
