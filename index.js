import 'dotenv/config'
import { startNostrListener } from './src/nostr.js'
import { checkAllProviders } from './src/checker.js'
import { initServer } from './src/server.js'
import { syncOpenRouter } from './src/openrouter.js'
import { syncAntSeed } from './src/antseed.js'

if (!process.env.NWC_SECRET) {
  console.error('ERROR: NWC_SECRET not set in .env — copy it from Alby Hub')
  process.exit(1)
}

console.log('Starting AIRadar — cross-network AI provider directory...')

startNostrListener()
initServer()

// Routstr: health check every 5 minutes
checkAllProviders()
setInterval(checkAllProviders, 5 * 60 * 1000)

// OpenRouter: sync models every 30 minutes
syncOpenRouter()
setInterval(syncOpenRouter, 30 * 60 * 1000)

// AntSeed: DHT discovery every 30 minutes
syncAntSeed()
setInterval(syncAntSeed, 30 * 60 * 1000)
