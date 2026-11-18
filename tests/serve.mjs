// Run: TOOL=installer node tests/serve.mjs 8787
// Local stand-in for Vercel: builds dist/ for TOOL, serves it, and routes /api/tenders to the function.
// The function's result is cached for the life of the server, like the edge cache.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { execSync } from 'node:child_process';
const root = path.resolve(new URL('..', import.meta.url).pathname), port = +process.argv[2] || 8787;
execSync('node build.mjs', { cwd: root, stdio: 'inherit' });
const { GET } = await import(path.join(root, 'api/tenders.js'));
const cache = {};
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/tenders')) {
    const k = req.url;
    if (!cache[k]) { const r = await GET(new Request('http://x' + req.url)); cache[k] = { status: r.status, body: await r.text() }; }
    res.writeHead(cache[k].status, { 'Content-Type': 'application/json' }); return res.end(cache[k].body);
  }
  const f = path.join(root, 'dist', req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!f.startsWith(path.join(root, 'dist')) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
}).listen(port, () => console.log('listening', port));
