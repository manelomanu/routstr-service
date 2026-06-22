# Agent Profile & Behavioral Forensics — Design

**Module:** `agentanalysis` ("Chainalysis for agents")
**Status:** DESIGN — owner review required before any code
**Author:** design pass, 2026-06-21
**Scope:** Redesign `src/agentanalysis.js` (route `GET /agentanalysis/:id`, fn `registerChainAnalysisRoutes`) from a wallet-keyed analyzer into a **behavioral reputation / forensics engine** that produces verdicts from the data we actually have today: endpoint patterns, query topics, models, timing, IP/UA clustering — with wallet as an *enrichment* signal, not the primary key.

---

## 0. Problem statement & the central reframe

The current module keys every query on `wallet_address OR agent_id`. In production both are almost always empty (last 24h: ~2628 requests, **0 paid, 0 distinct wallets**, ~20 distinct agents by `ip_hash`). The analyzer is therefore **starved of subjects** — it can only profile entities that never show up.

Meanwhile the data we *do* have is rich and, crucially, includes a large, valuable population of **hostile scanners** (`/.env`, `/.git/config`, `/wp-admin/install.php`, `/.env.production`, `*.php` probes against a non-PHP API) plus **benign pollers** (heavy `/v1/models`, `/v1/info` polling, likely 1-2 monitors). This is real, abundant, monetizable threat-intel that the current design discards.

### The reframe (this is the whole point of the redesign)

1. **Identity is behavioral, not financial.** An "agent" is a behavioral cluster derived from `(ip_hash, user_agent, + wallet/agent_id when present)`. The wallet, when it appears, *enriches and merges* clusters; it is never required.

2. **Automation is NOT risk.** The existing `botScore` rewards "metronomic = bot = high risk." For an agent-forensics product this is *backwards*: agents **are** automated; a steady poller is the most benign subject we have. **Risk is malice/abuse/Sybil — not regularity.** We retire automation-as-risk entirely. CV/timing regularity survives only as a *descriptive fingerprint*, never as a risk input.

3. **The first-shippable, value-producing signal today is scanner detection.** We have hostile traffic in abundance and zero wallets. A path-reputation + error-ratio engine produces a real verdict on the ~20 agents and the scanner population *right now*, with no payments and no wallets.

### Relationship to the existing two reputation systems (do not confuse)

| System | File | Keyed on | Measures | State today |
|---|---|---|---|---|
| **Provider reputation** | `src/checker.js` / `providers` table (`uptime_ok_24h`, `is_online`, `response_ms`) | provider `pubkey` | Provider **uptime / liveness** | Working |
| **Agent economic reputation** | `src/reputation.js` (`score()`: `paid_calls`, age, diversity, recency, payment-rate) | `wallet_address OR agent_id` | Agent **economic standing** (good payer, diverse usage) | **Dead** — 0 paid calls, so every agent scores ~0/`unknown` |
| **Agent behavioral forensics** (THIS DESIGN) | new `agentanalysis` | **behavioral cluster** (ip/UA + wallet enrich) | Agent **trust/threat** from behavior | New — **works pre-payment** |

> Correction to the brief's framing: `src/reputation.js` does **not** score provider uptime. It is the *agent economic reputation* engine, keyed on `wallet OR agent_id`, and it is empty today precisely because nothing is paid. This new engine is the layer that **works now** (pre-payment, pre-wallet) and **later enriches** the economic one: once a wallet appears, behavioral cluster ↔ wallet ↔ on-chain bridge all link up.

---

## 1. Agent identity model

### 1.1 The composite `agent_key`

Neither `ip_hash` alone (NAT / shared-IP collisions) nor `user_agent` alone (generic library UAs) is a valid identity. We define a **composite key with a confidence level**:

```
distinctive_ua  = user_agent is non-empty AND not in GENERIC_UA_DENYLIST
agent_key       = distinctive_ua ?  sha1(ip_hash || '|' || normalize(user_agent))   // high confidence
                                  :  sha1(ip_hash)                                   // ip-only, LOW confidence
confidence      = distinctive_ua ? 'high' : 'low'
```

- `normalize(user_agent)`: lowercase, strip volatile version numbers (e.g. `MyAgent/1.4.2` → `myagent`), trim to a stable token. Prevents a version bump from forking one agent into many.
- An `agent_key` is the **cluster id** surfaced as `:id` (prefixed `c_…`) in the API.

