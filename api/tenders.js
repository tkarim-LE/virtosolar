// Live feed for the PV tender tool. Pulls EU public-procurement notices for solar PV work from TED,
// groups contract awards by winning firm, lists PV tenders still open, and keeps the last good pull in
// Vercel Blob so the page never goes blank when TED is slow or down.
//
//   GET /api/tenders           full data set
//   GET /api/tenders?health=1  counts and fetch time only
import { put, head } from '@vercel/blob';

export const maxDuration = 60;

const TED = 'https://api.ted.europa.eu/v3/notices/search';
const PV_CPV = '09331200 45261215 09332000 09331000';
const BLOB_KEY = 'ted/latest.json';
const PAGE = 250;
const AWARD_FIELDS = ['publication-number', 'publication-date', 'winner-decision-date', 'title-proc', 'title-lot',
  'description-lot', 'result-lot-identifier', 'buyer-name', 'buyer-country', 'buyer-city', 'buyer-legal-type',
  'winner-name', 'winner-identifier', 'winner-country', 'winner-size', 'organisation-name-tenderer',
  'organisation-internet-address-tenderer', 'total-value', 'total-value-cur', 'classification-cpv'];
const TENDER_FIELDS = ['publication-number', 'publication-date', 'title-proc', 'title-lot', 'buyer-name',
  'buyer-country', 'buyer-city', 'buyer-legal-type', 'deadline-receipt-tender-date-lot', 'description-lot'];
// Used only when the ECB rate feed doesn't answer. Units of currency per euro, November 2026.
const FALLBACK_FX = { PLN: 4.40, CZK: 24.4, RON: 5.35, CHF: 0.923, BGN: 1.956, HUF: 365, SEK: 11.1, DKK: 7.47, NOK: 10.6, GBP: 0.833 };

// Firm names that read as solar or electrical contractors. Used to attribute a multi-lot award to a winner
// when TED's search results don't say which lot each firm won.
const SOLAR_NAME = /solar|sol[aá]r|photovolt|fotovolt|fotowolt|\bpv\b|\bfve\b|energ|elektr|electr|[eé]lec\b|\bsun|zon|sonne|slnk|slun|soare|ηλιακ|ενεργ/i;
const STORAGE = /magazyn\w* energii|akumulac(?:e|i|í)\b|batter|stockage d.(?:é|e)nergie|stockage d.(?:é|e)lectricit|stromspeicher|batteriespeicher|energiespeicher|\bbess\b|almacenamiento de energ|accumulo|stocare|baterij|hranilnik|zasobnik energii|úložišt|bateri|μπαταρ|αποθήκευσ/i;
// Notices whose titles and lot descriptions never mention PV are misfiled (e.g. lab equipment) and are dropped.
const PV_TEXT = /photovolt|fotovolt|fotowolt|φωτοβολτα|фотоволт|sol[aá]r|solaire|\bfve\b|\bpv\b|zonnepan|zonne.?energie|napelem|sončn|saules|aurinko|solcell|panouri|fotonapon|слънчев|päikese|saulės|ombri[eè]re|\boze\b|odnawialn|obnoviteln|regenerabil|renouvelable|erneuerbar|renovable|renewable|ανανεώσιμ/i;
const CARPORT = /carport|ombri[eè]re|\bwiat[ay]?\b|přístřeš|zadaszen|marquesina|pensilina|überdach/i;

const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const firstLang = m => (m && typeof m === 'object' ? Object.values(m)[0] : m);
const arr = v => (Array.isArray(v) ? v : v == null ? [] : [v]);
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9α-ω]+/g, ' ').trim();

