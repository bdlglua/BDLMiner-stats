// The same remote viewer as the Worker, packaged as standalone static files.
import { createHash } from 'node:crypto';
import { REMOTE_PAGE, REMOTE_APP, REMOTE_STYLE } from './remote-page.js';

export const REMOTE_API_ORIGIN = 'https://api.bdl-pool.com:36018';
const digest = text => createHash('sha256').update(text).digest('hex').slice(0, 12);
export function remoteFiles(apiOrigin = REMOTE_API_ORIGIN) {
  const url = new URL(apiOrigin);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
      url.origin !== apiOrigin || url.username || url.password)
    throw new Error('Configure a root HTTPS API origin');
  const policy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src " + apiOrigin + "; base-uri 'none'; form-action 'none'";
  const meta = '<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><meta name="bdl-remote-api" content="' + apiOrigin + '"><meta http-equiv="Content-Security-Policy" content="' + policy + '">';
  const page = REMOTE_PAGE.replace('<head>', '<head>' + meta)
    // A content digest in each asset link: a browser never mixes a new page with a cached old script or style.
    .replace('href="/remote.css"', 'href="./remote.css?v=' + digest(REMOTE_STYLE) + '"')
    .replace('src="/remote.js"', 'src="./remote.js?v=' + digest(REMOTE_APP) + '"')
    .replace('<title>BDLMiner V2 · My miners</title>', '<title>BDLMiner V2 · My miners / Mes mineurs</title>');
  return { 'index.html': page, 'remote.js': REMOTE_APP, 'remote.css': REMOTE_STYLE };
}