### 1.2 The generic-UA denylist (this is the named bug fix)

The existing `stmtSharedAgent` clusters **any two wallets that share a `user_agent`**. Because the overwhelming majority of agents send a default library UA, this **merges every `python-httpx` caller on the planet into one entity** — a massive false-positive. Fix:

```
GENERIC_UA_DENYLIST (treated as NON-identifying; never a fingerprint on its own):
  python-httpx, python-requests, aiohttp, httpx,
  node-fetch, undici, axios, got,
  Go-http-client, okhttp, curl, Wget, libwww-perl,
  Java/*, Apache-HttpClient, PostmanRuntime, "" (empty)
  + any UA matching /^[a-z0-9._-]+\/[\d.]+$/ that is a known HTTP-client token
```

Rule: a UA only contributes to identity if it is **distinctive** (custom agent name, branded client, or an otherwise-rare string). For generic UAs, identity falls back to `ip_hash` alone and the cluster is flagged **`confidence: low`**. Low-confidence clusters:
- still get profiled and scored,
- but their **coordination / "same entity" verdicts are suppressed** (we never claim "same entity" purely because two callers both sent `python-httpx`),
- carry an explicit `identity_confidence: low` field so consumers don't over-trust a merge.

### 1.3 NAT / shared-IP collisions

Multiple independent agents behind one NAT share `ip_hash`. Mitigations:
- A distinctive UA *splits* a shared IP into separate high-confidence clusters (good).
- For ip-only clusters, we **do not assert single-entity**; we report them as a **shared-IP population** with a `distinct_ua_count` and treat them as a *neighborhood*, not an individual. A shared-IP cluster with many distinct generic-UA request shapes is labeled `shared_or_nat`, not `coordinated`.
- Coordination is only asserted when behavior *correlates* (synchronized bursts, identical query topics, identical endpoint sequences) **beyond** mere IP sharing.

### 1.4 Identity merging & splitting over time (wallet enrichment)

Behavioral clusters are **stateful** once a wallet appears, because a wallet links clusters *across* IPs/UAs and that linkage cannot be cheaply recomputed from `request_log` alone. Merge rules:

- **Wallet → cluster merge.** When a request carries a `wallet_address`, all `agent_key`s that have *ever* co-occurred with that wallet are merged into one **canonical cluster** (`canonical_id`). This is the Sybil-resistance + on-chain bridge moment. **`agent_id` is NOT a hard anchor:** per `analytics.js:126` it comes from `req.params.agent_id` (a URL path param) and is **self-asserted/spoofable**, whereas a wallet is cryptographically bound (EIP-3009 `from`). Therefore merging by shared `agent_id` is attacker-exploitable (free identity fusion) and is treated only as a **soft/provisional hint** (`merge_state: provisional`), never a `confirmed` merge on its own. Only a wallet (or repeated independent corroboration) hardens a merge.
- **Conflict / split.** If one `agent_key` is later seen with two *different* wallets, do **not** transitively merge those wallets (that would let an attacker fuse identities by rotating through a shared IP). Instead flag `identity_conflict: true` on that cluster and keep wallets distinct. Conflicts are themselves a Sybil signal.
- **Decay of merges.** Merges based on a *single* low-confidence co-occurrence are marked `provisional`; they harden to `confirmed` after N (≥3) independent co-occurrences. Provisional merges are reversible if contradicted.

### 1.5 Identity stability

`canonical_id` is stable across IP rotation **once a wallet/agent_id has anchored the cluster**. Pre-wallet, an `agent_key` is stable only as long as `(ip_hash, distinctive UA)` is stable — acceptable, because pre-wallet we are scoring *behavior in a window*, not asserting a durable identity. The API always returns `identity_confidence` so consumers calibrate trust.

---

## 2. Data collection model

### 2.1 Dimensions profiled per cluster

All derivable from the existing `request_log` columns (`ts, endpoint, method, status, response_ms, payment_type, payment_id, wallet_address, agent_id, model, ip_hash, user_agent, query_text`):

