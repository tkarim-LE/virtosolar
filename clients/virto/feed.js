// Virto Solar: European firms that just won a public contract to build solar PV, plus PV tenders still open.
import { rates, isoDay } from '../../lib/common.js';
import { tedAwards, tedTenders } from '../../lib/ted.js';
import { groupFirms } from '../../lib/firms.js';

// "250 kW", "2,1 MWp", "1 000 kWp", "1.200 kWp", "1,000 kW" in a title. Returns kW (or kWh), or null.
function capacity(text, unit) {
  const re = unit === 'kwh' ? /(\d[\d  .,]*\d|\d)\s*(kWh|MWh)\b/i : /(\d[\d  .,]*\d|\d)\s*(kWp|kW|MWp|MW)\b/i;
  const m = String(text || '').match(re);
  if (!m) return null;
  let s = m[1].replace(/[  ]/g, '');
  if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3},\d{3}$/.test(s) && /^k/i.test(m[2])) s = s.replace(',', '');
  else if (s.includes(',')) s = s.replace(',', '.');
  else if (/\.\d{3}$/.test(s)) s = s.replace(/\./g, '');
  const v = parseFloat(s) * (/^M/i.test(m[2]) ? 1000 : 1);
  return Number.isFinite(v) && v > 0 && v < 5e6 ? Math.round(v * 10) / 10 : null;
}

export const profile = {
  cpv: '09331200 45261215 09332000 09331000',
  // Titles and lot descriptions must mention PV or renewables; CPV codes alone let lab equipment in.
  relevant: /photovolt|fotovolt|fotowolt|φωτοβολτα|фотоволт|sol[aá]r|solaire|\bfve\b|\bpv\b|zonnepan|zonne.?energie|napelem|sončn|saules|aurinko|solcell|panouri|fotonapon|слънчев|päikese|saulės|ombri[eè]re|\boze\b|odnawialn|obnoviteln|regenerabil|renouvelable|erneuerbar|renovable|renewable|ανανεώσιμ/i,
  tags: {
    storage: /magazyn\w* energii|akumulac(?:e|i|í)\b|batter|stockage d.(?:é|e)nergie|stockage d.(?:é|e)lectricit|stromspeicher|batteriespeicher|energiespeicher|\bbess\b|almacenamiento de energ|accumulo|stocare|baterij|hranilnik|zasobnik energii|úložišt|bateri|μπαταρ|αποθήκευσ/i,
    carport: /carport|ombri[eè]re|\bwiat[ay]?\b|přístřeš|zadaszen|marquesina|pensilina|überdach/i,
  },
  extract: text => ({ kw: capacity(text), kwh: capacity(text, 'kwh') }),
  // Firm names that read as solar or electrical contractors.
  tradeName: /solar|sol[aá]r|photovolt|fotovolt|fotowolt|\bpv\b|\bfve\b|energ|elektr|electr|[eé]lec\b|\bsun|zon|sonne|slnk|slun|soare|ηλιακ|ενεργ/i,
};

export default {
  name: 'virto',
  async build() {
    const now = new Date(), today = isoDay(now);
    const from = new Date(now); from.setUTCFullYear(from.getUTCFullYear() - 1);
    const { fx, fxDate } = await rates();
    const [awards, tenders] = await Promise.all([tedAwards(profile, from, fx, today), tedTenders(profile, now, today)]);
    const firms = groupFirms(awards.items, profile);
    return {
      meta: { fetchedAt: now.toISOString(), from: isoDay(from), to: today, awards: awards.count, tenders: tenders.length,
        firms: firms.length, newest: awards.newest, fxDate },
      firms, tenders: tenders.sort((a, b) => a.deadline.localeCompare(b.deadline)),
    };
  },
};
