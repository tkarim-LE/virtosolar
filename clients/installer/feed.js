// Installer.com: utilities, charge point operators and contractors that just won a public contract to roll
// out EV chargers or heat pumps (TED for the EU/EEA; Contracts Finder and Find a Tender for the UK), plus heat pump brands that
// just put new models on the EU market (EPREL, once an API key is set).
import { rates, isoDay, norm } from '../../lib/common.js';
import { tedAwards, tedTenders } from '../../lib/ted.js';
import { syncFTS } from '../../lib/fts.js';
import { cfAwards } from '../../lib/contractsfinder.js';
import { eprelBrands } from '../../lib/eprel.js';
import { groupFirms } from '../../lib/firms.js';

const EV = /\blad(e|ning|estation|einfra|esäul|epunkt|estander|eplass)|charg(e|ing) ?(point|station|infrastructure|hub)|chargepoint|recharg|borne(s)? de recharge|wallbox|elbil|nabíj|ładow|laadpa|laadpunt|laadinfra|ricarica|recarga|electric vehicle|e-?mobil|elektromobil|\bEVCP|\bEV charg|\bLEVI\b|on-?street charg/i;
const HP = /heat ?pump|varmepump|värmepump|lämpöpump|pomp\w* ciepła|tepeln\w* čerpad|wärmepumpe|warmtepomp|pompe à chaleur|pompa di calore|bomba de calor|toplotn\w* črpalk|šilumos siurbl|hőszivattyú|αντλί\w* θερμότητας/i;

// "120 charge points", "45 Ladepunkte", "30 sites" in a title: the size of the rollout.
const POINTS = /(\d{1,3}(?:[ ,.]\d{3})?|\d+)\s*(?:x\s*)?(?:new\s+|public\s+|on-?street\s+)?(charge ?points?|charging points?|chargers|charging stations?|ladepunkte?r?|ladesäulen|ladestationen|ladestandere|bornes|punkt\w* ładowania|stacj\w* ładowania|nabíjecí\w* stanic|laadpalen|laadpunten|sites|locations|lokationer|standorte)\b/i;
const points = text => {
  const m = String(text || '').match(POINTS);
  const n = m ? parseInt(m[1].replace(/[ ,.]/g, ''), 10) : NaN;
  return { points: n > 1 && n < 100000 ? n : null, pointsUnit: n > 1 && n < 100000 ? (/site|location|lokation|standort/i.test(m[2]) ? 'sites' : 'charge points') : null };
};

export const profile = {
  cpv: '31681500 31158100 31158000 42511110',
  relevant: new RegExp(EV.source + '|' + HP.source, 'i'),
  // Not installation rollouts: e-bus depots and trams, battery chargers for tools or the army, vehicle
  // purchases, charging software, and training or research contracts.
  exclude: /\bbus|autobus|tabor|elbus|trolej|tram|straßenbahn|gleichrichter|unterwerk|batterielade|erhaltungslad|gabelstapler|forklift|stapler|werkzeug|akku|fahrrad|e-?bike|rower|dron|military|wojsk|bundeswehr|baainbw|suministro de veh|adquisici[oó]n de veh|pojazd|samochod|fahrzeugbeschaffung|beschaffung von (e-)?fahrzeug|leasing|software|back-?office|gestion des utilisateurs|pracowni|laborator|szkoleni|training|upskill|research|qualitative|strategy|consultan|feasibility|studie\b/i,
  tags: { ev: EV, heatpump: HP },
  extract: points,
  // Firm names that read as electrical, energy, charging or heating contractors.
  tradeName: /energ|elektr|electr|[eé]lec\b|charg|lade|power|volt|mobil|heat|varme|värme|wärme|vvs|hvac|install|instal|plumb|therm|klima|ener|e-?on|\bev\b/i,
};

const CF_KEYWORDS = ['"electric vehicle"', '"charge point"', 'chargepoint', '"charging point"', '"EV charging"', '"heat pump"', '"heat pumps"'];
// The same UK contract can be published on both Find a Tender and Contracts Finder; keep one.
const ukKey = ({ award: a }) => norm(a.buyer) + '|' + norm(a.title).slice(0, 60);

const UK_KEY = 'installer/uk.json';
// A lease in the state file keeps two syncs (a page load and a ?sync=1 call) from running at once and
// overwriting each other's progress; a call that finds the lease held returns the state as it is.
const ukSync = async (store, fx, budgetMs) => {
  const prev = await store.read(UK_KEY);
  if (prev?.leaseUntil > Date.now()) return prev;
  if (store.on()) await store.write(UK_KEY, { ...(prev || {}), items: prev?.items || [], leaseUntil: Date.now() + budgetMs + 15000 });
  const next = await syncFTS(prev, profile, fx, budgetMs);
  delete next.leaseUntil;
  if (store.on()) await store.write(UK_KEY, next);
  return next;
};

export default {
  name: 'installer',
  async build({ store }) {
    const now = new Date(), today = isoDay(now);
    const from = new Date(now); from.setUTCFullYear(from.getUTCFullYear() - 1);
    const { fx, fxDate } = await rates();
    // The UK sync is best-effort here: a short budget keeps the page fast, and a failure keeps the last state.
    const [awards, tenders, cf, uk, eprel] = await Promise.all([
      tedAwards(profile, from, fx, today),
      tedTenders(profile, now, today),
      cfAwards(profile, CF_KEYWORDS, isoDay(from), today, fx).catch(e => ({ error: e.message })), // best-effort, like the UK sync
      ukSync(store, fx, 8000).catch(() => store.read(UK_KEY)),
      eprelBrands(process.env.EPREL_API_KEY, +from).catch(e => ({ error: e.message })),
    ]);
    const cfItems = Array.isArray(cf) ? cf : [];
    const ukItems = [...new Map([...cfItems, ...(uk?.items || [])].map(x => [ukKey(x), x])).values()];
    const firms = groupFirms([...awards.items, ...ukItems], profile);
    return {
      meta: { fetchedAt: now.toISOString(), from: isoDay(from), to: today, awards: awards.count, tenders: tenders.length,
        firms: firms.length, newest: awards.newest, fxDate,
        uk: { items: ukItems.length, contractsFinder: Array.isArray(cf) ? cf.length : cf,  findATender: uk ? { items: uk.items.length, syncedTo: uk.syncedTo, done: !!uk.done, scanned: uk.scanned } : null },
        eprel: !eprel ? null : eprel.error ? { error: eprel.error } : { models: eprel.models, brands: eprel.brands.length, since: eprel.since, unsorted: eprel.unsorted } },
      firms, tenders: tenders.sort((a, b) => a.deadline.localeCompare(b.deadline)),
      brands: eprel?.brands || [],
    };
  },
  // Backfills the UK awards in steps; call ?sync=1 until done is true. Ordinary page loads keep it current.
  async sync({ store }) {
    const { fx } = await rates();
    const s = await ukSync(store, fx, 40000);
    return { done: !!s.done, items: s.items.length, scanned: s.scanned, syncedTo: s.syncedTo, error: s.error };
  },
};
