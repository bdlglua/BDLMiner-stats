// Public BDLMiner statistics only: no private-monitoring keys or payout addresses.
// Uses the Supabase server wrapper so elevated credentials never reach miners/browsers.
import { withSupabase } from 'npm:@supabase/server@1'

const origin = '*'
const cors = {
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600',
  'X-Content-Type-Options': 'nosniff',
}
const pools = new Set(['public-pool.io','nerdminers.org','nerdminer.io','ckpool.org','ocean.xyz',
  'braiins.com','viabtc.com','f2pool.com','antpool.com','bdl-pool.com','solopool.org',
  'kano.is','atlaspool.io','solomining.de','satoshiradio.nl','noderunners.network',
  'd-central.tech','mining-dutch.nl','luxor.tech','nicehash.com','secpool.com',
  'spiderpool.com','hmpool.io','molepool.com','peermining.org','other'])
const coins = new Set(['BTC','BCH','BSV','XEC','DGB','PPC'])

function response(body: unknown, status = 200, additional: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { ...cors, 'Cache-Control': 'no-store', ...additional } })
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}
function validReport(v: unknown): v is Record<string, unknown> {
  if (!isRecord(v)) return false
  if (Object.keys(v).some((key) => !['v','board','hashrate','every','model','coin','pool'].includes(key))) return false
  if (typeof v.v !== 'string' || v.v.length > 23 || !/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v.v)) return false
  if (typeof v.board !== 'string' || !/^[a-z0-9-]{1,32}$/.test(v.board)) return false
  const max = v.board === 'bitaxe-gamma-601' ? 5e12 : v.board === 'nerdnos' ? 2e12 : 5e6
  if (typeof v.hashrate !== 'number' || !Number.isFinite(v.hashrate) || v.hashrate <= 0 || v.hashrate > max) return false
  if (v.every !== undefined && (!Number.isInteger(v.every) || (v.every as number) < 60 || (v.every as number) > 86400)) return false
  if (v.model !== undefined && (typeof v.model !== 'string' || !/^[A-Za-z0-9 .+()-]{1,39}$/.test(v.model))) return false
  if (v.coin !== undefined && (typeof v.coin !== 'string' || !coins.has(v.coin))) return false
  if (v.pool !== undefined && (typeof v.pool !== 'string' || !pools.has(v.pool))) return false
  return true
}
async function limitedBody(req: Request): Promise<string | null> {
  const size = Number(req.headers.get('Content-Length') ?? '0')
  if (!Number.isFinite(size) || size > 2048) return null
  const reader = req.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > 2048) { await reader.cancel(); return null }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return new TextDecoder().decode(bytes)
}

export default {
  fetch: withSupabase({ auth: 'none' }, async (req, ctx) => {
    const path = new URL(req.url).pathname
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (req.method === 'GET' && path.endsWith('/healthz')) return response({ ok: true, runtime: 'supabase-public-stats' })
    if (req.method === 'GET' && path.endsWith('/api/summary')) {
      const { data, error } = await ctx.supabaseAdmin.rpc('bdl_stats_summary')
      if (error || !isRecord(data) || !Number.isFinite(data.at) || !Number.isFinite(data.hashrate)) {
        return response({ error: 'summary_unavailable' }, 503)
      }
      return response(data, 200, { 'Cache-Control': 'public, max-age=15, stale-while-revalidate=15' })
    }
    if (req.method === 'POST' && path.endsWith('/report')) {
      const contentType = req.headers.get('Content-Type') ?? ''
      if (!/^application\/json(?:\s*;|$)/i.test(contentType)) return response({ error: 'content_type' }, 415)
      const body = await limitedBody(req)
      if (body === null) return response({ error: 'too_large' }, 413)
      let payload: unknown
      try { payload = JSON.parse(body) } catch { return response({ error: 'invalid_json' }, 400) }
      if (!validReport(payload)) return response({ error: 'invalid_report' }, 400)
      const { data, error } = await ctx.supabaseAdmin.rpc('bdl_stats_ingest', { payload })
      if (error) return response({ error: 'write_unavailable' }, 503)
      if (!data) return response({ error: 'rate_limited' }, 429, { 'Retry-After': '60' })
      return new Response(null, { status: 204, headers: { ...cors, 'Cache-Control': 'no-store' } })
    }
    return response({ error: 'not_found' }, 404)
  }),
}
