import db from './db.js'

const TIMEOUT = 10000

async function fetchJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function checkProvider(provider) {
  if (!provider.endpoint) return null
  const base = provider.endpoint.replace(/\/$/, '')
  const start = Date.now()

  try {
    // 1. Check /v1/models (confirms provider is reachable and OpenAI-compatible)
    const modelsJson = await fetchJSON(`${base}/v1/models`)
    const response_ms = Date.now() - start
    const rawModels = modelsJson.data || []

    // 2. Fetch /v1/info for mints, version, description, onion URL
    let info = {}
    try { info = await fetchJSON(`${base}/v1/info`) } catch {}

    return { is_online: 1, response_ms, rawModels, info }
  } catch {
    return { is_online: 0, response_ms: null, rawModels: [], info: {} }
  }
}

function upsertModels(providerPubkey, rawModels) {
  const now = Math.floor(Date.now() / 1000)
  const stmt = db.prepare(`
    INSERT INTO models (
      id, provider_pubkey, canonical_id, name,
      context_length, max_completion_tokens,
      modality, input_modalities, output_modalities,
      pricing_sats_prompt, pricing_sats_completion,
      pricing_sats_per_1k_prompt, pricing_sats_per_1k_completion,
      supported_parameters, is_moderated, enabled, raw, updated_at
    ) VALUES (
      @id, @provider_pubkey, @canonical_id, @name,
      @context_length, @max_completion_tokens,
      @modality, @input_modalities, @output_modalities,
      @pricing_sats_prompt, @pricing_sats_completion,
      @pricing_sats_per_1k_prompt, @pricing_sats_per_1k_completion,
      @supported_parameters, @is_moderated, @enabled, @raw, @updated_at
    )
    ON CONFLICT(id, provider_pubkey) DO UPDATE SET
      canonical_id            = excluded.canonical_id,
      name                    = excluded.name,
      context_length          = excluded.context_length,
      max_completion_tokens   = excluded.max_completion_tokens,
      modality                = excluded.modality,
      input_modalities        = excluded.input_modalities,
      output_modalities       = excluded.output_modalities,
      pricing_sats_prompt     = excluded.pricing_sats_prompt,
      pricing_sats_completion = excluded.pricing_sats_completion,
      pricing_sats_per_1k_prompt     = excluded.pricing_sats_per_1k_prompt,
      pricing_sats_per_1k_completion = excluded.pricing_sats_per_1k_completion,
      supported_parameters    = excluded.supported_parameters,
      is_moderated            = excluded.is_moderated,
      enabled                 = excluded.enabled,
      raw                     = excluded.raw,
      updated_at              = excluded.updated_at
  `)

  const upsertMany = db.transaction(models => {
    for (const m of models) {
      const satsPrompt     = m.sats_pricing?.prompt     ?? m.pricing?.prompt     ?? null
      const satsCompletion = m.sats_pricing?.completion ?? m.pricing?.completion ?? null
      const top = m.top_provider || {}
      const arch = m.architecture || {}

      stmt.run({
        id:                             m.id,
        provider_pubkey:                providerPubkey,
        canonical_id:                   m.canonical_slug || m.id,
        name:                           m.name || m.id,
        context_length:                 m.context_length || top.context_length || null,
        max_completion_tokens:          top.max_completion_tokens || null,
        modality:                       arch.modality || null,
        input_modalities:               JSON.stringify(arch.input_modalities || []),
        output_modalities:              JSON.stringify(arch.output_modalities || []),
        pricing_sats_prompt:            satsPrompt,
        pricing_sats_completion:        satsCompletion,
        pricing_sats_per_1k_prompt:     satsPrompt     != null ? satsPrompt * 1000     : null,
        pricing_sats_per_1k_completion: satsCompletion != null ? satsCompletion * 1000 : null,
        supported_parameters:           JSON.stringify(m.supported_parameters || []),
        is_moderated:                   top.is_moderated ? 1 : 0,
        enabled:                        m.enabled !== false ? 1 : 0,
        raw:                            JSON.stringify(m),
        updated_at:                     now,
      })
    }
  })

  upsertMany(rawModels)
}

function recordUptime(pubkey, is_online, response_ms) {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`
    INSERT OR IGNORE INTO uptime_history (provider_pubkey, checked_at, is_online, response_ms)
    VALUES (?, ?, ?, ?)
  `).run(pubkey, now, is_online, response_ms)

  // Prune entries older than 48h
  db.prepare(`DELETE FROM uptime_history WHERE provider_pubkey = ? AND checked_at < ?`)
    .run(pubkey, now - 172800)

  // Recalculate 24h uptime stats
  const since = now - 86400
  const stats = db.prepare(`
    SELECT COUNT(*) as total, SUM(is_online) as ok
    FROM uptime_history WHERE provider_pubkey = ? AND checked_at >= ?
  `).get(pubkey, since)

  db.prepare(`UPDATE providers SET uptime_ok_24h = ?, uptime_total_24h = ? WHERE pubkey = ?`)
    .run(stats.ok || 0, stats.total || 0, pubkey)
}

export async function checkAllProviders() {
  const providers = db.prepare("SELECT * FROM providers WHERE network = 'routstr' OR network IS NULL").all()

  if (providers.length === 0) {
    console.log('No providers yet — waiting for Nostr events...')
    return
  }

  console.log(`Checking ${providers.length} provider(s)...`)

  for (const provider of providers) {
    const result = await checkProvider(provider)
    if (!result) continue

    const now = Math.floor(Date.now() / 1000)
    const info = result.info

    // Extract mints and other /v1/info fields
    const mints     = info.mints     || info.mint_urls || []
    const onionUrl  = info.onion_url || null
    const version   = info.version   || null
    const childCost = info.child_key_cost_msats || 0

    db.prepare(`
      UPDATE providers SET
        is_online            = @is_online,
        response_ms          = @response_ms,
        last_check           = @last_check,
        mints                = @mints,
        onion_url            = @onion_url,
        version              = @version,
        child_key_cost_msats = @child_key_cost_msats
      WHERE pubkey = @pubkey
    `).run({
      is_online:            result.is_online,
      response_ms:          result.response_ms,
      last_check:           now,
      mints:                JSON.stringify(mints),
      onion_url:            onionUrl,
      version:              version,
      child_key_cost_msats: childCost,
      pubkey:               provider.pubkey,
    })

    if (result.is_online && result.rawModels.length > 0) {
      upsertModels(provider.pubkey, result.rawModels)
    }

    recordUptime(provider.pubkey, result.is_online, result.response_ms)

    const status = result.is_online
      ? `online (${result.response_ms}ms, ${result.rawModels.length} models)`
      : 'offline'
    console.log(` - ${provider.name}: ${status}`)
  }
}