| Dimension | Source | Notes |
|---|---|---|
| **What they request** | `endpoint` distribution | Includes the malicious-path signal (see §3) |
| **What they search** | `query_text` → **topic taxonomy only** | NEVER raw. Mapped to categories; see §2.3 |
| **Which models** | `model` | model diversity / preference |
| **Outcome mix** | `status` | 200 vs 401/402 (unpaid) vs 404 (probing) vs 5xx |
| **Timing fingerprint** | `ts` deltas → CV | **descriptive only**, not a risk input |
| **Coordination** | shared `ip_hash` + correlated behavior | aggregated, never raw ip_hash |
| **Economic signal** | `payment_type`, `payment_id` | enrichment; absent today |
| **Identity** | `ip_hash`, `user_agent`, `wallet_address`, `agent_id` | clustering only; ip_hash/UA never echoed raw |

### 2.2 Privacy enforcement (non-negotiable, carried verbatim)

- `ip_hash`: **internal clustering only.** Never in any response — not even hashed-further. We expose *facts about* sharing (e.g. `shared_ip_cluster_size: 4`), never the hash.
- `query_text`: **never echoed raw.** Aggregated to topic/category counts only (§2.3).
- `user_agent`: not echoed raw by default (it can be semi-identifying / contain tokens). We expose a coarse `client_family` (e.g. `generic_http_client`, `branded_agent`, `browser`, `scanner_tool`).
- Counterparty `wallet_address` exposure in coordination output: **defaults to aggregate** (cluster size + verdict). Echoing neighbor wallets is deferred to an owner decision (see §6) — the current code echoes them; we do **not** silently keep that.

### 2.3 Query-text topic taxonomy

`query_text` is captured from `q/url/topic/domain/ids/repo/expr` (see `analytics.js`). We map each to a **category**, store/aggregate only the category:

```
taxonomy (keyword/regex → category), evaluated in order:
  scanner_probe    : matches sensitive-path or exploit patterns (.env, wp-admin, /.git, phpmyadmin, eval/exec payloads)
  code_repo        : github.com, gitlab, "repo", git URLs
  crypto_onchain   : wallet addrs, tx hashes, "usdc", "lightning", chain names
  ai_models        : model names, "gpt", "llama", "embedding", "completion"
  web_lookup       : generic URLs / domains (fetch/search)
  data_query       : structured ids, "expr", numeric/string lookups
  other            : fallback
```

Output is `{ category: count }` per cluster. The raw string never leaves the box.

### 2.4 Schema changes — minimal, justified

**Derive everything on the fly** at 2628 req/day; `request_log` + its indexes (`idx_rl_ts`, `idx_rl_endpoint`, `idx_rl_ip`) are sufficient for cluster-window aggregation. **Refuse aggregate/rollup tables** at this volume.

**The one justified persistent table:** cluster identity, because wallet-merge makes cluster assignment **stateful** (§1.4) and cannot be recomputed purely from logs once merges/conflicts accrue.

```sql
CREATE TABLE IF NOT EXISTS agent_cluster (
  agent_key       TEXT PRIMARY KEY,   -- ip-only or ip+distinctiveUA hash
  canonical_id    TEXT NOT NULL,      -- cluster after wallet merges (== agent_key until merged)
  confidence      TEXT DEFAULT 'low', -- 'high' (distinctive UA) | 'low' (ip-only)
  wallet_address  TEXT,               -- first/anchoring wallet, if ever seen
  agent_id        TEXT,
  merge_state     TEXT DEFAULT 'none',-- none | provisional | confirmed
  identity_conflict INTEGER DEFAULT 0,
  first_seen      INTEGER,
  last_seen       INTEGER,
  updated_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cluster_canonical ON agent_cluster(canonical_id);
CREATE INDEX IF NOT EXISTS idx_cluster_wallet    ON agent_cluster(wallet_address) WHERE wallet_address IS NOT NULL;
```

> Optional, later: a tiny `path_reputation(pattern, category, weight)` seed table if the owner wants to tune the scanner list without redeploy. Phase 1 can ship the list in code; no table needed yet.

Also add (cheap, supports cluster lookup): `CREATE INDEX IF NOT EXISTS idx_rl_ip_ua ON request_log(ip_hash, user_agent);`

No new columns on `request_log`.

---

## 3. Reputation derivation (behavioral, works with TODAY's data)

A **trust score 0–100** per cluster, where high = trustworthy and low = threat. This is the inverse posture of the old "risk score" and explicitly does **not** punish automation.

### 3.1 The "everyone is a bot" principle

Being automated is the *baseline*, not a penalty. We score on **malice / abuse / Sybil**, never on regularity. A metronomic poller of `/v1/models` is a **good** subject (consistent, legitimate) → high trust.

