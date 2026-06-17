import db from './db.js'

const STATS_URL = 'https://network.antseed.com/stats'

export async function syncAntSeed() {
  console.log('[AntSeed] Syncing providers...')

  let data
  try {
    const res = await fetch(STATS_URL, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    data = await res.json()
  } catch (e) {
    console.error('[AntSeed] Failed to fetch stats:', e.message)
    return
  }

  const now = Math.floor(Date.now() / 1000)
  let providers = 0
  let models = 0

  for (const peer of data.peers || []) {
    const pubkey = peer.peerId
    if (!pubkey) continue

    const addr = peer.publicAddress
    const endpoint = addr
      ? (addr.startsWith('http') ? addr : `http://${addr}`)
      : null

    db.prepare(`
      INSERT INTO providers (pubkey, name, endpoint, network, auth_type, is_online, last_seen)
      VALUES (?, ?, ?, 'antseed', 'usdc', 1, ?)
      ON CONFLICT(pubkey) DO UPDATE SET
        name      = excluded.name,
        endpoint  = COALESCE(excluded.endpoint, endpoint),
        is_online = 1,
        last_seen = excluded.last_seen
    `).run(pubkey, peer.displayName || pubkey.slice(0, 16), endpoint, now)
    providers++

    for (const prov of peer.providers || []) {
      for (const modelId of prov.services || []) {
        // Per-model pricing takes precedence over provider default; $/M → $/1k
        const p = prov.servicePricing?.[modelId] ?? prov.defaultPricing ?? {}
        const promptPer1k     = p.inputUsdPerMillion  != null ? p.inputUsdPerMillion  / 1000 : null
        const completionPer1k = p.outputUsdPerMillion != null ? p.outputUsdPerMillion / 1000 : null

        db.prepare(`
          INSERT INTO models (id, provider_pubkey, name, enabled,
            pricing_usd_per_1k_prompt, pricing_usd_per_1k_completion)
          VALUES (?, ?, ?, 1, ?, ?)
          ON CONFLICT(id, provider_pubkey) DO UPDATE SET
            enabled                       = 1,
            pricing_usd_per_1k_prompt     = excluded.pricing_usd_per_1k_prompt,
            pricing_usd_per_1k_completion = excluded.pricing_usd_per_1k_completion
        `).run(modelId, pubkey, modelId, promptPer1k, completionPer1k)
        models++
      }
    }
  }

  console.log(`[AntSeed] Synced ${providers} providers, ${models} models`)
}
