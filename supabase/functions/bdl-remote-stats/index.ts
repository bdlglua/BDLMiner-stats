// Private BDLMiner telemetry. Credentials are custom Authorization values:
// "Address <payout-address>" or "Bearer <64-character private key>".
// Only a SHA-256 digest of that value is sent to Postgres; plaintext secrets
// are never persisted or logged.
import { withSupabase } from 'npm:@supabase/server@1'

const allowedOrigins = new Set([
  'https://miner.bdl-pool.com',
  'https://bdlglua.github.io',
])
const pools = new Set([
  'public-pool.io','nerdminers.org','nerdminer.io','ckpool.org','ocean.xyz',
  'braiins.com','viabtc.com','f2pool.com','antpool.com','bdl-pool.com',
  'solopool.org','kano.is','atlaspool.io','solomining.de','satoshiradio.nl',
  'noderunners.network','d-central.tech','mining-dutch.nl','luxor.tech',
  'nicehash.com','secpool.com','spiderpool.com','hmpool.io','molepool.com',
  'peermining.org','other','unknown',
])
const coins = new Set(['BTC','BCH','BSV','XEC','DGB','PPC'])
const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
}
function send(body: unknown, status = 200, origin: string | null = null, methods = 'GET, DELETE') {
  const headers = new Headers({
    ...securityHeaders,
    'Content-Type': 'application/json; charset=utf-8',
  })
  if (origin && allowedOrigins.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Access-Control-Allow-Methods', methods)
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    headers.set('Access-Control-Max-Age', '600')
    headers.set('Vary', 'Origin')
  }
  if (status === 429 || status === 503) headers.set('Retry-After', '60')
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers })
}
function noContent(origin: string | null) {
  return send(null, 204, origin)
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('')
}
async function credentials(req: Request): Promise<{ spaceId: string; key: boolean } | null> {
  const header = req.headers.get('Authorization') ?? ''
  if (header.startsWith('Bearer ')) {
    const secret = header.slice(7)
    if (!/^[a-f0-9]{64}$/.test(secret)) return null
    return { spaceId: await digest(secret), key: true }
  }
  if (header.startsWith('Address ')) {
    const address = header.slice(8).trim().split('.')[0].toLowerCase()
    if (!/^[a-z0-9:_-]{4,100}$/.test(address)) return null
    return { spaceId: await digest('address:' + address), key: false }
  }
  return null
}
function validReport(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const text = (key: string) => typeof value[key] === 'string' ? value[key] as string : ''
  const number = (key: string) => typeof value[key] === 'number' && Number.isFinite(value[key])
  const integer = (key: string, max = 4294967295) =>
    number(key) && Number.isInteger(value[key]) && (value[key] as number) >= 0 && (value[key] as number) <= max
  const board = text('board')
  const version = text('v')
  const maxRate = board === 'nerdnos' ? 2e12 : board === 'bitaxe-gamma-601' ? 5e12 : 5e6
  const name = text('name')
  const temp = value.temp_c
  return /^[a-f0-9]{16}$/.test(text('id'))
    && name.length >= 1 && name.length <= 48
    && !Array.from(name).some((c) => {
      const code = c.codePointAt(0) ?? 0
      return code < 32 || code === 127
    })
    && /^[a-z0-9-]{1,32}$/.test(board)
    && version.length <= 23
    && /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
    && coins.has(text('coin'))
    && /^[a-f0-9]{1,16}$/.test(text('boot_id'))
    && number('hashrate') && (value.hashrate as number) >= 0 && (value.hashrate as number) <= maxRate
    && number('total_hashes') && (value.total_hashes as number) >= 0 && (value.total_hashes as number) <= 1e30
    && number('best') && (value.best as number) >= 0 && (value.best as number) <= 1e30
    && integer('uptime_s')
    && integer('accepted')
    && integer('rejected')
    && integer('power_percent', 100)
    && (temp === null || (typeof temp === 'number' && Number.isFinite(temp) && temp >= -50 && temp <= 150))
    && typeof value.pool_connected === 'boolean'
    && typeof value.firmware_trial === 'boolean'
    && pools.has(text('pool'))
}
function cleanReport(value: Record<string, unknown>) {
  const keys = [
    'id','name','board','v','coin','boot_id','uptime_s','total_hashes','hashrate',
    'temp_c','accepted','rejected','best','power_percent','pool_connected','pool','firmware_trial',
  ]
  return Object.fromEntries(keys.map((key) => [key, value[key]]))
}
function rpcError(error: unknown) {
  // Do not expose Postgres, project, or service-role details to callers.
  return send({ error: 'storage_unavailable' }, 503)
}
export default {
  fetch: withSupabase({ auth: 'none' }, async (req, ctx) => {
    const path = new URL(req.url).pathname
    const origin = req.headers.get('Origin')
    const isReport = path.endsWith('/api/remote/report')
    const isHistory = path.endsWith('/api/remote/history')
    const isRemote = path.endsWith('/api/remote')
    const isHealth = path.endsWith('/healthz')
    const methods = isReport ? '' : isHistory ? 'GET' : isRemote ? 'GET, DELETE' : 'GET'

    if (origin && (!allowedOrigins.has(origin) || isReport)) {
      return send({ error: 'Origin not allowed' }, 403)
    }
    if (req.method === 'OPTIONS') {
      const requestedMethod = req.headers.get('Access-Control-Request-Method') ?? ''
      const requestedHeaders = (req.headers.get('Access-Control-Request-Headers') ?? '')
        .split(',').map((v) => v.trim().toLowerCase()).filter(Boolean)
      const allowedMethods = methods.split(',').map((v) => v.trim()).filter(Boolean)
      if (!origin || !allowedOrigins.has(origin) || !allowedMethods.includes(requestedMethod)
        || requestedHeaders.some((h) => !['authorization','content-type'].includes(h))) {
        return send({ error: 'Preflight not allowed' }, 403)
      }
      return send(null, 204, origin, methods)
    }
    if (req.method === 'GET' && isHealth) {
      return send({ status: 'ok', service: 'bdl-remote-stats', runtime: 'supabase-edge' }, 200, origin)
    }

    const allowed = (isReport && req.method === 'POST')
      || (isRemote && ['GET','DELETE'].includes(req.method))
      || (isHistory && req.method === 'GET')
    if (!allowed) return send({ error: 'Not found' }, 404, origin, methods)

    const auth = await credentials(req)
    if (!auth) return send({ error: 'Wallet address or private access key required' }, 401, origin, methods)

    if (isReport) {
      if (!req.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
        return send({ error: 'Invalid private report' }, 415)
      }
      const declared = Number(req.headers.get('Content-Length') ?? '0')
      if (Number.isFinite(declared) && declared > 2048) return send({ error: 'Invalid private report' }, 413)
      let raw: string
      try {
        const bytes = new Uint8Array(await req.arrayBuffer())
        if (bytes.byteLength > 2048) return send({ error: 'Invalid private report' }, 413)
        raw = new TextDecoder().decode(bytes)
      } catch {
        return send({ error: 'Invalid private report' }, 400)
      }
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch { return send({ error: 'Invalid private report' }, 400) }
      if (!validReport(parsed)) return send({ error: 'Invalid private report' }, 400)
      try {
        const { data, error } = await ctx.supabaseAdmin.rpc('bdl_remote_ingest', {
          p_space_id: auth.spaceId,
          p_report: cleanReport(parsed),
        })
        if (error) return rpcError(error)
        const status = Number(data)
        return status === 204 ? noContent(null)
          : send({ error: status === 410 ? 'This access key has been revoked'
            : status === 409 ? 'This space already contains 32 miners'
            : status === 429 ? 'Please wait before trying again'
            : status === 503 ? 'Storage capacity reached'
            : 'Invalid private report' }, status >= 400 && status <= 599 ? status : 500)
      } catch (error) { return rpcError(error) }
    }

    if (req.method === 'DELETE') {
      if (!auth.key) return send({ error: 'Only a private access key can erase readings' }, 403, origin, methods)
      try {
        const { data, error } = await ctx.supabaseAdmin.rpc('bdl_remote_revoke', { p_space_id: auth.spaceId })
        if (error) return rpcError(error)
        const status = Number(data)
        return status === 204 ? noContent(origin)
          : send({ error: status === 429 ? 'Please wait before trying again' : 'Storage capacity reached' },
            status >= 400 && status <= 599 ? status : 500, origin, methods)
      } catch (error) { return rpcError(error) }
    }

    if (isRemote) {
      try {
        const { data, error } = await ctx.supabaseAdmin.rpc('bdl_remote_snapshot', { p_space_id: auth.spaceId })
        if (error) return rpcError(error)
        const status = Number(data?._status ?? 200)
        if (status !== 200) return send({ error: data?.error ?? 'Request failed' }, status, origin, methods)
        return send(data, 200, origin, methods)
      } catch (error) { return rpcError(error) }
    }

    if (isHistory) {
      const url = new URL(req.url)
      const miner = url.searchParams.get('miner') ?? ''
      const hours = Number(url.searchParams.get('hours') ?? '24')
      if (!/^[a-f0-9]{16}$/.test(miner) || ![1,6,24,168].includes(hours)) {
        return send({ error: 'Invalid history window' }, 400, origin, methods)
      }
      try {
        const { data, error } = await ctx.supabaseAdmin.rpc('bdl_remote_history', {
          p_space_id: auth.spaceId,
          p_miner: miner,
          p_hours: hours,
        })
        if (error) return rpcError(error)
        const status = Number(data?._status ?? 200)
        if (status !== 200) return send({ error: data?.error ?? 'Request failed' }, status, origin, methods)
        return send(data, 200, origin, methods)
      } catch (error) { return rpcError(error) }
    }
    return send({ error: 'Not found' }, 404, origin, methods)
  }),
}
