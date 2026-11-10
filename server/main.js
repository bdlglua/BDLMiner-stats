import { createCollector } from './http.js';

process.umask(0o077);
const app = createCollector({
  directory: process.env.STATS_DATA || '/var/lib/bdlminer-stats',
  publicOrigin: process.env.STATS_PUBLIC_ORIGIN || 'https://api.bdl-pool.com:36018',
  viewerOrigins: process.env.REMOTE_VIEWER_ORIGIN || 'https://miner.bdl-pool.com https://bdlglua.github.io',
  requestsPerMinute: Number(process.env.STATS_REQUESTS_PER_MINUTE || 1200),
  reportsPerMinute: Number(process.env.STATS_REPORTS_PER_MINUTE || 300),
  maxSpaces: Number(process.env.STATS_MAX_SPACES || 2048),
});
app.server.listen(8787, '127.0.0.1', () => console.log('BDLMiner statistics ready on 127.0.0.1:8787'));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
  const timeout = setTimeout(() => process.exit(1), 10000); timeout.unref();
  await app.close(); clearTimeout(timeout);
});
