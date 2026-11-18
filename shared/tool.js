// Page logic shared by every client tool: loads /api/tenders, ranks firms, renders the firm list, open
// tenders and the drawer with a draft email, and handles copy and CSV export. Each client page calls
// Tool.mount(config) with its copy, tags and message() (see clients/<name>/index.html).
// scripts/smoke_test.js expects the element ids and classes used here and window.__tool.
(function () {
  const ymd = d => [d.getFullYear(), d.getMonth() + 1, d.getDate()].map(n => String(n).padStart(2, '0')).join('-');
  const daysBetween = (a, b) => Math.round((b - new Date(a + 'T00:00:00')) / 864e5);
  const COUNTRY = { AUT: 'Austria', BEL: 'Belgium', BGR: 'Bulgaria', HRV: 'Croatia', CYP: 'Cyprus', CZE: 'Czechia', DNK: 'Denmark',
    EST: 'Estonia', FIN: 'Finland', FRA: 'France', DEU: 'Germany', GRC: 'Greece', HUN: 'Hungary', IRL: 'Ireland', ITA: 'Italy',
    LVA: 'Latvia', LTU: 'Lithuania', LUX: 'Luxembourg', MLT: 'Malta', NLD: 'the Netherlands', POL: 'Poland', PRT: 'Portugal',
    ROU: 'Romania', SVK: 'Slovakia', SVN: 'Slovenia', ESP: 'Spain', SWE: 'Sweden', NOR: 'Norway', CHE: 'Switzerland',
    GBR: 'the United Kingdom', ISL: 'Iceland', LIE: 'Liechtenstein', MKD: 'North Macedonia', SRB: 'Serbia', ALB: 'Albania',
    MNE: 'Montenegro', MDA: 'Moldova', UKR: 'Ukraine', TUR: 'Türkiye', BIH: 'Bosnia and Herzegovina', GEO: 'Georgia' };
  const ISO2 = { AT: 'AUT', BE: 'BEL', BG: 'BGR', HR: 'HRV', CY: 'CYP', CZ: 'CZE', DK: 'DNK', EE: 'EST', FI: 'FIN', FR: 'FRA', DE: 'DEU',
    GR: 'GRC', EL: 'GRC', HU: 'HUN', IE: 'IRL', IT: 'ITA', LV: 'LVA', LT: 'LTU', LU: 'LUX', MT: 'MLT', NL: 'NLD', PL: 'POL', PT: 'PRT',
    RO: 'ROU', SK: 'SVK', SI: 'SVN', ES: 'ESP', SE: 'SWE', NO: 'NOR', CH: 'CHE', GB: 'GBR', UK: 'GBR', IS: 'ISL', LI: 'LIE' };
  const countryName = c => COUNTRY[c] || COUNTRY[ISO2[c]] || c || '';
  const countryLabel = c => countryName(c).replace(/^the /, '').replace(/^\w/, x => x.toUpperCase());
  const BUYER = t => /(^|-)(la|ra)$/.test(t) ? 'local' : /cga$/.test(t) ? 'central' : t ? 'other' : '';
  const SIZE = s => ({ micro: 'small', small: 'small', sme: 'small', medium: 'medium', large: 'large' }[s] || '');
  const SIZE_LABEL = { micro: 'Micro firm', small: 'Small firm', sme: 'SME', medium: 'Mid-sized firm', large: 'Large firm' };
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const D = (s, o) => new Date(s + 'T00:00:00').toLocaleDateString('en-US', o);
  const fmtDate = s => D(s, { month: 'short', day: 'numeric', year: 'numeric' });
  const longDate = s => D(s, { month: 'long', day: 'numeric' });
  const monthYear = s => D(s, { month: 'long', year: 'numeric' });
  const monthOnly = s => D(s, { month: 'long' });
  const ago = d => d < 1 ? 'today' : d === 1 ? 'yesterday' : d < 60 ? d + ' days ago' : Math.round(d / 30.4) + ' months ago';
  const eurFmt = v => !v ? '' : v >= 1e6 ? '€' + (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M' : v >= 1e3 ? '€' + Math.round(v / 1e3) + 'K' : '€' + Math.round(v);
  const list = xs => xs.length <= 2 ? xs.join(' and ') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];
  // Registries record some names in all caps ("FLEXIPOWER GROUP SP. Z O.O."). Recase only those, keeping
  // short words and vowel-less words (SP, Z, O.O., ČEZ) in caps; mixed-case names are already right.
  const tidy = s => { s = String(s || '').trim(); return s !== s.toUpperCase() ? s : s.replace(/\p{Lu}+/gu, (w, i) =>
    i > 0 && ['OF', 'AND', 'THE', 'DE', 'DU', 'DES', 'LA', 'LE', 'LES', 'ET', 'DI', 'DEL'].includes(w) ? w.toLowerCase()
    : w.length <= 3 || !/[AEIOUYÁÉÍÓÚÝĚŮÄÖÜĄĘÔΑΕΗΙΟΥΩАЕИОУЪЮЯ]/u.test(w) ? w : w[0] + w.slice(1).toLowerCase()); };

  // Keeps the previous day's visit through same-day reloads, for the "New since your last visit" filter.
  // Storage can be blocked; then "new" falls back to the last 7 days.
  function lastVisit(name) {
    const today = ymd(new Date()), k = name + '-visits';
    try {
      const v = JSON.parse(localStorage.getItem(k) || '{}');
      const prev = v.last === today ? v.prev : v.last;
      localStorage.setItem(k, JSON.stringify({ prev: prev || null, last: today }));
      return prev || null;
    } catch { return null; }
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      const t = Object.assign(document.createElement('textarea'), { value: text });
      document.body.append(t); t.select();
      let ok; try { ok = document.execCommand('copy'); } catch { ok = false; }
      t.remove(); return ok;
    }
  }
  function downloadCSV(name, cols, rows) {
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const blob = new Blob([[cols.map(q).join(','), ...rows.map(r => r.map(q).join(','))].join('\n')], { type: 'text/csv' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${name}-${ymd(new Date())}.csv` });
    a.click(); URL.revokeObjectURL(a.href);
  }
  const h = { ymd, daysBetween, countryName, countryLabel, esc, fmtDate, longDate, monthYear, monthOnly, ago, eurFmt, tidy, list, copyText, downloadCSV };

  function skeleton(cfg) {
    const tagOptions = Object.entries(cfg.tags).map(([k, t]) => `<option value="${k}">${esc(t.filter)}</option>`).join('');
    document.body.innerHTML = `
<section class="hero">${cfg.heroArt || ''}
  <div class="wrap">
    <div class="topbar">
      <div class="byline">Built for the <b>${esc(cfg.client)}</b> team by <b>${esc(cfg.firm)}</b></div>
      <div class="top-actions">
        <button class="pill ghost" id="copy-all" type="button">Copy all drafts</button>
        <button class="pill ghost" id="csv" type="button">Download CSV</button>
      </div>
    </div>
    <h1>${cfg.hero.title}</h1>
    <p class="lede">${esc(cfg.hero.lede)}</p>
    <div class="stats" id="stats"></div>
  </div>
</section>
<div class="filters">
  <div class="wrap">
    <input class="field" id="q" type="search" placeholder="Search firms, buyers or towns" aria-label="Search firms, buyers or towns">
    <select class="field" id="country" aria-label="Country"><option value="">All countries</option></select>
    <select class="field" id="window" aria-label="Won within">
      <option value="">Won in last 12 months</option><option value="180">Won in last 6 months</option>
      <option value="90">Won in last 90 days</option><option value="new">New since your last visit</option>
    </select>
    <select class="field" id="wins" aria-label="Contracts won">
      <option value="">Any number of wins</option><option value="2">2 or more wins</option><option value="5">5 or more wins</option>
    </select>
    <select class="field" id="size" aria-label="Firm size">
      <option value="">Any firm size</option><option value="small">Micro or small</option><option value="medium">Medium</option><option value="large">Large</option>
    </select>
    <select class="field" id="scope" aria-label="Scope"><option value="">Any scope</option>${tagOptions}</select>
    <select class="field" id="buyer" aria-label="Buyer">
      <option value="">Any buyer</option><option value="local">Towns and regions</option><option value="central">National government</option><option value="other">Other public bodies</option>
    </select>
    <div class="chips" role="group" aria-label="Priority">
      <button class="chip" type="button" data-pri="High" aria-pressed="true"><span class="dot" style="background:var(--high)"></span>High</button>
      <button class="chip" type="button" data-pri="Medium" aria-pressed="true"><span class="dot" style="background:var(--med)"></span>Medium</button>
      <button class="chip" type="button" data-pri="Low" aria-pressed="false"><span class="dot" style="background:var(--low)"></span>Low</button>
    </div>
    <div class="count" id="count"></div>
  </div>
</div>
<main>
  <div class="wrap">
    <div class="list" role="table" aria-label="${esc(cfg.noun.listLabel)}">
      <div class="head" role="row">
        <div role="columnheader"><button type="button" data-sort="score">Priority</button></div>
        <div role="columnheader"><button type="button" data-sort="name">Firm</button></div>
        <div role="columnheader"><button type="button" data-sort="won">Latest ${esc(cfg.noun.contract)}</button></div>
        <div role="columnheader"><button type="button" data-sort="winCount">Wins</button></div>
        <div role="columnheader"><button type="button" data-sort="eur">Value</button></div>
      </div>
      <div id="rows"></div>
    </div>
    <div class="section-head"><h2>Open ${esc(cfg.noun.tenders)}</h2><span class="sub" id="t-count"></span></div>
    <div class="list" aria-label="Open ${esc(cfg.noun.tenders)}"><div id="tenders"></div></div>
    <div id="extra"></div>
  </div>
</main>
<footer><div class="wrap" id="source"></div></footer>
<div class="scrim" id="scrim"></div>
<aside class="drawer" id="drawer" inert aria-labelledby="d-name">
  <div class="d-head">
    <div><h2 id="d-name"></h2><div class="sub" id="d-sub"></div><div class="links" id="d-links"></div></div>
    <button class="close" id="close" type="button" aria-label="Close">×</button>
  </div>
  <div class="d-body">
    <div class="facts" id="d-facts"></div>
    <div id="d-sections"></div>
    <h3>Draft email</h3>
    <div class="compose">
      <label for="d-subject">Subject</label><input id="d-subject">
      <label for="d-body">Message</label><textarea id="d-body"></textarea>
      <div class="actions">
        <button class="pill primary" id="copy" type="button">Copy email</button>
        <a class="pill light" id="mailto" href="#">Open in mail</a>
        <span class="copied" id="copied" role="status">Copied</span>
      </div>
    </div>
  </div>
</aside>`;
  }

  // Ranks one firm. Only awards attributed with confidence count (see lib/firms.js).
  // scopeScore(f) is 0 to 1 for the client's own size signal (storage scope, rollout size); defaults to any tag.
  function rank(f, today, since, tagKeys, scopeScore) {
    f.ranked = f.wins.filter(w => w.basis !== 'unclear');
    f.latest = f.ranked.find(w => w.basis === 'certain' && daysBetween(w.won, today) <= daysBetween(f.ranked[0].won, today) + 45) || f.ranked[0];
    f.won = f.ranked[0].won;
    f.daysSinceWin = daysBetween(f.won, today);
    f.winCount = f.ranked.length;
    f.eur = f.ranked.reduce((s, w) => s + (w.eur || 0), 0);
    tagKeys.forEach(k => { f[k] = f.ranked.some(w => w[k]); });
    f.isNew = f.ranked.some(w => since ? w.pub > since : daysBetween(w.pub, today) <= 7);
    const recency = Math.max(0, 1 - f.daysSinceWin / 365);
    const repeat = Math.min(1, (f.winCount - 1) / 5);
    const size = Math.min(1, Math.sqrt(f.eur / 3e6));
    const scope = scopeScore ? scopeScore(f) : tagKeys.some(k => f[k]) ? 1 : 0;
    f.score = 0.45 * recency + 0.25 * repeat + 0.2 * size + 0.1 * scope;
    f.priority = f.score >= 0.55 ? 'High' : f.score >= 0.35 ? 'Medium' : 'Low';
  }

  async function mount(cfg) {
    skeleton(cfg);
    const $ = id => document.getElementById(id);
    $('rows').innerHTML = '<div class="empty">Pulling the latest notices…</div>';
    let data;
    try {
      const res = await fetch('/api/tenders', { signal: AbortSignal.timeout(45000) });
      if (!res.ok) throw new Error('feed ' + res.status);
      data = await res.json();
      if (!Array.isArray(data.firms) || !Array.isArray(data.tenders)) throw new Error('bad feed');
    } catch (e) { $('rows').innerHTML = '<div class="empty">The tender data did not load. Refresh the page to try again.</div>'; return; }

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const since = lastVisit(cfg.name);
    const tagKeys = Object.keys(cfg.tags);
    const firms = data.firms.filter(f => f.wins.some(w => w.basis !== 'unclear'));
    firms.forEach(f => { rank(f, today, since, tagKeys, cfg.scopeScore); f.display = tidy(f.name); });
    const tenders = data.tenders.filter(t => t.deadline >= ymd(today));
    const daysTo = d => daysBetween(ymd(today), new Date(d + 'T00:00:00'));
    // Tenders a rep can still act on after sending: at least three days left.
    const openIn = (c, exceptBuyer) => tenders.filter(t => t.buyerCountry === c && t.buyer !== exceptBuyer && daysTo(t.deadline) >= 3);
    const ctx = { ...h, today, openIn, cfg };
    const tagHTML = x => tagKeys.filter(k => x[k]).map(k => `<span class="tag${cfg.tags[k].alt ? ' alt' : ''}">${esc(cfg.tags[k].label)}</span>`).join('');
    const spec = w => (w.basis ? w.basis === 'certain' : true) ? cfg.spec(w) : '';
    const linkOf = x => x.url || `https://ted.europa.eu/en/notice/-/detail/${encodeURIComponent(x.id)}`;
    const m = data.meta || {};

    $('stats').innerHTML = cfg.stats({ firms, tenders, data, daysTo }).map(([n, l]) => `<div class="stat"><div class="n">${Number(n).toLocaleString('en-US')}</div><div class="l">${esc(l)}</div></div>`).join('');
    const fetched = m.fetchedAt ? new Date(m.fetchedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    $('source').textContent = cfg.source(m, ctx) + (fetched ? ` Fetched ${fetched}${m.source === 'stored' ? ' (a source did not answer, so this is the last good copy)' : ''}.` : '') +
      ` Values in EUR${m.fxDate ? ' at ECB rates of ' + fmtDate(m.fxDate) : ''}.`;

    const countries = [...new Set([...firms.map(f => f.country), ...tenders.map(t => t.buyerCountry)])].filter(Boolean)
      .sort((a, b) => countryLabel(a).localeCompare(countryLabel(b)));
    countries.forEach(c => $('country').insertAdjacentHTML('beforeend', `<option value="${esc(c)}">${esc(countryLabel(c))}</option>`));

    let sortKey = 'score', current = null, tenderLimit = 10;
    const sortDir = { score: -1, won: -1, winCount: -1, eur: -1, name: 1 };
    const pri = { High: true, Medium: true, Low: false };
    const message = f => cfg.message(f, ctx);

    function filtered() {
      const q = $('q').value.trim().toLowerCase(), c = $('country').value, win = $('window').value;
      const minWins = +$('wins').value || 0, size = $('size').value, scope = $('scope').value, buyer = $('buyer').value;
      const out = firms.filter(f =>
        pri[f.priority] && (!c || f.country === c) &&
        (win === 'new' ? f.isNew : !win || f.daysSinceWin <= +win) &&
        f.winCount >= minWins && (!size || SIZE(f.size) === size) && (!scope || f[scope]) &&
        (!buyer || f.ranked.some(w => BUYER(w.buyerType) === buyer)) &&
        (!q || [f.name, f.display, ...f.ranked.map(w => w.buyer + ' ' + w.buyerCity)].join(' ').toLowerCase().includes(q)));
      const dir = sortDir[sortKey], val = (f, k) => k === 'name' ? f.display.toLowerCase() : f[k];
      return out.sort((a, b) => { const x = val(a, sortKey), y = val(b, sortKey); return (x > y ? 1 : x < y ? -1 : 0) * dir || b.score - a.score; });
    }
    const why = f => [`won ${ago(f.daysSinceWin)}`, f.winCount > 1 && `${f.winCount} wins in 12 months`,
      f.eur > 0 && `${eurFmt(f.eur)} in published value`, ...tagKeys.filter(k => f[k]).map(k => cfg.tags[k].why)].filter(Boolean).join(' · ');

    function render() {
      const rows = filtered();
      $('count').textContent = `${rows.length} of ${firms.length} firms`;
      const maxEur = Math.max(1, ...firms.map(f => f.eur));
      $('rows').innerHTML = rows.length ? rows.map(f => {
        const w = f.latest, s = spec(w);
        return `<div class="row${current?.key === f.key ? ' active' : ''}" role="row" tabindex="0" data-id="${esc(f.key)}">
          <div class="c-pri" role="cell"><span class="badge ${f.priority}"><span class="dot"></span>${f.priority}</span></div>
          <div class="c-firm" role="cell"><div class="name">${esc(f.display)}${f.isNew ? '<span class="tag new">New</span>' : ''}</div><div class="sub">${esc([countryLabel(f.country), SIZE_LABEL[f.size]].filter(Boolean).join(' · '))}</div><div class="why">${esc(why(f))}</div></div>
          <div class="c-deal" role="cell"><div class="clip">${esc(tidy(w.buyer))}${s ? ` <span class="sub">· ${esc(s)}</span>` : ''}${tagHTML(w)}</div><div class="sub">Won ${fmtDate(w.won)} · ${ago(daysBetween(w.won, today))}</div></div>
          <div class="c-wins" role="cell"><div>${f.winCount} ${esc(f.winCount === 1 ? cfg.noun.contract : cfg.noun.contracts)}</div><div class="sub">last 12 months</div></div>
          <div class="c-val" role="cell"><div>${f.eur ? eurFmt(f.eur) : '<span class="sub">Not published</span>'}</div><div class="bar"><span style="width:${Math.round(Math.sqrt(f.eur / maxEur) * 100)}%"></span></div></div>
        </div>`;
      }).join('') : '<div class="empty">No firms match these filters.</div>';
      document.querySelectorAll('.head [role="columnheader"]').forEach(hd => {
        const key = hd.firstElementChild.dataset.sort;
        if (key === sortKey) hd.setAttribute('aria-sort', sortDir[key] > 0 ? 'ascending' : 'descending'); else hd.removeAttribute('aria-sort');
      });
      renderTenders();
    }
    function renderTenders() {
      const c = $('country').value, ts = tenders.filter(t => !c || t.buyerCountry === c);
      $('t-count').textContent = `${ts.length} open${c ? ' in ' + countryName(c) : ''}, closest deadline first`;
      $('tenders').innerHTML = ts.length
        ? ts.slice(0, tenderLimit).map(t => {
          const left = daysTo(t.deadline), s = spec(t);
          return `<div class="t-row">
            <div class="t-due"><div class="due${left <= 14 ? ' soon' : ''}">${fmtDate(t.deadline)}</div><div class="sub">${left < 1 ? 'closes today' : 'in ' + left + ' day' + (left === 1 ? '' : 's')}</div></div>
            <div class="t-buyer"><div class="name">${esc(tidy(t.buyer))}</div><div class="sub">${esc([t.buyerCity, countryLabel(t.buyerCountry)].filter(Boolean).join(', '))}</div></div>
            <div class="t-title"><div class="sub clip">${esc(t.title)}</div>${s ? `<span class="tag">${esc(s)}</span>` : ''}${tagHTML(t)}</div>
            <div class="t-link"><a href="${esc(linkOf(t))}" target="_blank" rel="noopener">Notice</a></div>
          </div>`;
        }).join('') + (ts.length > tenderLimit ? `<button class="more" id="more" type="button">Show all ${ts.length}</button>` : '')
        : `<div class="empty">No open ${esc(cfg.noun.tenders)} here right now.</div>`;
      const more = $('more'); if (more) more.onclick = () => { tenderLimit = Infinity; renderTenders(); };
    }

    // The drawer shows any record: { key, title, sub, links, facts, sections: [{ title, html }], message }.
    function openDrawer(d) {
      current = d;
      $('d-name').textContent = d.title;
      $('d-sub').textContent = d.sub || '';
      $('d-links').innerHTML = d.links.map(([label, href]) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>`).join('');
      $('d-facts').innerHTML = d.facts.map(([n, l]) => `<div class="fact"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`).join('');
      $('d-sections').innerHTML = d.sections.map(s => `<div class="block"><h3>${esc(s.title)}</h3>${s.html}</div>`).join('');
      $('d-subject').value = d.message.subject;
      $('d-body').value = d.message.body;
      syncMailto();
      $('drawer').classList.add('open'); $('scrim').classList.add('open');
      $('drawer').inert = false;
      $('drawer').querySelector('.d-body').scrollTop = 0;
      $('close').focus();
      render(); if (cfg.renderExtra) cfg.renderExtra();
    }
    function closeDrawer() {
      const key = current.key;
      $('drawer').classList.remove('open'); $('scrim').classList.remove('open');
      $('drawer').inert = true;
      current = null; render(); if (cfg.renderExtra) cfg.renderExtra();
      [...document.querySelectorAll('[data-id]')].find(r => r.dataset.id === key)?.focus();
    }
    function syncMailto() {
      $('mailto').href = `mailto:?subject=${encodeURIComponent($('d-subject').value)}&body=${encodeURIComponent($('d-body').value)}`;
    }
    const deal = (title, lines, href, linkLabel, cls = '') => `<div class="deal ${cls}"><div class="name">${title}</div>${lines.map(l => `<div class="sub${l.clip ? ' clip' : ''}">${l.html ?? esc(l)}</div>`).join('')}${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(linkLabel)}</a>` : ''}</div>`;

    function openFirm(f) {
      const here = tenders.filter(t => t.buyerCountry === f.country);
      openDrawer({
        key: f.key, title: f.display,
        sub: [countryLabel(f.country), SIZE_LABEL[f.size], f.regId && 'Reg. no. ' + f.regId].filter(Boolean).join(' · '),
        links: [f.website && ['Website', f.website], ['Find them on LinkedIn', 'https://www.linkedin.com/search/results/companies/?keywords=' + encodeURIComponent(f.display)], ['Latest notice', linkOf(f.latest)]].filter(Boolean),
        facts: [[f.winCount, cfg.noun.contracts + ', 12 months'], [f.eur ? eurFmt(f.eur) : 'Not published', 'published value'], [here.length, cfg.noun.tenders + ' open in ' + (countryLabel(f.country) || 'their country')]],
        sections: [
          { title: `${cfg.noun.contracts} in the last 12 months`, html: f.wins.map(w => deal(esc(tidy(w.buyer)) + tagHTML(w), [
            { html: esc(w.title), clip: true },
            [[w.buyerCity, countryLabel(w.buyerCountry)].filter(Boolean).join(', '), 'won ' + fmtDate(w.won), w.eur && !w.shared && eurFmt(w.eur), spec(w),
              w.shared && 'shared with other winners' + (w.basis === 'unclear' ? ', lot not confirmed' : ''), w.lots > 1 && w.lots + ' lots'].filter(Boolean).join(' · '),
          ], linkOf(w), 'Notice ' + w.id, w.basis === 'unclear' ? 'unclear' : '')).join('') },
          { title: `Open ${cfg.noun.tenders} in ${countryLabel(f.country) || 'their country'}`, html: here.length
            ? here.slice(0, 5).map(t => deal(esc(tidy(t.buyer)), [{ html: esc(t.title), clip: true }, 'Closes ' + fmtDate(t.deadline)], linkOf(t), 'Notice')).join('')
              + (here.length > 5 ? `<div class="sub">and ${here.length - 5} more in the open tenders list</div>` : '')
            : '<div class="sub">None open right now.</div>' },
        ],
        message: message(f),
      });
    }
    const byKey = k => firms.find(f => f.key === k);
    $('rows').addEventListener('click', e => { const r = e.target.closest('.row'); if (r) openFirm(byKey(r.dataset.id)); });
    $('rows').addEventListener('keydown', e => { if (e.key === 'Enter') { const r = e.target.closest('.row'); if (r) openFirm(byKey(r.dataset.id)); } });
    $('close').onclick = closeDrawer; $('scrim').onclick = closeDrawer;
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && current) closeDrawer(); });
    ['q', 'country', 'window', 'wins', 'size', 'scope', 'buyer'].forEach(id => $(id).addEventListener('input', () => { tenderLimit = 10; render(); }));
    document.querySelectorAll('.chip').forEach(c => c.onclick = () => { pri[c.dataset.pri] = !pri[c.dataset.pri]; c.setAttribute('aria-pressed', pri[c.dataset.pri]); render(); });
    document.querySelectorAll('.head button').forEach(btn => btn.onclick = () => { sortKey = btn.dataset.sort; render(); });
    ['d-subject', 'd-body'].forEach(id => $(id).addEventListener('input', syncMailto));
    $('copy').onclick = async () => {
      const ok = await copyText(`Subject: ${$('d-subject').value}\n\n${$('d-body').value}`);
      $('copied').textContent = ok ? 'Copied' : "Couldn't copy";
      $('copied').classList.add('show'); setTimeout(() => $('copied').classList.remove('show'), 1500);
    };
    $('copy-all').onclick = async () => {
      const fs = filtered();
      const ok = await copyText(fs.map(f => { const x = message(f); return `To: ${f.display}\nSubject: ${x.subject}\n\n${x.body}`; }).join('\n\n----------\n\n'));
      $('copy-all').textContent = ok ? `Copied ${fs.length}` : "Couldn't copy";
      setTimeout(() => { $('copy-all').textContent = 'Copy all drafts'; }, 1600);
    };
    $('csv').onclick = () => downloadCSV(cfg.csvName,
      ['Priority', 'Score', 'Firm', 'Country', 'Firm size', 'Registration no.', 'Website', 'Contracts (12 months)', 'Published value (EUR)', 'Latest buyer', 'Latest won', 'Latest notice', ...tagKeys.map(k => cfg.tags[k].label), 'Open tenders in country', 'Other buyers', 'Email subject', 'Email body'],
      filtered().map(f => { const w = f.latest, x = message(f); return [f.priority, f.score.toFixed(2), f.display, countryLabel(f.country), SIZE_LABEL[f.size] || '', f.regId, f.website, f.winCount, f.eur || '', tidy(w.buyer), w.won, linkOf(w), ...tagKeys.map(k => f[k] ? 'Yes' : ''), tenders.filter(t => t.buyerCountry === f.country).length, f.ranked.filter(r => r !== w).map(r => tidy(r.buyer)).join('; '), x.subject, x.body]; }));
    render();
    if (cfg.extend) cfg.extend(data, { ...ctx, openDrawer, deal, $, isOpen: k => current?.key === k });
    window.__tool = { records: firms, message, filtered }; // used by scripts/smoke_test.js
  }
  window.Tool = { mount, h };
})();
