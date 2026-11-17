// Run: node tests/serve.mjs . 8787
// Local stand-in for Vercel: serves the site folder and routes /api/tenders to the function.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const dir = process.argv[2], port = +process.argv[3] || 8787;
const { GET } = await import(path.resolve(dir, 'api/tenders.js'));
let cache = null;
http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/tenders')) {
    const k = req.url.includes('health') ? 'h' : 'd';
    if (!cache?.[k]) { const r = await GET(new Request('http://x' + req.url)); (cache ||= {})[k] = { status: r.status, body: await r.text() }; }
    res.writeHead(cache[k].status, { 'Content-Type': 'application/json' }); return res.end(cache[k].body);
  }
  const f = path.join(dir, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' }); res.end(fs.readFileSync(f));
}).listen(port, () => console.log('listening', port));
