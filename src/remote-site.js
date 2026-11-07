// The same remote viewer as the Worker, packaged as standalone static files.
import { REMOTE_PAGE, REMOTE_APP, REMOTE_STYLE } from './remote-page.js';

export const REMOTE_API_ORIGIN = 'https://bdlminer-stats.bdlminer-bot.workers.dev';
export function remoteFiles(apiOrigin = REMOTE_API_ORIGIN) {
  const url = new URL(apiOrigin);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
      url.origin !== apiOrigin || url.username || url.password)
    throw new Error('Configure a root HTTPS API origin');
  const policy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src " + apiOrigin + "; base-uri 'none'; form-action 'none'";
  const meta = '<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><meta name="bdl-remote-api" content="' + apiOrigin + '"><meta http-equiv="Content-Security-Policy" content="' + policy + '">';
  const page = REMOTE_PAGE.replace('<head>', '<head>' + meta)
    .replace('href="/remote.css"', 'href="./remote.css"').replace('src="/remote.js"', 'src="./remote.js"')
    .replace('<title>BDLMiner V2 · My miners</title>', '<title>BDLMiner V2 · My miners / Mes mineurs</title>');
  return { 'index.html': page, 'remote.js': REMOTE_APP, 'remote.css': REMOTE_STYLE };
}
