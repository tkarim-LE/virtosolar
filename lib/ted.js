// TED, the EU's public procurement journal. Pulls contract awards and open tenders for a set of CPV
// codes and normalises them into { award, winners } items that lib/firms.js groups by firm.
import { arr, firstLang, norm, toEur, getJSON } from './common.js';

const TED = 'https://api.ted.europa.eu/v3/notices/search';
const PAGE = 250;
const AWARD_FIELDS = ['publication-number', 'publication-date', 'winner-decision-date', 'title-proc', 'title-lot',
  'description-lot', 'result-lot-identifier', 'buyer-name', 'buyer-country', 'buyer-city', 'buyer-legal-type',
  'winner-name', 'winner-identifier', 'winner-country', 'winner-size', 'organisation-name-tenderer',
  'organisation-internet-address-tenderer', 'total-value', 'total-value-cur', 'classification-cpv'];
const TENDER_FIELDS = ['publication-number', 'publication-date', 'title-proc', 'title-lot', 'buyer-name',
  'buyer-country', 'buyer-city', 'buyer-legal-type', 'deadline-receipt-tender-date-lot', 'description-lot'];
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
export const tedUrl = id => `https://ted.europa.eu/en/notice/-/detail/${encodeURIComponent(id)}`;

const page = (query, fields, n) => getJSON(TED, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query, fields, limit: PAGE, page: n }),
}).then(j => { if (!Array.isArray(j.notices)) throw new Error('TED response had no notices list'); return j; });

async function all(query, fields) {
  const first = await page(query, fields, 1);
  const pages = Math.min(Math.ceil((first.totalNoticeCount || 0) / PAGE), 20);
  const rest = await Promise.all(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => page(query, fields, i + 2)));
  const notices = [first, ...rest].flatMap(p => p.notices);
  if (first.totalNoticeCount && notices.length < Math.min(first.totalNoticeCount, pages * PAGE) * 0.95) throw new Error('TED returned a partial result');
  return notices;
}

const titlesOf = n => [firstLang(n['title-proc']), ...arr(firstLang(n['title-lot']))].filter(Boolean).map(String);
// A notice counts when its own words match the profile (CPV codes alone let misfiled notices in).
const relevant = (n, profile) => {
  const titles = titlesOf(n);
  return profile.relevant.test([...titles, ...arr(firstLang(n['description-lot']))].join(' '))
    && !(profile.exclude && profile.exclude.test(titles[0] || ''));
};
const tagsOf = (text, profile) => Object.fromEntries(Object.entries(profile.tags).map(([k, re]) => [k, re.test(text)]));

function winners(n) {
  const raw = arr(firstLang(n['winner-name']));
  const names = [...new Set(raw.map(s => String(s).trim()).filter(Boolean))];
  const aligned = k => (arr(n[k]).length === raw.length ? arr(n[k]) : []);
  const ids = aligned('winner-identifier'), ctry = aligned('winner-country'), size = aligned('winner-size');
  const tn = arr(firstLang(n['organisation-name-tenderer'])), tw = arr(n['organisation-internet-address-tenderer']);
  const site = name => (tn.length === tw.length ? tw[tn.findIndex(x => norm(x) === norm(name))] : undefined);
  return names.map(name => {
    const i = raw.findIndex(x => String(x).trim() === name);
    return { name, regId: ids[i] ? String(ids[i]).replace(/[^0-9A-Za-z]/g, '').toUpperCase() : '', country: ctry[i] || '', size: size[i] || '', website: site(name) || '' };
  });
}

function award(n, profile, fx, today) {
  const titles = titlesOf(n);
  const text = [...titles, ...arr(firstLang(n['description-lot']))].join(' ');
  const lots = new Set(arr(n['result-lot-identifier'])).size || arr(firstLang(n['title-lot'])).length || 1;
  const cur = arr(n['total-value-cur'])[0] || null, val = Number(n['total-value']) || null;
  const pub = String(n['publication-date'] || '').slice(0, 10);
  const won = String(arr(n['winner-decision-date'])[0] || '').slice(0, 10);
  return {
    id: n['publication-number'], url: tedUrl(n['publication-number']), pub,
    won: won && won <= today && won >= '2020' ? won : pub,
    title: String(titles[0] || '').trim().slice(0, 300),
    buyer: String(arr(firstLang(n['buyer-name']))[0] || '').trim(),
    buyerCity: String(arr(firstLang(n['buyer-city']))[0] || '').trim(),
    buyerCountry: arr(n['buyer-country'])[0] || '',
    buyerType: arr(n['buyer-legal-type'])[0] || '',
    lots, value: val, cur, eur: toEur(val, cur, fx),
    // Sizes are read from the title only when the notice has one lot, so they belong to the whole award.
    ...profile.extract(lots === 1 ? titles.join(' ') : String(titles[0] || '')),
    ...tagsOf(text, profile),
  };
}

export async function tedAwards(profile, from, fx, today) {
  const notices = await all(`classification-cpv IN (${profile.cpv}) AND notice-type IN (can-standard can-social can-desg) AND publication-date>=${ymd(from)}`, AWARD_FIELDS);
  return {
    count: notices.length,
    newest: notices.map(n => String(n['publication-date'] || '').slice(0, 10)).sort().pop() || '',
    items: notices.filter(n => relevant(n, profile)).map(n => ({ award: award(n, profile, fx, today), winners: winners(n) })),
  };
}

export async function tedTenders(profile, now, today) {
  const notices = await all(`classification-cpv IN (${profile.cpv}) AND notice-type IN (cn-standard cn-social cn-desg) AND deadline-receipt-tender-date-lot>=${ymd(now)}`, TENDER_FIELDS);
  return notices.filter(n => relevant(n, profile)).map(n => {
    const titles = titlesOf(n);
    const deadlines = arr(n['deadline-receipt-tender-date-lot']).map(d => String(d).slice(0, 10)).filter(d => d >= today).sort();
    return {
      id: n['publication-number'], url: tedUrl(n['publication-number']), pub: String(n['publication-date'] || '').slice(0, 10),
      deadline: deadlines[0] || '', title: String(titles[0] || '').trim().slice(0, 300),
      buyer: String(arr(firstLang(n['buyer-name']))[0] || '').trim(),
      buyerCity: String(arr(firstLang(n['buyer-city']))[0] || '').trim(),
      buyerCountry: arr(n['buyer-country'])[0] || '', buyerType: arr(n['buyer-legal-type'])[0] || '',
      ...profile.extract(String(titles[0] || '')), ...tagsOf(titles.join(' '), profile),
    };
  }).filter(t => t.deadline);
}
