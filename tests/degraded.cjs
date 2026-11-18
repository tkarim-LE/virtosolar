// Run against a served copy: node tests/degraded.cjs http://localhost:8787/
// Blanks every optional field in the feed and checks the page and drafts claim nothing the data lacks;
// then makes the feed fail and checks the error state.
const { chromium } = require('playwright');
const url = process.argv[2];
let failed = 0; const check = (n, ok, d = '') => { if (!ok) failed++; console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (d ? '  ' + d : '')); };
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  const errors = []; p.on('pageerror', e => errors.push(String(e)));
  await p.route('**/api/tenders', async route => {
    const r = await route.fetch(); const d = await r.json();
    d.firms.forEach(f => { f.website = ''; f.size = ''; f.regId = ''; f.wins.forEach(w => Object.assign(w, { eur: null, value: null, kw: null, kwh: null, points: null, pointsUnit: null, storage: false, carport: false, ev: false, heatpump: false, buyerCity: '', buyerType: '' })); });
    (d.brands || []).forEach(b => { b.website = ''; b.country = ''; b.models.forEach(m => Object.assign(m, { energyClass: '', markets: 'ALL' })); });
    d.tenders.forEach(t => Object.assign(t, { kw: null, points: null, buyerCity: '', storage: false, carport: false, ev: false, heatpump: false }));
    d.firms[0].wins.forEach(w => { w.buyer = ''; });
    route.fulfill({ response: r, json: d });
  });
  await p.goto(url, { waitUntil: 'networkidle' }); await p.waitForSelector('.row');
  const drafts = await p.evaluate(() => window.__tool.records.map(f => window.__tool.message(f)));
  check('no capacity, storage or value claims in drafts', drafts.every(m => !/ kW| MW|kWh|MWh|storage|€|\d (charge points|sites)|includes (EV|heat)/.test(m.body)));
  check('blank buyer handled in draft', drafts.every(m => !/with {2}|with \.|with in /.test(m.subject + m.body)));
  check('no leftovers', drafts.every(m => !/undefined|NaN|null/.test(m.subject + m.body)));
  await p.click('.row >> nth=0'); await p.waitForTimeout(300);
  const links = await p.$$eval('#d-links a', a => a.map(x => x.textContent));
  check('no website link without a website', !links.includes('Website'), links.join(', '));
  const facts = await p.textContent('#d-facts');
  check('value shows Not published, never €0', /Not published/.test(facts) && !/€0/.test(facts), facts.replace(/\s+/g, ' '));
  check('no scope tags without data', (await p.$$('#drawer .tag')).length === 0);
  const sub = await p.textContent('#d-sub');
  check('drawer subtitle has no dangling separators', !/^ ·| · $| · {2}· /.test(sub), JSON.stringify(sub));
  check('rows never show €0', !(await p.textContent('#rows')).includes('€0'));
  check('no page errors', errors.length === 0, errors.join(' | '));
  const p2 = await b.newPage();
  await p2.route('**/api/tenders', r => r.fulfill({ status: 503, body: '{"ok":false}' }));
  await p2.goto(url); await p2.waitForTimeout(1000);
  check('feed failure shows a retry message', /did not load/.test(await p2.textContent('#rows')));
  await b.close(); console.log(failed ? failed + ' failed' : 'all degraded checks passed'); process.exit(failed ? 1 : 0);
})();
