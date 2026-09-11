import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TelemetryStore, TelemetryWatcher } from './telemetry.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = new TelemetryStore(path.join(root, 'telemetry.sqlite'));
const telemetryRoots = [
  { directory: path.join(process.env.HOME, '.codex', 'sessions'), kind: 'active' },
  { directory: path.join(process.env.HOME, '.codex', 'archived_sessions'), kind: 'archived' }
];
const watcher = new TelemetryWatcher(store, telemetryRoots);
const clients = new Set();
const json = (response, data, status = 200) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(data)); };
const broadcast = () => { const payload = `event: telemetry\ndata: ${JSON.stringify({ updatedAt: new Date().toISOString() })}\n\n`; for (const client of clients) client.write(payload); };
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/api/overview') return json(response, store.overview());
  if (url.pathname === '/api/sessions') return json(response, store.sessions(Math.min(Number(url.searchParams.get('limit')) || 100, 250), { titleCatalogPath: path.join(process.env.HOME, '.codex', 'sqlite', 'codex-dev.db') }));
  if (url.pathname.startsWith('/api/sessions/')) return json(response, store.session(decodeURIComponent(url.pathname.slice('/api/sessions/'.length))));
  if (url.pathname === '/events') { response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); response.write('retry: 1500\n\n'); clients.add(response); request.on('close', () => clients.delete(response)); return; }
  const publicFile = url.pathname === '/app.js' ? 'app.js' : url.pathname === '/styles.css' ? 'styles.css' : 'index.html';
  const { readFile } = await import('node:fs/promises');
  const types = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'application/javascript; charset=utf-8', 'styles.css': 'text/css; charset=utf-8' };
  try { response.writeHead(200, { 'content-type': types[publicFile], 'cache-control': 'no-store' }); response.end(await readFile(path.join(root, 'public', publicFile))); } catch { response.writeHead(404).end(); }
});

let scanning = false;
let shuttingDown = false;
let scanPromise = Promise.resolve();
async function refreshTelemetry() {
  if (scanning || shuttingDown) return scanPromise;
  scanning = true;
  scanPromise = (async () => {
    try {
      const additions = await watcher.scan();
      if (additions && !shuttingDown) broadcast();
    } catch (error) {
      console.error('Telemetry scan failed:', error.message);
    } finally {
      scanning = false;
    }
  })();
  return scanPromise;
}
await store.backfillSessionSources(telemetryRoots);
void refreshTelemetry();
const refreshInterval = setInterval(refreshTelemetry, 1250);
refreshInterval.unref();
server.listen(Number(process.env.PORT || 3337), '127.0.0.1', () => console.log('Codex Telemetry Dashboard: http://127.0.0.1:' + (process.env.PORT || 3337)));
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(refreshInterval);
  for (const client of clients) client.end();
  clients.clear();
  await new Promise((resolve) => server.close(resolve));
  await scanPromise;
  store.close();
  process.exit(0);
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
