// The HTTP side of every client feed: runs the client's build, keeps the last good result in Vercel Blob,
// and falls back to it when a source is down or returns something that looks incomplete.
//
//   GET /api/tenders           full data set (edge-cached 15 minutes, refreshed in the background)
//   GET /api/tenders?health=1  counts and fetch time only, from the stored copy when there is one
//   GET /api/tenders?sync=1    runs the client's incremental sync step, if it has one (never cached; the
//                              client's lease makes overlapping or repeated calls return without work)
//
// put and head come from @vercel/blob and are passed in so this module has no package imports.

export function makeStore({ put, head }) {
  const on = () => !!process.env.BLOB_READ_WRITE_TOKEN;
  return {
    on,
    async read(key) {
      if (!on()) return null;
      try {
        const meta = await head(key);
        const res = await fetch(meta.url + '?v=' + Date.now(), { signal: AbortSignal.timeout(8000) });
        return res.ok ? await res.json() : null;
      } catch { return null; }
    },
    async write(key, data) {
      if (!on()) return false;
      try {
        await put(key, JSON.stringify(data), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60 });
        return true;
      } catch { return false; } // the live response still goes out; the next pull tries again
    },
  };
}

const reply = (body, status, cache) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache },
});

export function makeHandler({ client, store }) {
  const key = client.name + '/latest.json';
  return async function GET(request) {
    const params = new URL(request.url).searchParams;
    if (params.has('sync')) {
      if (!client.sync) return reply({ ok: false, error: 'No sync step' }, 404, 'no-store');
      try { return reply({ ok: true, ...(await client.sync({ store })) }, 200, 'no-store'); }
      catch (e) { return reply({ ok: false, error: e.message }, 502, 'no-store'); }
    }
    const health = params.has('health');
    const prev = await store.read(key);
    // Health reports the stored copy when there is one, so polling it never adds load on the sources.
    if (health && prev?.meta) return reply({ ok: true, ...prev.meta, source: 'stored', stored: true }, 200, 'no-store');
    let data = null, warning = '';
    try { data = await client.build({ store }); } catch (e) { warning = 'Source did not respond (' + e.message + ')'; }
    // Only replace the stored copy with a pull that looks whole: at least half as many awards and nothing older.
    if (data && prev?.meta && (data.meta.awards < prev.meta.awards * 0.5 || data.meta.newest < prev.meta.newest)) {
      warning = `Source returned ${data.meta.awards} awards against ${prev.meta.awards} last time`;
      data = null;
    }
    let source = 'live';
    if (data) {
      // Rewrite the stored copy only when the data changed, or every six hours to keep its fetch time honest.
      const body = d => JSON.stringify(Object.entries(d).filter(([k]) => k !== 'meta'));
      const same = prev && body(prev) === body(data);
      if (!same || Date.now() - Date.parse(prev.meta.fetchedAt) > 6 * 3600e3) await store.write(key, data);
    } else if (prev) { data = prev; source = 'stored'; }
    else return reply({ ok: false, error: warning || 'No data yet' }, 503, 'no-store');
    data.meta = { ...data.meta, source, warning: warning || undefined, stored: store.on() };
    const cache = source === 'live'
      ? 'public, max-age=0, s-maxage=900, stale-while-revalidate=86400'
      : 'public, max-age=0, s-maxage=120, stale-while-revalidate=86400';
    return reply(health ? { ok: true, ...data.meta } : data, 200, health ? 'no-store' : cache);
  };
}
