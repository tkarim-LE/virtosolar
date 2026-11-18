// Assembles the static site for one client into dist/: its page plus the shared script and styles.
// The Vercel project's TOOL env var picks the client (virto, installer); the function reads the same var.
import fs from 'node:fs';
// Locally it defaults to virto; on Vercel a missing TOOL is an error, so a project can't serve the wrong client.
if (process.env.VERCEL && !process.env.TOOL) throw new Error('Set the TOOL env var on this Vercel project');
const tool = process.env.TOOL || 'virto';
const src = `clients/${tool}/index.html`;
if (!fs.existsSync(src)) throw new Error(`No client "${tool}"`);
fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist');
for (const [from, to] of [[src, 'index.html'], ['shared/tool.js', 'tool.js'], ['shared/tool.css', 'tool.css']]) fs.copyFileSync(from, `dist/${to}`);
console.log(`Built ${tool} into dist/`);
