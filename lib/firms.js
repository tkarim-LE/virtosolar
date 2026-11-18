// Groups { award, winners } items from any source into one record per winning firm.
//
// Attribution: an award is "certain" for a firm when the notice has one winner or one lot. On multi-lot
// notices the sources don't say which lot each firm won, so it is "likely" when the firm's name reads as a
// trade the profile cares about (or the firm is a certain winner elsewhere), and "unclear" otherwise.
// Unclear awards stay on the firm's record but never put a firm on the list by themselves.
import { norm } from './common.js';

// Legal-form words at the end of a name ("Sp. z o.o.", "s.r.o.", "GmbH", "Ltd") don't distinguish firms.
const LEGAL = /(?:\s+(?:sp|z|o|oo|k|ka|s|a|as|sa|spolka|ograniczona|odpowiedzialnoscia|komandytowa|akcyjna|sro|spol|r|gmbh|co|kg|ag|sas|sarl|sasu|srl|sl|slu|d|doo|ead|eood|ae|ike|ee|oe|bv|nv|ltd|limited|inc|plc|llp|aps|ab|oy|asa|hf)\b)+$/;
const strength = { certain: 0, likely: 1, unclear: 2 };

export function groupFirms(items, profile) {
  const firms = new Map(), byName = new Map(), certainKeys = new Set(), pending = [], moved = new Map();
  for (const { award: a, winners: ws } of items) {
    for (const w of ws) {
      const nameKey = 'n:' + w.country + ':' + norm(w.name);
      const key = w.regId ? 'r:' + w.country + ':' + w.regId : byName.get(nameKey) || nameKey;
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
  for (const [key, win, name] of pending) win.basis = profile.tradeName.test(name) || certainKeys.has(current(key)) ? 'likely' : 'unclear';

  // The same firm sometimes files under two registration numbers (tax and court IDs) or with and without
  // one. Same country plus the same name, minus trailing legal-form words, is the same firm.
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
    const seen = new Set();
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
  return out;
}
