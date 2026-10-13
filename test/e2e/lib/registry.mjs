// test/e2e/lib/registry.mjs — a scripted stand-in for skills.sh on a loopback port, wired into the plugin
// through the SINGULAR_REGISTRY_BASE test seam (lib/config.js honours loopback http(s) only).
//
//   const reg = await startRegistry({ mode: 'ok' });      // modes: ok | delay | 429 | 500 | garbage | hostile | down
//   reg.base                                               // http://127.0.0.1:<port>
//   reg.requests                                           // [{method, path, query, at}] in arrival order
//   reg.setMode('429'); reg.setMode('delay', { delayMs: 4000 })
//   await reg.close()
//
// Routes (what lib/registry.js calls):
//   GET /api/search?q=skill&owner=<o>&limit=200   -> the owner's catalog ({skills:[{source, skillId, name, installs}]})
//   GET /api/search?q=<word>&limit=200            -> entries whose name/source contain the word (real fixtures for
//                                                    react / karpathy / frontend-design)
//   GET /api/v1/skills/audit/<owner>/<repo>/<skill> -> real audit fixtures for karpathy-guidelines and frontend-design,
//                                                    scripted verdicts for the synthetic entries, 404 otherwise
// The catalog is built from the committed fixtures (test/fixtures/search.*.json) plus a few synthetic allowlisted
// entries (see catalog.mjs) so that prompts about playwright / stripe / pricing pages get candidates that are NOT
// installed on the host machine. Registry responses are data: hostile mode serves malformed and injection-shaped
// entries to prove the plugin never relays them.

import http from 'node:http';
import { URL } from 'node:url';

import { buildCatalog, HOSTILE_ENTRIES, auditFor } from './catalog.mjs';

export async function startRegistry({ mode = 'ok', delayMs = 3000, catalog, root } = {}) {
  const data = catalog ?? buildCatalog(root);
  const state = { mode, delayMs };
  const requests = [];

  const respond = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  const search = (q, owner) => {
    const list = state.mode === 'hostile' ? [...HOSTILE_ENTRIES, ...data.entries] : data.entries;
    const needle = String(q ?? '').toLowerCase().trim();
    let skills;
    if (owner) {
      skills = list.filter((e) => typeof e?.source === 'string' && e.source.toLowerCase().split('/')[0] === String(owner).toLowerCase());
    } else if (data.fixtures[needle]) {
      skills = state.mode === 'hostile' ? [...HOSTILE_ENTRIES, ...data.fixtures[needle]] : data.fixtures[needle];
    } else {
      const words = needle.split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
      skills = list.filter((e) => {
        const hay = `${e?.name ?? ''} ${e?.skillId ?? ''} ${e?.source ?? ''}`.toLowerCase();
        return words.some((w) => hay.includes(w));
      });
    }
    return { query: q, searchType: 'mock', skills: skills.slice(0, 200) };
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const query = Object.fromEntries(url.searchParams.entries());
    requests.push({ method: req.method, path: url.pathname, query, at: Date.now(), mode: state.mode });
    const handle = () => {
      if (state.mode === '429') return respond(res, 429, { error: 'rate limited' });
      if (state.mode === '500') return respond(res, 500, { error: 'boom' });
      if (state.mode === 'garbage') return respond(res, 200, '<html>not json at all {{{', 'text/html');
      if (url.pathname === '/api/search') return respond(res, 200, search(query.q, query.owner));
      const m = /^\/api\/v1\/skills\/audit\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (m) {
        const audit = auditFor(root, decodeURIComponent(m[1]), decodeURIComponent(m[2]), decodeURIComponent(m[3]));
        if (!audit) return respond(res, 404, { error: 'not found' });
        return respond(res, 200, audit);
      }
      return respond(res, 404, { error: 'no such route' });
    };
    if (state.mode === 'delay') setTimeout(handle, state.delayMs);
    else handle();
  });
  server.keepAliveTimeout = 500;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  let closed = false;
  const close = () =>
    new Promise((resolve) => {
      if (closed) return resolve();
      closed = true;
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  if (mode === 'down') await close(); // the port is now closed: every request fails with ECONNREFUSED

  return {
    base,
    port,
    requests,
    catalog: data,
    get mode() {
      return state.mode;
    },
    setMode(m, opts = {}) {
      state.mode = m;
      if (typeof opts.delayMs === 'number') state.delayMs = opts.delayMs;
    },
    close,
    /** Requests grouped: catalogs (owner), keyword searches (q), audits. */
    summary() {
      const catalogs = requests.filter((r) => r.path === '/api/search' && r.query.owner).map((r) => r.query.owner);
      const searches = requests.filter((r) => r.path === '/api/search' && !r.query.owner).map((r) => r.query.q);
      const audits = requests.filter((r) => r.path.startsWith('/api/v1/skills/audit/')).map((r) => r.path.slice('/api/v1/skills/audit/'.length));
      return { catalogs, searches, audits, total: requests.length };
    },
  };
}