### 3.2 Inputs, weights, direction

Score starts at a **neutral baseline of 50** and is moved by signals, then clamped to 0–100. Each signal has a magnitude and a sign. (Positives sum to +65, negatives to −120; the asymmetry is intentional so threat signals can floor the score below 0 → clamp to 0.)

| Signal | Direction | Source / definition | Weight (max pts) |
|---|---|---|---|
| **Malicious-path probing** | − (dominant) | fraction of calls to sensitive/exploit paths (`/.env`, `/.git`, `/wp-admin`, `*.php` on non-PHP API, etc.) | up to −60 (this alone can floor the score) |
| **Error/probe ratio** | − | high 404 + 401-without-retry-pay ratio (scanning behavior) | up to −20 |
| **Legitimate consistency** | + | sustained use of real product endpoints (`/v1/*`, `/search`, `/providers`, …) over time | up to +25 |
| **Endpoint diversity (legit)** | + | distinct *legitimate* endpoints used | up to +10 |
| **Longevity** | + | days since first_seen (capped) | up to +10 |
| **Economic signal** | + | any paid calls (enrichment; 0 today) | up to +20 |
| **Sybil / coordination** | − | confirmed coordinated cluster (synchronized bursts + identical topics across many sub-identities), or `identity_conflict` | up to −25 |
| **Topic = scanner_probe** | − | query topics resolve to `scanner_probe` | up to −15 |

Timing CV is recorded as `timing.cv` and `timing.pattern` (`metronomic` / `bursty` / `irregular`) but contributes **0** to score.

> **Not double-counting:** `malicious_path_probing` (−60) reads from `endpoint`; `scanner_probe` topic (−15) reads from `query_text`. They are **distinct evidence sources**. A plain `GET /.env` fires only the first (no query string); an exploit *payload* in a query param fires the second. Both firing on one cluster is genuinely two independent observations, not one counted twice.

