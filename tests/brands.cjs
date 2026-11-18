// Run against a served Installer copy: node tests/brands.cjs http://localhost:8788/
// EPREL needs an API key, so this injects brand records shaped like lib/eprel.js output and checks the
// brands section, its drawer and its drafts, including a brand with no website or market list.
const { chromium } = require('playwright');
const url = process.argv[2];
let failed = 0; const check = (n, ok, d = '') => { if (!ok) failed++; console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (d ? '  ' + d : '')); };
const model = (id, date, markets, extra = {}) => ({ id, url: `https://eprel.ec.europa.eu/screen/product/spaceheaters/${id}`, brand: 'Daikin', org: 'Daikin Europe N.V.',
  website: 'https://www.daikin.eu', orgCountry: 'BE', model: 'EPRA10EAV3 ' + id, date, first: date, energyClass: 'APP', markets, ...extra });
const brands = [
  { key: 'b:daikin', brand: 'Daikin', org: 'Daikin Europe N.V.', website: 'https://www.daikin.eu', country: 'BE',
    models: [model('2100001', '2026-10-02', ['NO', 'SE', 'DK', 'FI', 'DE']), model('2100002', '2026-03-15', 'ALL')] },
  { key: 'b:nordvarme', brand: 'NORDVARME', org: 'NORDVARME', website: '', country: '', models: [model('2100003', '2026-08-20', 'ALL', { brand: 'NORDVARME', org: 'NORDVARME', website: '', energyClass: '' })] },
];
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; p.on('pageerror', e => errors.push(String(e)));
  await p.route('**/api/tenders', async route => {
    const r = await route.fetch(); const d = await r.json();
    d.brands = brands; d.meta.eprel = { models: 3, brands: 2, since: '2025-11-18' };
    route.fulfill({ response: r, json: d });
  });
  await p.goto(url, { waitUntil: 'networkidle' }); await p.waitForSelector('.b-row');
  check('brands section renders', (await p.$$('.b-row')).length === 2);
  check('stat counts brands', /heat pump brands/.test(await p.textContent('#stats')));
  check('footer names EPREL', /EPREL/.test(await p.textContent('#source')));
  check('all-caps brand recased', (await p.textContent('#extra')).includes('Nordvarme'));
  await p.click('.b-row >> nth=0'); await p.waitForTimeout(300);
  const body = await p.inputValue('#d-body'), subject = await p.inputValue('#d-subject');
  check('brand draft names the brand and count', /Daikin put 2 new heat pump models on the EU market since March 2026/.test(body), body.split('\n')[2]);
  check('brand draft lists markets', /listed for sale in Norway, Sweden, Denmark and Finland and more/.test(body));
  check('brand draft has no leftovers or em dashes', !/undefined|NaN|null|\{\{|—/.test(subject + body) && [...body.matchAll(/\{[^}]+\}/g)].every(m => /^\{(first name|your name)\}$/.test(m[0])));
  check('brand drawer links', (await p.$$eval('#d-links a', a => a.map(x => x.textContent))).join(',') === 'Website,Find them on LinkedIn,Latest EPREL record');
  check('energy class shown as A++', (await p.textContent('#d-sections')).includes('class A++'));
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  check('focus returns to the brand row', await p.evaluate(() => document.activeElement?.dataset?.id === 'b:daikin'));
  await p.click('.b-row >> nth=1'); await p.waitForTimeout(300);
  const body2 = await p.inputValue('#d-body');
  check('single-model brand reads naturally', /NORDVARME|Nordvarme put a new heat pump on the EU market in August 2026\./.test(body2), body2.split('\n')[2]);
  check('no market line when sold everywhere', !/listed for sale/.test(body2));
  check('no website link without a website', !(await p.$$eval('#d-links a', a => a.map(x => x.textContent))).includes('Website'));
  check('no page errors', errors.length === 0, errors.join(' | '));
  await p.screenshot({ path: process.argv[3] || 'brand-drawer.png' });
  await b.close(); console.log(failed ? failed + ' failed' : 'all brand checks passed'); process.exit(failed ? 1 : 0);
})();
