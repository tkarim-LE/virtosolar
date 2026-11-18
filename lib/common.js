// Small helpers shared by every data source.
export const arr = v => (Array.isArray(v) ? v : v == null ? [] : [v]);
// TED returns multilingual fields as { lang: value }; the first language is the notice's own.
export const firstLang = m => (m && typeof m === 'object' && !Array.isArray(m) ? Object.values(m)[0] : m);
export const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9α-ω]+/g, ' ').trim();
export const isoDay = d => d.toISOString().slice(0, 10);

// Used only when the ECB rate feed doesn't answer. Units of currency per euro, November 2026.
const FALLBACK_FX = { PLN: 4.40, CZK: 24.4, RON: 5.35, CHF: 0.923, BGN: 1.956, HUF: 365, SEK: 11.1, DKK: 7.47, NOK: 10.6, GBP: 0.833 };
export async function rates() {
  try {
    const res = await fetch('https://api.frankfurter.dev/v1/latest?base=EUR', { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error();
    const j = await res.json();
    return { fx: { ...FALLBACK_FX, ...j.rates }, fxDate: j.date };
  } catch { return { fx: FALLBACK_FX, fxDate: null }; }
}
export const toEur = (val, cur, fx) => {
  const rate = cur === 'EUR' ? 1 : fx[cur];
  return val && rate ? Math.round(val / rate) : null;
};

// GET a JSON URL with a timeout and one retry.
export async function getJSON(url, init = {}, timeout = 20000) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
      if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt >= 1) throw e;
      await new Promise(r => setTimeout(r, 800));
    }
  }
}