> **Attribution vs. occurrence (resolves the low-confidence cap, see §6#3):** A `/.env` hit is *observed behavior*, not an inference. So an **ip-only / low-confidence** cluster that contains probe behavior **CAN be labeled `malicious`** — we just flag it `confidence: low` with the caveat "this IP may also carry co-located legitimate traffic." The NAT-safety cap exists to avoid tarring a *legitimate co-located agent*, not to suppress the fact that a hostile probe occurred. In short: low confidence weakens *attribution to an individual*, it does not downgrade *the probe verdict itself*.

### 3.3 Time decay

Behavior ages out so a reformed/changed cluster isn't judged forever on stale activity, and so scanners that stopped don't dominate live views:

- All signal aggregations are computed over a **rolling 30-day window** by default (configurable), with an **exponential recency weight** `w = 0.5 ^ (age_days / 14)` (14-day half-life) applied per request when summing signals.
- Malicious-path hits decay **slower** (28-day half-life) — we forgive legitimate inactivity faster than we forget hostility.
- `first_seen`/longevity is *not* decayed (age is age).

### 3.4 Verdict taxonomy

Score → label, but the label is **also gated by hard signals** (a single confirmed `/.env` probe burst forces `malicious` regardless of score arithmetic):

| Label | Condition | Meaning |
|---|---|---|
| `malicious` | scanner/exploit signal present above threshold | Hostile scanner. Block. |
| `abusive` | high error/probe ratio, no exploit paths, but clearly hammering/fuzzing | Misbehaving, not (yet) exploiting. |
| `suspicious` | confirmed coordination / identity_conflict / Sybil pattern | Possible Sybil ring or spoofing. |
| `unproven` | < N requests OR `confidence: low` and no strong signal | Not enough behavior to judge. (default for thin clusters) |
| `legitimate` | consistent legit usage, no negative signals | Well-behaved agent/monitor. Safe. |
| `trusted` | `legitimate` + economic signal (paid) + longevity | Established, paying, long-lived. |

`unproven` (not "low risk") is the honest default for sparse data — avoids the old module's habit of confidently labeling thin subjects.

### 3.5 Worked outcomes on today's data

- A `/.env` + `/wp-admin` + `*.php` scanner → `scanner_probe` topic, malicious-path fraction high → score floored → **`malicious`**. *(This is the headline value today.)*
- The 1-2 `/v1/models` / `/v1/info` pollers → all-legit endpoints, metronomic but that's ignored, sustained over time → **`legitimate`** (or `trusted` once they pay).
- A one-off caller with 2 requests → **`unproven`**.

---

## 4. API shape

### 4.1 `:id` resolver

`:id` accepts any of: **cluster id** (`c_…` / `agent_key`), **wallet address**, **`agent_id`**. Resolver:

```
resolve(:id):
  if id starts with 'c_' or matches agent_key → cluster directly
  else if id matches a wallet/agent_id → look up agent_cluster by wallet/agent_id → canonical cluster
  else → treat as raw agent_key lookup
  → 404 if no cluster / no activity
```

### 4.2 `GET /agentanalysis/:id` (paid — keeps `requireChainAnalysis`)

Returns the behavioral profile + verdict. **No raw `ip_hash`, no raw `query_text`, no raw `user_agent`.**

```jsonc
{
  "id": "c_9f3a…",
  "resolved_from": "cluster",          // cluster | wallet | agent_id
  "analyzed_at": "2026-06-21T…Z",
  "identity": {
    "confidence": "low",               // high | low (ip-only / generic UA — typical for scanners)
    "attribution_caveat": "ip-only cluster; may include co-located legitimate traffic",
    "client_family": "scanner_tool",   // coarse, never raw UA
    "wallet_linked": false,
    "identity_conflict": false,
    "shared_ip_cluster_size": 1,       // fact of sharing, never the hash
    "first_seen": "…Z", "last_seen": "…Z"
  },
  "trust": {
    "score": 0,                        // baseline 50 floored by probe signal, clamped to 0
    "label": "malicious",              // probe is OBSERVED behavior — labelable even at low confidence
    "summary": "Cluster probes sensitive paths (/.env, /wp-admin). Hostile scanner — block.",
    "decayed_window_days": 30
  },
  "behavior": {
    "total_calls": 412,
    "calls_last_24h": 120,
    "legit_endpoint_ratio": 0.02,
    "error_ratio": 0.91,
    "top_endpoints": [ { "endpoint": "/.env", "calls": 88 }, … ],  // endpoints ARE public facts
    "query_topics": { "scanner_probe": 140, "other": 12 },          // categories only
    "models": [ … ],
    "payment": { "paid_calls": 0, "payment_types": [] }
  },
  "signals": {                          // descriptive, with sign + contribution
    "malicious_path_probing": { "fraction": 0.93, "contribution": -60 },
    "error_probe_ratio":      { "value": 0.91, "contribution": -18 },
    "coordination":           { "verdict": "none", "cluster_size": 1, "contribution": 0 },
    "timing":                 { "cv": 0.05, "pattern": "metronomic", "contribution": 0 }
  }
}
```

### 4.3 New: `GET /agentvet/:id` — "vet this counterparty" (cheap/free tier)

A lightweight, low-cost (or free, like `/reputation/:id`) lookup another agent calls **before transacting**, returning just the verdict:

```json
{ "id": "c_9f3a…", "score": 8, "label": "malicious",
  "confidence": "high", "recommendation": "reject",
  "reason": "scanner_probe", "powered_by": "https://airadar.fyi" }
```

`recommendation`: `reject` (malicious/abusive), `caution` (suspicious/unproven), `accept` (legitimate/trusted). This is the agent-to-agent integration hook and the natural counterpart to `/reputation/:id`. **Caveat (see §5 Phase 2):** this only works for outside callers once they have a stable identifier (wallet/agent_id) to pass — true pre-transaction *counterparty* vetting by third parties is a Phase-3 capability. Pre-wallet it serves operators and the gateway's own internal gating.

### 4.4 New: `GET /agentanalysis/threats` (paid, admin-adjacent or premium)

A live feed of the **scanner population** — the abundant value today: top `malicious`/`abusive` clusters, their probed-path categories, first/last seen. This is the "threat-intel" product surface. No raw ip/UA/query.

### 4.5 Removed / inverted

- The old `risk` block (bot=35%, coordination=30%, anomaly=20%, fingerprint=15%) is **removed**. Volume-anomaly z-score and bot-CV are **demoted to descriptive `signals`** with 0 weight.
- The old coordination block that echoed neighbor `wallet_address` is replaced by aggregate `shared_ip_cluster_size` + coordination verdict (raw neighbor wallets gated behind §6 owner decision).

---

## 5. Migration / phasing

Ordered, each step independently shippable; **Phase 1 is the smallest increment that produces value on current data.**

**Phase 1 — Scanner verdict from existing logs (ship first).**
- Add `GENERIC_UA_DENYLIST` + `agent_key`/`confidence` derivation helper.
- Add the malicious-path list + `query_text`→topic taxonomy.
- Re-key `/agentanalysis/:id` to resolve a cluster (ip-only is fine for now) and return the **trust score + verdict** with the scanner-detection signal as centerpiece. No new table yet — derive on the fly, treat each `agent_key` ephemerally.
- Inverts automation-as-risk; demotes CV/anomaly to descriptive.
- **Value delivered immediately:** real `malicious` verdicts on the ~20 agents + scanner traffic, with 0 wallets and 0 payments.

**Phase 2 — Stable identity + vet endpoint.**
- Add `agent_cluster` table; persist `agent_key`/`canonical_id`/`confidence`; populate from a lightweight pass (or lazily on lookup).
- Ship `GET /agentvet/:id` (the counterparty-vetting hook) and `GET /agentanalysis/threats`.
- **Honest scope:** pre-wallet, `/agentvet` and `/agentanalysis/:id` require the caller to *already hold* a cluster id. An external agent has **no stable identifier for a counterparty** until wallets/agent_ids actually flow at transaction time. So in Phase 2 these are primarily **operator / discovery tools** fed by the threats feed (§4.4), and an *internal* gate the gateway itself can apply (it knows the live cluster). True cold **counterparty-vetting by outsiders only becomes real in Phase 3**, once wallet/agent_id identifiers travel with transactions.

**Phase 3 — Wallet enrichment + merge.**
- Implement wallet→cluster merge, `provisional`/`confirmed` states, `identity_conflict`. Add economic-signal weighting. (Activates the moment first payments land.)

**Phase 4 — On-chain bridge (out of scope here).**
- Stop discarding the EIP-3009 `from` address in `gateway.js` (~line 202 currently only stores a SHA256 for dedup). Persist payer on-chain address against the cluster → enables public-chain forensics. **Later phase; not this design's core.**

---

## 6. Open questions / risks (owner decides)

1. **Counterparty-wallet exposure.** For `/agentvet` and coordination output, do we echo *neighbor* wallet addresses (useful for "who is this clustered with") or only aggregate cluster facts? The old code echoed them; privacy posture says aggregate-by-default. *Recommendation: aggregate by default; raw neighbor wallets only on a paid, explicitly-consented tier.*
2. **`/agentvet` pricing.** Free (max adoption, mirrors `/reputation/:id`, drives the network effect) vs cheap-paid (anti-abuse, revenue)? *Recommendation: free read like `/reputation/:id`, since pre-transaction vetting only has value if ubiquitous.*
3. **NAT false-positive tolerance.** How aggressively may a shared-IP cluster be labeled? A corporate/cloud NAT could co-locate a scanner and a legit agent under one ip-only key. *Recommendation (reconciled with §3.4 attribution rule):* an ip-only (low-confidence) cluster containing probe behavior **MAY be labeled `malicious`** — because the probe is observed behavior, not an inference — but it MUST carry `confidence: low` and a "may include co-located legitimate traffic" caveat. The cap is on **attribution to an individual**, not on the probe verdict: we never *attribute* the scan to a specific co-located legitimate agent, and we never floor a *separately-identified legit sub-cluster* (distinctive UA / wallet) just because it shares the IP. The threats feed surfaces such activity at the IP/cluster level. Owner may opt for a more conservative "ip-only caps at `suspicious`" policy if false-positive cost is judged higher than missed-scanner cost.
4. **Scanner-path list governance.** Ship in code (Phase 1) vs `path_reputation` table for hot-tuning. *Recommendation: code first; table only if tuning cadence demands it.*
5. **Decay half-lives.** 14-day (legit) / 28-day (malicious) are starting guesses — owner may want scanners to "never fully forgive." *Recommendation: make half-lives config constants.*
6. **Relationship to `src/reputation.js`.** Do we (a) keep two separate endpoints (`/reputation` economic, `/agentanalysis` behavioral), (b) merge behavioral trust into the existing `/reputation/:id` score, or (c) have economic reputation *consume* the behavioral verdict as an input once payments exist? *Recommendation: keep separate now; in Phase 3, feed behavioral `label` into the economic score as a gate (a `malicious` cluster can't be `trusted` no matter how much it pays).*
