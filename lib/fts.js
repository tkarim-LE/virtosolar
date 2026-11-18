// UK Find a Tender (OCDS). The API has no keyword or CPV filter, so a year of awards can't be pulled on
// each request. Instead the matching awards live in a small state file in Blob, and each call reads only
// the releases published since the last one, within a time budget. The first run backfills 12 months
// over a few calls; after that each call reads a page or two.
import { toEur } from './common.js';

const FTS = 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages';
const DAY = 864e5;

const buyerType = p => {
  const t = (p?.details?.classifications || []).find(c => c.scheme === 'TED_CA_TYPE')?.id || '';
  return /REGIONAL|LOCAL/.test(t) ? 'la' : /MINISTRY|NATIONAL|CENTRAL/.test(t) ? 'cga' : t ? 'body-pl' : '';
};

function item(r, profile, fx) {
  const t = r.tender || {};
  const title = String(t.title || '').trim(), text = title + ' ' + String(t.description || '');
  if (!profile.relevant.test(text) || (profile.exclude && profile.exclude.test(title))) return null;
  const parties = new Map((r.parties || []).map(p => [p.id, p]));
  const buyer = (r.parties || []).find(p => (p.roles || []).includes('buyer')) || {};
  const supplierIds = [...new Set((r.awards || []).filter(a => a.status !== 'cancelled').flatMap(a => (a.suppliers || []).map(s => s.id)))];
  const winners = supplierIds.map(id => parties.get(id)).filter(Boolean).map(p => ({
    name: String(p.name || '').trim(),
    regId: p.identifier?.scheme === 'GB-COH' ? String(p.identifier.id || '').toUpperCase() : '',
    country: !p.address?.countryName || /united kingdom|^uk$|great britain/i.test(p.address.countryName) ? 'GBR' : '',
    size: p.details?.scale === 'sme' ? 'sme' : p.details?.scale === 'large' ? 'large' : '',
    website: p.details?.url || '',
  })).filter(w => w.name);
  if (!winners.length) return null;
  const contracts = r.contracts || [];
  const val = contracts.reduce((s, c) => s + (Number(c.value?.amount) || 0), 0)
    || (r.awards || []).reduce((s, a) => s + (Number(a.value?.amount) || 0), 0) || null;
  const cur = contracts[0]?.value?.currency || (r.awards || [])[0]?.value?.currency || 'GBP';
  const signed = String(contracts.find(c => c.dateSigned)?.dateSigned || (r.awards || []).find(a => a.date)?.date || '').slice(0, 10);
  const pub = String(r.date || '').slice(0, 10);
  const lots = (t.lots || []).length || 1;
  return {
    ocid: r.ocid,
    award: {
      id: r.id, url: `https://www.find-tender.service.gov.uk/Notice/${encodeURIComponent(r.id)}`, pub,
      won: signed && signed <= pub ? signed : pub, title: title.slice(0, 300),
      buyer: String(buyer.name || '').trim(), buyerCity: String(buyer.address?.locality || '').trim(),
      buyerCountry: 'GBR', buyerType: buyerType(buyer),
      lots, value: val, cur, eur: toEur(val, cur, fx),
      ...profile.extract(lots === 1 ? text : title),
      ...Object.fromEntries(Object.entries(profile.tags).map(([k, re]) => [k, re.test(text)])),
    },
    winners,
  };
}

// Advances the sync as far as the time budget allows and returns the new state.
export async function syncFTS(state, profile, fx, budgetMs) {
  const started = Date.now(), now = new Date();
  const s = state?.syncedTo ? { ...state, items: [...state.items] } : { items: [], syncedTo: new Date(now - 365 * DAY).toISOString().slice(0, 19), scanned: 0 };
  if (!s.next) {
    s.windowEnd = now.toISOString().slice(0, 19);
    s.next = `${FTS}?stages=award&limit=100&updatedFrom=${s.syncedTo}&updatedTo=${s.windowEnd}`;
  }
  const byOcid = new Map(s.items.map(x => [x.ocid, x]));
  delete s.error;
  while (s.next && Date.now() - started < budgetMs) {
    // Paced to stay under the API's rate limit. Any failure stops this call but keeps the progress made.
    if (s.scanned) await new Promise(r => setTimeout(r, 400));
    let page;
    try {
      const res = await fetch(s.next, { signal: AbortSignal.timeout(Math.max(5000, budgetMs - (Date.now() - started))) });
      if (!res.ok) throw new Error(res.status === 429 ? 'Find a Tender rate limit, resumes next call' : `Find a Tender ${res.status}`);
      page = await res.json();
    } catch (e) { s.error = e.message; break; }
    for (const r of page.releases || []) {
      s.scanned++;
      const it = item(r, profile, fx);
      if (it && (!byOcid.has(it.ocid) || byOcid.get(it.ocid).award.pub <= it.award.pub)) byOcid.set(it.ocid, it); // later release wins
    }
    s.next = page.links?.next || null;
    if (!s.next) { s.syncedTo = s.windowEnd; delete s.windowEnd; }
  }
  const cutoff = new Date(now - 365 * DAY).toISOString().slice(0, 10);
  s.items = [...byOcid.values()].filter(x => x.award.pub >= cutoff); // by publication: contracts are often signed months earlier
  s.done = !s.next;
  s.checkedAt = now.toISOString();
  return s;
}
