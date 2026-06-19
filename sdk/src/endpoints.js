export function buildEndpoints(c) {
  return {

    // ── Data APIs ─────────────────────────────────────────────────────────────
    data: {
      /** Crypto prices — ids: 'bitcoin' or ['bitcoin','ethereum'] */
      crypto:  (ids)               => c.get('/data/crypto',  { query: { ids: [].concat(ids).join(',') } }),
      /** Current Bitcoin on-chain fee estimates */
      fees:    ()                  => c.get('/data/btc/fees'),
      /** FX rates — base: 'USD', targets: 'EUR' or ['EUR','GBP'] */
      fx:      (base, targets)     => c.get('/data/fx',      { query: { base, targets: [].concat(targets).join(',') } }),
      /** Stock / ETF / crypto price — symbol: 'AAPL' | 'TSLA' | 'BTC-USD' */
      stock:   (symbol)            => c.get('/data/stock',   { query: { symbol } }),
      /** Weather for a location string */
      weather: (location)          => c.get('/data/weather', { query: { location } }),
      /** IP geolocation — omit ip to look up caller's IP */
      ip:      (ip)                => c.get('/data/ip',      { query: { ip } }),
      /** DNS lookup — type: 'A' | 'MX' | 'TXT' | etc. */
      dns:     (domain, type)      => c.get('/data/dns',     { query: { domain, type } }),
      /** Domain WHOIS / RDAP info */
      whois:   (domain)            => c.get('/data/whois',   { query: { domain } }),
      /** Email address validation and MX check */
      email:   (email)             => c.get('/data/email',   { query: { email } }),
      /** Wikipedia summary for a topic */
      wiki:    (topic)             => c.get('/data/wiki',    { query: { topic } }),
      /** Hacker News stories — feed: 'top'|'new'|'best', n: count */
      hn:      (feed, n)           => c.get('/data/hn',      { query: { feed, n } }),
      /** News search */
      news:    (q, n)              => c.get('/data/news',    { query: { q, n } }),
      /** GitHub repo stats — repo: 'owner/name' */
      github:  (repo)              => c.get('/data/github',  { query: { repo } }),
      /** Parse an RSS/Atom feed URL */
      feed:    (url)               => c.get('/data/feed',    { query: { url } }),
      /** Wayback Machine — check if URL is archived */
      wayback: (url)               => c.get('/data/wayback', { query: { url } }),
    },

    // ── AI Tools ─────────────────────────────────────────────────────────────
    ai: {
      /** Summarize text — maxWords optional */
      summarize:  (text, maxWords)        => c.post('/ai/summarize',  { body: { text, max_words: maxWords } }),
      /** Translate text to a target language */
      translate:  (text, to, from)        => c.post('/ai/translate',  { body: { text, to, from } }),
      /** Sentiment analysis — returns positive/negative/neutral + score */
      sentiment:  (text)                  => c.post('/ai/sentiment',  { body: { text } }),
      /** Zero-shot classification — labels: ['sports','tech', ...] */
      classify:   (text, labels)          => c.post('/ai/classify',   { body: { text, labels } }),
      /** Compare items on criteria — returns ranked result */
      compare:    (items, criteria)       => c.post('/compare',        { body: { items, criteria } }),
      /** Structured extraction — schema: { field: 'description' } */
      extract:    (text, schema)          => c.post('/ai/extract',    { body: { text, schema } }),
      /** Text-to-speech — returns raw Response (pipe to file/stream) */
      tts:        (text, voice)           => c.post('/ai/tts',        { body: { text, voice }, raw: true }),
      /** Speech-to-text from audio URL */
      stt:        (audioUrl, model)       => c.post('/ai/stt',        { body: { audio_url: audioUrl, model } }),
      /** Vision — describe or answer questions about an image URL */
      vision:     (imageUrl, question)    => c.post('/ai/vision',     { body: { image_url: imageUrl, question } }),
      /** Image generation — returns raw Response (pipe to file) */
      image:      (prompt, size)          => c.post('/ai/image',      { body: { prompt, size }, raw: true }),
    },

    // ── Compute Utilities ────────────────────────────────────────────────────
    compute: {
      /** Count tokens in text */
      tokenize: (text, model)       => c.post('/compute/tokens', { body: { text, model } }),
      /** Generate QR code PNG — returns raw Response */
      qr:       (data, size)        => c.get('/compute/qr',      { query: { data, size }, raw: true }),
      /** Evaluate a math expression — e.g. 'Math.sqrt(2) * 100' */
      math:     (expr)              => c.get('/compute/math',     { query: { expr } }),
      /** SSL certificate info for a domain */
      ssl:      (domain)            => c.get('/compute/ssl',      { query: { domain } }),
      /** Check if a TCP port is open */
      port:     (host, port)        => c.get('/compute/port',     { query: { host, port } }),
      /** Hash text — algo: 'sha256' | 'sha512' | 'md5' | 'sha1' */
      hash:     (text, algo)        => c.get('/compute/hash',     { query: { text, algo } }),
      /** Generate UUID v4 — n: how many (default 1) */
      uuid:     (n)                 => c.get('/compute/uuid',     { query: { n } }),
      /** Base64 encode/decode — action: 'encode' | 'decode' */
      base64:   (data, action)      => c.get('/compute/base64',   { query: { data, action } }),
    },

    // ── Agent State ──────────────────────────────────────────────────────────
    state: {
      counter: {
        /** Get current counter value */
        get:  (agentId, name)           => c.get('/state/counter',  { query: { agent_id: agentId, name } }),
        /** Increment counter by delta (default 1, use negative to decrement) */
        inc:  (agentId, name, delta)    => c.post('/state/counter', { body: { agent_id: agentId, name, delta } }),
        /** Reset and delete a counter */
        del:  (agentId, name)           => c.del('/state/counter',  { query: { agent_id: agentId, name } }),
      },
      log: {
        /** Append an event to the agent log */
        append: (agentId, event, data)  => c.post('/state/log',     { body: { agent_id: agentId, event, data } }),
        /** Read recent log entries — limit: max rows */
        read:   (agentId, limit)        => c.get('/state/log',      { query: { agent_id: agentId, limit } }),
      },
      queue: {
        /** Submit a job to the queue — type: string, payload: any */
        submit: (type, payload)         => c.post('/state/queue',   { body: { type, payload } }),
        /** Poll for the next pending job of a given type */
        poll:   (type)                  => c.get('/state/queue',    { query: { type } }),
      },
    },

    // ── Reputation ───────────────────────────────────────────────────────────
    reputation: {
      /** Get reputation score for a wallet address or agent ID (FREE, no auth) */
      get:         (id) => c.get(`/reputation/${encodeURIComponent(id)}`),
      /** Get SVG badge for embedding — returns raw Response */
      badge:       (id) => c.get(`/reputation/${encodeURIComponent(id)}/badge`, { raw: true }),
      /** Leaderboard of top agents by reputation (FREE, no auth) */
      leaderboard: ()   => c.get('/reputation'),
    },

  }
}
