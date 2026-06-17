import db from './db.js'

const PUBKEY = 'openrouter'
const ENDPOINT = 'https://openrouter.ai/api/v1'

async function fetchModels() {
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  return json.data || []
}

function upsertProvider() {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`
    INSERT INTO providers (pubkey, name, description, endpoint, is_online, last_check, last_seen, network, auth_type)
    VALUES (?, ?, ?, ?, 1, ?, ?, 'openrouter', 'api_key')
    ON CONFLICT(pubkey) DO UPDATE SET
      is_online  = 1,
      last_check = excluded.last_check,
      last_seen  = excluded.last_seen
  `).run(
    PUBKEY,
    'OpenRouter',
    'Centralized AI gateway — 300+ models from OpenAI, Anthropic, Google, Meta and more. Requires API key from openrouter.ai. Pricing in USD.',
    ENDPOINT,
    now, now
  )
}

function upsertModels(models) {
  const now = Math.floor(Date.now() / 1000)
  const stmt = db.prepare(`
    INSERT INTO models (
      id, provider_pubkey, canonical_id, name,
      context_length, max_completion_tokens,
      modality, input_modalities, output_modalities,
      pricing_usd_prompt, pricing_usd_completion,
      pricing_usd_per_1k_prompt, pricing_usd_per_1k_completion,
      is_moderated, enabled, raw, updated_at
    ) VALUES (
      @id, @provider_pubkey, @canonical_id, @name,
      @context_length, @max_completion_tokens,
      @modality, @input_modalities, @output_modalities,
      @pricing_usd_prompt, @pricing_usd_completion,
      @pricing_usd_per_1k_prompt, @pricing_usd_per_1k_completion,
      0, 1, @raw, @updated_at
    )
    ON CONFLICT(id, provider_pubkey) DO UPDATE SET
      name                          = excluded.name,
      context_length                = excluded.context_length,
      max_completion_tokens         = excluded.max_completion_tokens,
      modality                      = excluded.modality,
      input_modalities              = excluded.input_modalities,
      output_modalities             = excluded.output_modalities,
      pricing_usd_prompt            = excluded.pricing_usd_prompt,
      pricing_usd_completion        = excluded.pricing_usd_completion,
      pricing_usd_per_1k_prompt     = excluded.pricing_usd_per_1k_prompt,
      pricing_usd_per_1k_completion = excluded.pricing_usd_per_1k_completion,
      raw                           = excluded.raw,
      updated_at                    = excluded.updated_at
  `)

  db.transaction(rows => {
    for (const m of rows) {
      const arch = m.architecture || {}
      const top  = m.top_provider || {}
      const p    = m.pricing || {}
      const rawPrompt     = p.prompt     != null ? parseFloat(p.prompt)     : null
      const rawCompletion = p.completion != null ? parseFloat(p.completion) : null
      const promptUsd     = rawPrompt     != null && rawPrompt     >= 0 ? rawPrompt     : null
      const completionUsd = rawCompletion != null && rawCompletion >= 0 ? rawCompletion : null

      stmt.run({
        id:                           m.id,
        provider_pubkey:              PUBKEY,
        canonical_id:                 m.id,
        name:                         m.name || m.id,
        context_length:               m.context_length || top.context_length || null,
        max_completion_tokens:        top.max_completion_tokens || null,
        modality:                     arch.modality || null,
        input_modalities:             JSON.stringify(arch.input_modalities  || []),
        output_modalities:            JSON.stringify(arch.output_modalities || []),
        pricing_usd_prompt:           promptUsd,
        pricing_usd_completion:       completionUsd,
        pricing_usd_per_1k_prompt:    promptUsd     != null ? promptUsd     * 1000 : null,
        pricing_usd_per_1k_completion:completionUsd != null ? completionUsd * 1000 : null,
        raw:                          JSON.stringify(m),
        updated_at:                   now,
      })
    }
  })(models)
}

export async function syncOpenRouter() {
  try {
    console.log('Syncing OpenRouter models...')
    const models = await fetchModels()
    upsertProvider()
    upsertModels(models)
    console.log(`OpenRouter: synced ${models.length} models`)
  } catch (e) {
    console.error('OpenRouter sync failed:', e.message)
  }
}
