// EPREL, the EU's energy-label product registry. Every heat pump sold in the EU is registered here with
// the date it went on the market and the countries it is sold in. Listing products needs an API key
// (free, from eprel.ec.europa.eu), set as EPREL_API_KEY; without one this returns null.
import { getJSON, norm, isoDay } from './common.js';

const API = 'https://eprel.ec.europa.eu/api/products';
const GROUP = 'spaceheaters';
const day = a => (Array.isArray(a) && a.length === 3 ? a.map((n, i) => String(n).padStart(i ? 2 : 4, '0')).join('-') : '');
const isHeatPump = p => /HEAT_PUMP/.test(String(p.spaceHeaterType || p.heaterType || p.category || ''));

// Heat pump models put on the EU market since `since`, grouped by brand.
export async function eprelBrands(key, since) {
  if (!key) return null;
  const sinceTs = Math.floor(since / 1000), models = new Map();
  let unsorted = false;
  for (let pageNo = 1; pageNo <= 40; pageNo++) {
    const page = await getJSON(`${API}/${GROUP}?_page=${pageNo}&_limit=100&sort0=onMarketStartDateTS&order0=DESC`, { headers: { 'x-api-key': key } });
    const hits = Array.isArray(page) ? page : page.hits || [];
    for (const p of hits) {
      const id = String(p.eprelRegistrationNumber || '');
      if (!id || models.has(id) || !isHeatPump(p) || p.status === 'DELETED' || (p.onMarketStartDateTS || 0) < sinceTs) continue;
      const org = p.organisation || {};
      const markets = (p.modelAvailabilityInEUEEACountries || []).map(c => (typeof c === 'string' ? c : c.code || c.countryCode)).filter(Boolean);
      models.set(id, {
        id, url: `https://eprel.ec.europa.eu/screen/product/${GROUP}/${encodeURIComponent(id)}`,
        brand: String(p.supplierOrTrademark || org.organisationName || '').trim(),
        org: String(org.organisationName || '').trim(), website: String(org.website || '').trim(),
        orgCountry: p.contactDetails?.country || '',
        model: String(p.modelIdentifier || '').trim().slice(0, 120),
        date: day(p.onMarketStartDate), first: day(p.onMarketFirstStartDate) || day(p.onMarketStartDate),
        energyClass: p.energyClass || '', markets: p.availabilityInEUEEACountries === 'ALL' || !markets.length ? 'ALL' : markets,
      });
    }
    const last = hits[hits.length - 1], ts = hits.map(p => p.onMarketStartDateTS || 0);
    // If the API stops honouring the sort, paging can't find an end; one page is better than forty.
    const sorted = ts.every((t, i) => !i || t <= ts[i - 1]);
    if (!hits.length || !sorted || (last.onMarketStartDateTS || 0) < sinceTs) { unsorted ||= !sorted && hits.length > 1; break; }
  }
  const brands = new Map();
  for (const m of models.values()) {
    if (!m.brand || !m.date) continue;
    const k = norm(m.brand);
    const b = brands.get(k) || { key: 'b:' + k, brand: m.brand, org: m.org, website: m.website, country: m.orgCountry, models: [] };
    b.website ||= m.website;
    b.models.push(m);
    brands.set(k, b);
  }
  const list = [...brands.values()].map(b => ({ ...b, models: b.models.sort((x, y) => y.date.localeCompare(x.date)) }));
  return { brands: list, models: models.size, since: isoDay(new Date(since)), unsorted };
}
