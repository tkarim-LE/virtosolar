// UK Contracts Finder. Unlike Find a Tender it has keyword search, so awards matching the profile's
// keywords are pulled live on each request and normalised into the same { award, winners } items.
import { toEur } from './common.js';

const SEARCH = 'https://www.contractsfinder.service.gov.uk/api/rest/2/search_notices/json';

// One search returns at most 100 notices and the API has no paging, so a full result splits the date
// range in half and searches each half, down to a single day.
async function search(keyword, from, to) {
  const res = await fetch(SEARCH, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ searchCriteria: { keyword, statuses: ['Awarded'], publishedFrom: from + 'T00:00:00', publishedTo: to + 'T23:59:59' }, size: 100 }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`Contracts Finder ${res.status}`);
  const j = await res.json(), list = j.noticeList || [];
  if ((j.hitCount || 0) <= list.length || from >= to) return list;
  const mid = new Date((Date.parse(from) + Date.parse(to)) / 2).toISOString().slice(0, 10);
  const next = new Date(Date.parse(mid) + 864e5).toISOString().slice(0, 10);
  const halves = await Promise.all([search(keyword, from, mid), search(keyword, next, to)]);
  return halves.flat();
}

const decode = s => String(s || '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim();

export async function cfAwards(profile, keywords, from, to, fx) {
  const pages = await Promise.all(keywords.map(k => search(k, from, to)));
  const seen = new Set(), items = [];
  for (const n of pages.flat()) {
    const i = n.item || n;
    if (!i.id || seen.has(i.id)) continue;
    seen.add(i.id);
    const title = decode(i.title), text = title + ' ' + decode(i.description);
    if (!profile.relevant.test(text) || (profile.exclude && profile.exclude.test(title))) continue;
    const names = [...new Set(decode(i.awardedSupplier).split(/\s*,\s*(?![^()]*\))/).map(s => s.trim()).filter(s => s.length > 1))];
    if (!names.length) continue;
    const pub = String(i.publishedDate || '').slice(0, 10), awarded = String(i.awardedDate || '').slice(0, 10);
    const val = Number(i.awardedValue) > 1 ? Number(i.awardedValue) : null; // frameworks often publish £0 or £1
    items.push({
      award: {
        id: i.noticeIdentifier || i.id, url: `https://www.contractsfinder.service.gov.uk/Notice/${encodeURIComponent(i.id)}`, pub,
        won: awarded && awarded <= pub ? awarded : pub, title: title.slice(0, 300),
        buyer: decode(i.organisationName), buyerCity: /any region/i.test(i.regionText || '') ? '' : decode(i.regionText),
        // A multi-supplier award is treated like a multi-lot one: no single firm is certain.
        buyerCountry: 'GBR', buyerType: '', lots: names.length, value: val, cur: 'GBP', eur: toEur(val, 'GBP', fx),
        ...profile.extract(text),
        ...Object.fromEntries(Object.entries(profile.tags).map(([k, re]) => [k, re.test(text)])),
      },
      // Contracts Finder only says whether the winner was an SME when there is one winner.
      winners: names.map(name => ({ name, regId: '', country: 'GBR', size: names.length === 1 && i.awardedToSme ? 'sme' : '', website: '' })),
    });
  }
  return items;
}