async function tedPage(query, fields, page) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(TED, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, fields, limit: PAGE, page }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`TED ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json.notices)) throw new Error('TED response had no notices list');
      return json;
    } catch (e) {
      if (attempt >= 1) throw e;
      await new Promise(r => setTimeout(r, 800));
    }
  }
}

async function tedAll(query, fields) {
  const first = await tedPage(query, fields, 1);
  const pages = Math.min(Math.ceil((first.totalNoticeCount || 0) / PAGE), 20);
  const rest = await Promise.all(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => tedPage(query, fields, i + 2)));
  const notices = [first, ...rest].flatMap(p => p.notices);
  if (first.totalNoticeCount && notices.length < Math.min(first.totalNoticeCount, pages * PAGE) * 0.95) throw new Error('TED returned a partial result');
  return notices;
}

async function rates() {
  try {
    const res = await fetch('https://api.frankfurter.dev/v1/latest?base=EUR', { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error();
    const j = await res.json();
    return { fx: { ...FALLBACK_FX, ...j.rates }, fxDate: j.date };
  } catch { return { fx: FALLBACK_FX, fxDate: null }; }
}

// "250 kW", "2,1 MWp", "1 000 kWp", "1.200 kWp" in a title. Returns kW (or kWh), or null when no size is stated.
function capacity(text, unit) {
  const re = unit === 'kwh' ? /(\d[\d\u00a0 .,]*\d|\d)\s*(kWh|MWh)\b/i : /(\d[\d\u00a0 .,]*\d|\d)\s*(kWp|kW|MWp|MW)\b/i;
  const m = String(text || '').match(re);
  if (!m) return null;
  let s = m[1].replace(/[\u00a0 ]/g, '');
  if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3},\d{3}$/.test(s) && /^k/i.test(m[2])) s = s.replace(',', ''); // "1,000 kW"
  else if (s.includes(',')) s = s.replace(',', '.');
  else if (/\.\d{3}$/.test(s)) s = s.replace(/\./g, '');
  const v = parseFloat(s) * (/^M/i.test(m[2]) ? 1000 : 1);
  return Number.isFinite(v) && v > 0 && v < 5e6 ? Math.round(v * 10) / 10 : null;
}

function award(n, fx, today) {
  const titles = [firstLang(n['title-proc']), ...arr(firstLang(n['title-lot']))].filter(Boolean);
  const text = [...titles, ...arr(firstLang(n['description-lot']))].join(' ');
  const lots = new Set(arr(n['result-lot-identifier'])).size || arr(firstLang(n['title-lot'])).length || 1;
  const cur = arr(n['total-value-cur'])[0] || null, val = Number(n['total-value']) || null;
  const rate = cur === 'EUR' ? 1 : fx[cur];
  const titleOne = lots === 1 ? titles.join(' ') : String(titles[0] || '');
  const pub = String(n['publication-date'] || '').slice(0, 10);
  const won = String(arr(n['winner-decision-date'])[0] || '').slice(0, 10);
  return {
    id: n['publication-number'], pub,
    won: won && won <= today && won >= '2020' ? won : pub,
    title: String(titles[0] || '').trim().slice(0, 300),
    buyer: String(arr(firstLang(n['buyer-name']))[0] || '').trim(),
    buyerCity: String(arr(firstLang(n['buyer-city']))[0] || '').trim(),
    buyerCountry: arr(n['buyer-country'])[0] || '',
    buyerType: arr(n['buyer-legal-type'])[0] || '',
    lots,
    value: val, cur, eur: val && rate ? Math.round(val / rate) : null,
    kw: capacity(titleOne), kwh: capacity(titleOne, 'kwh'),
    storage: STORAGE.test(text), carport: CARPORT.test(text),
    design: arr(n['classification-cpv']).some(c => String(c).startsWith('713')),
  };
}

function winners(n) {
  const names = [...new Set(arr(firstLang(n['winner-name'])).map(s => String(s).trim()).filter(Boolean))];
  const raw = arr(firstLang(n['winner-name']));
  const aligned = k => (arr(n[k]).length === raw.length ? arr(n[k]) : []);
  const ids = aligned('winner-identifier'), ctry = aligned('winner-country'), size = aligned('winner-size');
  const tn = arr(firstLang(n['organisation-name-tenderer'])), tw = arr(n['organisation-internet-address-tenderer']);
  const site = name => (tn.length === tw.length ? tw[tn.findIndex(x => norm(x) === norm(name))] : undefined);
  return names.map(name => {
    const i = raw.findIndex(x => String(x).trim() === name);
    return { name, regId: ids[i] ? String(ids[i]).replace(/[^0-9A-Za-z]/g, '').toUpperCase() : '', country: ctry[i] || '', size: size[i] || '', website: site(name) || '' };
  });
}

async function build() {
  const now = new Date(), today = now.toISOString().slice(0, 10);
  const from = new Date(now); from.setUTCFullYear(from.getUTCFullYear() - 1);
  const [awardNotices, tenderNotices, { fx, fxDate }] = await Promise.all([
    tedAll(`classification-cpv IN (${PV_CPV}) AND notice-type IN (can-standard can-social can-desg) AND publication-date>=${ymd(from)}`, AWARD_FIELDS),
    tedAll(`classification-cpv IN (${PV_CPV}) AND notice-type IN (cn-standard cn-social cn-desg) AND deadline-receipt-tender-date-lot>=${ymd(now)}`, TENDER_FIELDS),
    rates(),
  ]);

  // One entry per firm. Registration numbers merge name variants; names stand in when TED has no number.
  const firms = new Map(), byName = new Map(), certainKeys = new Set(), pending = [], moved = new Map();
  const pvText = n => PV_TEXT.test([firstLang(n['title-proc']), ...arr(firstLang(n['title-lot'])), ...arr(firstLang(n['description-lot']))].join(' '));
  for (const n of awardNotices.filter(pvText)) {
    const a = award(n, fx, today), ws = winners(n);
    for (const w of ws) {
      const nameKey = 'n:' + w.country + ':' + norm(w.name);
      let key = w.regId ? 'r:' + w.country + ':' + w.regId : byName.get(nameKey) || nameKey;
      if (w.regId) {
        const old = byName.get(nameKey);
        if (old && old.startsWith('n:') && firms.has(old)) { // first seen without a number: fold it in
          const f = firms.get(old); firms.delete(old); moved.set(old, key);
          const g = firms.get(key);
          if (!g) firms.set(key, { ...f, key, regId: w.regId });
          else { g.wins.push(...f.wins); for (const [k, v] of Object.entries(f.names)) g.names[k] = (g.names[k] || 0) + v; }
          if (certainKeys.delete(old)) certainKeys.add(key);
        }
        byName.set(nameKey, key);
      } else if (!byName.has(nameKey)) byName.set(nameKey, key);
      const f = firms.get(key) || { key, names: {}, regId: w.regId, country: w.country, size: '', website: '', wins: [] };
      firms.set(key, f);
      f.names[w.name] = (f.names[w.name] || 0) + 1;
      f.size ||= w.size; f.website ||= w.website; f.country ||= w.country;
      const certain = ws.length === 1 || a.lots === 1;
      if (certain) certainKeys.add(key);
      const win = { ...a, shared: ws.length > 1, basis: certain ? 'certain' : 'pending' };
      if (ws.length > 1) { win.eur = null; win.value = null; } // a shared award's value can't be split
      if (!certain) pending.push([key, win, w.name]);
      f.wins.push(win);
    }
  }
  const current = k => moved.get(k) || k; // only name keys move, and only once, onto a registration key
  for (const [key, win, name] of pending) win.basis = SOLAR_NAME.test(name) || certainKeys.has(current(key)) ? 'likely' : 'unclear';

  // Second pass: the same firm sometimes files under two registration numbers (tax and court IDs) or
  // with and without one. Same country plus same name, minus legal-form words, is the same firm.
  const LEGAL = /(?:\s+(?:sp|z|o|oo|k|ka|s|a|as|sa|spolka|ograniczona|odpowiedzialnoscia|komandytowa|akcyjna|sro|spol|r|gmbh|co|kg|ag|sas|sarl|sasu|srl|sl|slu|d|doo|ead|eood|ae|ike|ee|oe|bv|nv|ltd|limited|inc))+$/;
  const merged = new Map();
  for (const f of firms.values()) {
    const top = Object.keys(f.names)[0];
    const mk = (f.country || f.wins[0].buyerCountry || '') + ':' + (norm(top).replace(LEGAL, '').trim() || norm(top));
    const g = merged.get(mk);
    if (!g) { merged.set(mk, f); continue; }
    g.wins.push(...f.wins);
    for (const [k, v] of Object.entries(f.names)) g.names[k] = (g.names[k] || 0) + v;
    g.regId ||= f.regId; g.size ||= f.size; g.website ||= f.website;
  }
  const out = [];
  for (const f of merged.values()) {
    const seen = new Set(), strength = { certain: 0, likely: 1, unclear: 2 };
    f.wins = f.wins.sort((x, y) => strength[x.basis] - strength[y.basis])
      .filter(w => !seen.has(w.id) && seen.add(w.id)).sort((x, y) => y.won.localeCompare(x.won));
    if (!f.wins.some(w => w.basis !== 'unclear')) continue;
    const name = Object.entries(f.names).sort((x, y) => y[1] - x[1] || x[0].length - y[0].length)[0][0];
    const web = String(f.website || '').trim();
    out.push({
      key: f.key, name, regId: f.regId, country: f.country || f.wins[0].buyerCountry, size: f.size,
      website: !web ? '' : /^https?:\/\//i.test(web) ? web : 'https://' + web,
      wins: f.wins,
    });
  }

  const tenders = tenderNotices.filter(pvText).map(n => {
    const deadlines = arr(n['deadline-receipt-tender-date-lot']).map(d => String(d).slice(0, 10)).filter(d => d >= today).sort();
    const titles = [firstLang(n['title-proc']), ...arr(firstLang(n['title-lot']))].filter(Boolean);
    const text = titles.join(' ');
    return {
      id: n['publication-number'], pub: String(n['publication-date'] || '').slice(0, 10), deadline: deadlines[0] || '',
      title: String(titles[0] || '').trim().slice(0, 300),
      buyer: String(arr(firstLang(n['buyer-name']))[0] || '').trim(),
      buyerCity: String(arr(firstLang(n['buyer-city']))[0] || '').trim(),
      buyerCountry: arr(n['buyer-country'])[0] || '', buyerType: arr(n['buyer-legal-type'])[0] || '',
      kw: capacity(String(titles[0] || '')), storage: STORAGE.test(text), carport: CARPORT.test(text),
    };
  }).filter(t => t.deadline).sort((a, b) => a.deadline.localeCompare(b.deadline));

  const newest = awardNotices.map(n => String(n['publication-date'] || '').slice(0, 10)).sort().pop() || '';
  return {
    meta: { fetchedAt: now.toISOString(), from: from.toISOString().slice(0, 10), to: today, awards: awardNotices.length,
      tenders: tenders.length, firms: out.length, newest, fxDate },
    firms: out, tenders,
  };
}

const blobOn = () => !!process.env.BLOB_READ_WRITE_TOKEN;
async function readStored() {
  if (!blobOn()) return null;
  try {
    const meta = await head(BLOB_KEY);
    const res = await fetch(meta.url + '?v=' + Date.now(), { signal: AbortSignal.timeout(8000) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}
async function writeStored(data) {
  if (!blobOn()) return;
  try {
    await put(BLOB_KEY, JSON.stringify(data), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60 });
  } catch { /* the live response still goes out; the next pull tries again */ }
}

const reply = (body, status, cache) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache },
});

export async function GET(request) {
  const health = new URL(request.url).searchParams.has('health');
  const prev = await readStored();
  // Health reports the stored copy when there is one, so polling it never adds load on TED.
  if (health && prev?.meta) return reply({ ok: true, ...prev.meta, source: 'stored', stored: true }, 200, 'no-store');
  let data = null, warning = '';
  try { data = await build(); } catch (e) { warning = 'TED did not respond (' + e.message + ')'; }
  // Only replace the stored copy with a pull that looks whole: at least half as many awards and nothing older.
  if (data && prev?.meta && (data.meta.awards < prev.meta.awards * 0.5 || data.meta.newest < prev.meta.newest)) {
    warning = `TED returned ${data.meta.awards} awards against ${prev.meta.awards} last time`;
    data = null;
  }
  let source = 'live';
  if (data) {
    // Rewrite the stored copy only when the data changed, or every six hours to keep its fetch time honest.
    const same = prev && JSON.stringify([prev.firms, prev.tenders]) === JSON.stringify([data.firms, data.tenders]);
    if (!same || Date.now() - Date.parse(prev.meta.fetchedAt) > 6 * 3600e3) await writeStored(data);
  } else if (prev) { data = prev; source = 'stored'; }
  else return reply({ ok: false, error: warning || 'No data yet' }, 503, 'no-store');
  data.meta = { ...data.meta, source, warning: warning || undefined, stored: blobOn() };
  const cache = source === 'live'
    ? 'public, max-age=0, s-maxage=900, stale-while-revalidate=86400'
    : 'public, max-age=0, s-maxage=120, stale-while-revalidate=86400';
  return reply(health ? { ok: true, ...data.meta } : data, 200, health ? 'no-store' : cache);
}
