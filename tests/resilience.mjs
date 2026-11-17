// Run: node tests/resilience.mjs
// Exercises the function's failure paths with a fake fetch: TED down, TED partial, Blob store fallback.
const realFetch = globalThis.fetch;
let stored = null, mode = 'ok', log = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('api.ted.europa.eu')) {
    if (mode === 'down') throw new Error('fetch failed');
    if (mode === 'partial') { const body = JSON.parse(opts.body); const r = await realFetch(url, opts); const j = await r.json(); if (body.query.includes('can-')) { j.notices = j.notices.slice(0, 20); j.totalNoticeCount = 20; } return Response.json(j); }
  }
  return realFetch(url, opts);
};
process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_fakestore_fake';
// A stand-in for the Blob API: the SDK honours VERCEL_BLOB_API_URL.
const http = await import('node:http');
const head = () => ({ url: 'http://localhost:8899/file', downloadUrl: 'http://localhost:8899/file', pathname: 'ted/latest.json', size: 1, uploadedAt: new Date().toISOString(), contentType: 'application/json', contentDisposition: 'inline', cacheControl: 'public' });
await new Promise(ok => http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  log.push(req.method + ' ' + req.url.split('?')[0]);
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'PUT') { stored = JSON.parse(body); return res.end(JSON.stringify(head())); }
  if (req.url.startsWith('/file')) { if (!stored) { res.statusCode = 404; return res.end('{}'); } return res.end(JSON.stringify(stored)); }
  if (!stored) { res.statusCode = 404; return res.end(JSON.stringify({ error: { code: 'not_found', message: 'The requested blob does not exist' } })); }
  res.end(JSON.stringify(head()));
}).listen(8899, ok));
process.env.VERCEL_BLOB_API_URL = 'http://localhost:8899';
const { GET } = await import(new URL('../api/tenders.js', import.meta.url));
const call = async q => { const r = await GET(new Request('http://x/api/tenders' + (q || ''))); return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json() }; };
const check = (name, ok, d = '') => console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (d ? '  ' + d : ''));

mode = 'down'; let r = await call();
check('TED down, nothing stored: 503 not cached', r.status === 503 && r.cache === 'no-store', r.status + ' ' + r.cache);
mode = 'ok'; r = await call();
check('live pull served and stored', r.status === 200 && r.body.meta.source === 'live' && stored?.firms?.length > 100, `${r.body.meta?.firms} firms, stored ${stored?.firms?.length}`);
mode = 'down'; r = await call();
check('TED down: stored copy served', r.status === 200 && r.body.meta.source === 'stored' && r.body.firms.length === stored.firms.length && /TED did not respond/.test(r.body.meta.warning), r.body.meta.warning);
check('stored copy cached briefly', /s-maxage=120/.test(r.cache), r.cache);
const before = stored.meta.fetchedAt;
mode = 'partial'; r = await call();
check('partial TED pull rejected, stored copy kept', r.body.meta.source === 'stored' && stored.meta.fetchedAt === before, r.body.meta.warning);
mode = 'ok'; r = await call('?health=1');
check('health endpoint returns counts only, uncached', r.body.ok && typeof r.body.firms === 'number' && r.cache === 'no-store', JSON.stringify(r.body).slice(0, 120));
console.log('blob calls:', [...new Set(log)].join(', ')); process.exit(0);
