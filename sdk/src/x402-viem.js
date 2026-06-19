import { toHex } from 'viem'

/**
 * Creates an x402 payment signer using a viem WalletClient.
 *
 * @param {import('viem').WalletClient} walletClient
 * @param {string} [preferNetwork='base']  'base' | 'polygon' | 'arbitrum'
 * @returns {function} async (requirements) => base64Payload
 *
 * @example
 * import { createWalletClient, http } from 'viem'
 * import { base } from 'viem/chains'
 * import { privateKeyToAccount } from 'viem/accounts'
 * import { AIRadar } from '@airadar/client'
 * import { signX402 } from '@airadar/client/x402-viem'
 *
 * const account = privateKeyToAccount('0x...')
 * const wallet  = createWalletClient({ account, chain: base, transport: http() })
 * const client  = new AIRadar({ x402: signX402(wallet), prefer: 'x402' })
 */
export function signX402(walletClient, preferNetwork = 'base') {
  return async function (requirements) {
    const accepts = requirements.accepts ?? []
    const option  = accepts.find(a => a.network === preferNetwork) ?? accepts[0]
    if (!option) throw new Error('No compatible x402 payment option found')

    const from    = walletClient.account.address
    const nonce        = toHex(crypto.getRandomValues(new Uint8Array(32)))
    const validBeforeN = Math.floor(Date.now() / 1000) + 300

    // EIP-712 typed data for EIP-3009 transferWithAuthorization
    const domain = {
      name:              option.extra?.name ?? 'USD Coin',
      version:           option.extra?.version ?? '2',
      chainId:           _chainId(option.network),
      verifyingContract: option.asset,
    }

    const types = {
      TransferWithAuthorization: [
        { name: 'from',        type: 'address' },
        { name: 'to',          type: 'address' },
        { name: 'value',       type: 'uint256' },
        { name: 'validAfter',  type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce',       type: 'bytes32' },
      ],
    }

    const message = {
      from,
      to:          option.payTo,
      value:       BigInt(option.maxAmountRequired),
      validAfter:  0n,
      validBefore: BigInt(validBeforeN),
      nonce,
    }

    const signature = await walletClient.signTypedData({ domain, types, primaryType: 'TransferWithAuthorization', message })

    const payload = {
      x402Version: 1,
      scheme:      option.scheme,
      network:     option.network,
      payload: {
        signature,
        authorization: {
          from,
          to:          option.payTo,
          value:       String(option.maxAmountRequired),
          validAfter:  '0',
          validBefore: String(validBeforeN),
          nonce,
        },
      },
    }

    return Buffer.from(JSON.stringify(payload)).toString('base64')
  }
}

function _chainId(network) {
  const map = { base: 8453, polygon: 137, arbitrum: 42161, 'eip155:42161': 42161 }
  return (map[network] ?? parseInt(network.replace('eip155:', ''))) || 8453
}
