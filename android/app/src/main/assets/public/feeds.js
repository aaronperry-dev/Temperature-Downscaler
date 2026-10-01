/*
 * On-device data feeds.
 *
 * Does in the browser (or in the Android app) what api/nws.php, api/autoroad.php, api/upperair.php and api/metar.php do on a PHP
 * server: asks the public services, slims the answers to the same JSON formats, keeps them for the same number of seconds, and
 * falls back to the last saved copy when a service cannot be reached. app.js asks for "api/nws.php?..." and so on through
 * Feeds.fetch(); in direct mode those requests are answered here as Response objects (same body, same X-Cache header, same
 * newline-delimited progress stream for the big NWS pull), so nothing else in the app changes.
 *
 * Direct mode is on inside the Android app (Capacitor) and whenever window.NH48_FEEDS.direct is true. Otherwise Feeds.fetch() is
 * plain fetch() and the PHP (or serve.py) server does the work.
 *
 * Inside the app, requests go through Capacitor's native HTTP plugin: it sends the User-Agent NWS asks for and is not subject to
 * the browser's cross-origin rules. In a plain browser the services must allow cross-origin requests themselves.
 *
 * Settings come from window.NH48_FEEDS (feeds-config.js); the defaults are the same as api/config.php.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.Feeds = factory(root);
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var FORMAT_NWS = 'nh48-nws-v1', FORMAT_AR = 'nh48-autoroad-v1', FORMAT_UA = 'nh48-upperair-v1', FORMAT_MT = 'nh48-metar-v1';
  var KEEP = ['temperature', 'dewpoint', 'relativeHumidity', 'windSpeed', 'windGust', 'windDirection',
    'skyCover', 'quantitativePrecipitationAmount', 'snowfallAmount', 'probabilityOfPrecipitation'];
  var RETRY_STATUS = [0, 429, 500, 502, 503, 504];
  var UA_LEVELS = [950, 925, 900, 850, 800, 700];
  var AR_NOT_AIR = /road\s*(surface\s*)?temp|pavement|surface|soil|ground/i;   // labels of things that are not air temperature
  var MAX_BYTES = { ar: 8 * 1024 * 1024, ua: 4 * 1024 * 1024, mt: 2 * 1024 * 1024 };

  var DEFAULTS = {
    direct: null,              // true / false forces the mode; null = on inside the Android app only
    contact: 'NH48 Summit Forecast app',   // goes in the User-Agent NWS asks every client to send (feeds-config.js sets it)
    base: 'https://api.weather.gov',
    autoroadUrl: 'https://xmountwashington.appspot.com/proxy.php?endpoint=autoroad',
    autoroadTtl: 60,
    upperairUrl: 'https://api.open-meteo.com/v1/forecast',
    upperairModels: '',
    upperairTtl: 3600,
    metarStations: { KHIE: 326, KIZG: 138 },
    metarTtl: 300,
    ttl: 3600,                 // seconds a saved NWS pull is served
    minRefresh: 300,           // a Refresh is ignored when the saved pull is newer than this
    concurrency: 6,
    timeout: 25,
    peaks: null                // the 48 summits; defaults to the NH48 list that peaks.js defines
  };
  var cfg = {};
  function configure(o) {
    var k, src = o || {};
    cfg = {};
    for (k in DEFAULTS) cfg[k] = DEFAULTS[k];
    var given = root.NH48_FEEDS || {};
    for (k in given) cfg[k] = given[k];
    for (k in src) cfg[k] = src[k];
    if (!cfg.peaks) cfg.peaks = root.NH48 || [];
    return cfg;
  }
  configure();

  /* ------------------------------------------------------------------ small helpers (PHP behaviour, in JS) */
  function isNumeric(v) { return (typeof v === 'number' && isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))); }
  // PHP round(): halves go away from zero
  function round(x, d) { var m = Math.pow(10, d || 0), s = x < 0 ? -1 : 1; return s * Math.round(Number((Math.abs(x) * m).toPrecision(15))) / m; }
  function strtotime(s) {
    s = String(s).trim();
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = s.replace(' ', 'T') + 'Z';   // no zone: the server clock was UTC
    var t = Date.parse(s);
    return isNaN(t) ? false : Math.floor(t / 1000);
  }
  function now() { return Math.floor(Date.now() / 1000); }
  function gmdateC() { return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00'); }
  function gmdateZ() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function pathOf(url) { try { return new URL(url).pathname; } catch (e) { return url; } }
  function fmt4(x) { return Number(x).toFixed(4); }

  /* ------------------------------------------------------------------ saved copies (IndexedDB, or memory when that is not available) */
  var mem = {}, dbp = null;
  function openDb() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve) {
      try {
        var idb = root.indexedDB;
        if (!idb) return resolve(null);
        var rq = idb.open('nh48-feeds', 1);
        rq.onupgradeneeded = function () { rq.result.createObjectStore('kv'); };
        rq.onsuccess = function () { resolve(rq.result); };
        rq.onerror = function () { resolve(null); };
        rq.onblocked = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
    return dbp;
  }
  async function kvGet(key) {
    var db = await openDb();
    if (!db) return mem[key] || null;
    return new Promise(function (resolve) {
      try {
        var rq = db.transaction('kv', 'readonly').objectStore('kv').get(key);
        rq.onsuccess = function () { resolve(rq.result || mem[key] || null); };
        rq.onerror = function () { resolve(mem[key] || null); };
      } catch (e) { resolve(mem[key] || null); }
    });
  }
  async function kvSet(key, value) {
    var rec = { t: Date.now(), v: value };
    mem[key] = rec;
    var db = await openDb();
    if (!db) return;
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(rec, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { resolve(); };
        tx.onabort = function () { resolve(); };
      } catch (e) { resolve(); }
    });
  }
  function ageOf(rec) { return rec ? (Date.now() - rec.t) / 1000 : Infinity; }

  /* ------------------------------------------------------------------ one HTTP GET: { status, body, error } */
  function isNative() { var c = root.Capacitor; return !!(c && typeof c.isNativePlatform === 'function' && c.isNativePlatform()); }
  function nativeHttp() {
    var c = root.Capacitor, ex = root.capacitorExports;
    return (ex && ex.CapacitorHttp) || (c && c.Plugins && c.Plugins.CapacitorHttp) || null;
  }
  function userAgent() { return 'NH48SummitDashboard/1.0 (' + cfg.contact + ')'; }
  async function httpGet(url, o) {
    o = o || {};
    var t0 = Date.now(), timeoutMs = (o.timeout || cfg.timeout) * 1000, status = 0, body = null, err = null;
    try {
      var nat = isNative() ? nativeHttp() : null;
      if (nat) {
        var r = await nat.request({ url: url, method: 'GET', headers: { 'User-Agent': userAgent(), Accept: o.accept || 'application/json' },
          connectTimeout: 10000, readTimeout: timeoutMs, responseType: 'text' });
        status = r.status | 0; body = typeof r.data === 'string' ? r.data : (r.data == null ? '' : JSON.stringify(r.data));
      } else {
        var ac = typeof AbortController !== 'undefined' ? new AbortController() : null, timer = ac ? setTimeout(function () { ac.abort(); }, timeoutMs) : null;
        var headers = { Accept: o.accept || 'application/json' };
        if (typeof root.window === 'undefined' && typeof root.document === 'undefined') headers['User-Agent'] = userAgent();   // a browser may not set it, and trying would force a preflight
        try {
          var res = await root.fetch(url, { headers: headers, cache: 'no-store', redirect: 'follow', signal: ac ? ac.signal : undefined });
          status = res.status; body = await res.text();
        } finally { if (timer) clearTimeout(timer); }
      }
      if (o.maxBytes && body && body.length > o.maxBytes) { body = null; err = 'the answer was too large'; status = 0; }
    } catch (e) { status = 0; body = null; err = (e && e.message) || String(e); }
    var ok = status >= 200 && status < 300 && !err;
    return { status: err ? 0 : status, body: ok ? body : (err ? null : body), error: err || (ok ? null : 'HTTP ' + status), ok: ok, ms: Date.now() - t0 };
  }
  function parseJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

  /* ------------------------------------------------------------------ NWS gridded forecast for every summit (api/nws.php) */
  // Many URLs at once, `concurrency` at a time; failures (network, 429, 5xx) are retried in up to `rounds` passes with a growing pause.
  async function fetchAll(urls, meta, sink, rounds) {
    var result = {}, pending = urls;
    rounds = rounds || 4;
    for (var round = 0; round < rounds && Object.keys(pending).length; round++) {
      if (round > 0) {
        var secs = Math.min(20, Math.pow(2, round));
        sink({ type: 'wait', seconds: secs, count: Object.keys(pending).length });
        await sleep((cfg.waitScale == null ? 1 : cfg.waitScale) * secs * 1000);
      }
      var batch = await fetchRound(pending, meta, sink, round, urls);
      pending = {};
      Object.keys(batch).forEach(function (key) {
        result[key] = batch[key];
        if (RETRY_STATUS.indexOf(batch[key].status) >= 0) pending[key] = urls[key];
      });
    }
    return result;
  }
  async function fetchRound(urls, meta, sink, round, allUrls) {
    var keys = Object.keys(urls), out = {}, next = 0;
    async function worker() {
      while (next < keys.length) {
        var key = keys[next++], r = await httpGet(urls[key], { accept: 'application/geo+json' });
        out[key] = { status: r.status, body: r.ok ? r.body : null, error: r.error };
        var m = meta[key];
        sink({ type: 'call', phase: m.phase, label: m.label, for: m.for || null, method: 'GET', path: pathOf(allUrls[key]), status: r.status, ms: r.ms, attempt: round + 1, error: r.error });
      }
    }
    var workers = [];
    for (var i = 0; i < Math.min(cfg.concurrency, keys.length); i++) workers.push(worker());
    await Promise.all(workers);
    return out;
  }
  // Middle of a grid cell, [lat, lon], from the GeoJSON polygon that comes with a /gridpoints answer.
  function cellCenter(geom) {
    var ring = geom && geom.coordinates && geom.coordinates[0];
    if (!Array.isArray(ring) || ring.length < 4) return null;
    ring = ring.slice(0, -1);   // the ring repeats its first point at the end
    var lat = 0, lon = 0;
    for (var i = 0; i < ring.length; i++) {
      var c = ring[i];
      if (!Array.isArray(c) || c[0] == null || c[1] == null) return null;
      lon += c[0]; lat += c[1];
    }
    return [round(lat / ring.length, 5), round(lon / ring.length, 5)];
  }
  function slim(props, tz, geom) {
    var out = { elevation: props.elevation != null ? props.elevation : null, updateTime: props.updateTime != null ? props.updateTime : null, timeZone: tz };
    var center = cellCenter(geom);
    if (center) out.center = center;
    KEEP.forEach(function (k) {
      if (props[k] && Array.isArray(props[k].values) && props[k].values.length) {
        out[k] = { uom: props[k].uom != null ? props[k].uom : null, values: props[k].values.map(function (v) { return { validTime: v.validTime, value: v.value }; }) };
      }
    });
    return out;
  }
  async function buildBundle(sink) {
    var peaks = cfg.peaks;
    if (!Array.isArray(peaks) || !peaks.length) throw new Error('The list of summits is missing or empty.');
    var base = String(cfg.base).replace(/\/+$/, '');
    var bundle = { format: FORMAT_NWS, generated: gmdateZ(), source: base, grids: {}, peaks: {} };
    var urls = {}, meta = {};
    peaks.forEach(function (p) {
      bundle.peaks[p.id] = { name: p.name, lat: p.lat, lon: p.lon };
      urls[p.id] = base + '/points/' + fmt4(p.lat) + ',' + fmt4(p.lon);
      meta[p.id] = { phase: 'points', label: p.name };
    });
    sink({ type: 'start', phase: 'points', total: Object.keys(urls).length });
    var points = await fetchAll(urls, meta, sink);
    var gridUrls = {}, tz = {};
    Object.keys(points).forEach(function (id) {
      var r = points[id], j = r.body != null ? parseJson(r.body) : null, pt = j && j.properties;
      if (!pt || pt.gridId == null || pt.gridX == null || pt.gridY == null) { bundle.peaks[id].error = r.error || 'The points lookup returned no grid cell.'; return; }
      var key = pt.gridId + '/' + pt.gridX + ',' + pt.gridY;
      bundle.peaks[id].grid = key;
      tz[key] = pt.timeZone || 'America/New_York';
      if (!gridUrls[key]) gridUrls[key] = pt.forecastGridData || (base + '/gridpoints/' + key);
    });
    var gridMeta = {};
    Object.keys(gridUrls).forEach(function (key) {
      var names = [];
      Object.keys(bundle.peaks).forEach(function (id) { if (bundle.peaks[id].grid === key) names.push(bundle.peaks[id].name); });
      gridMeta[key] = { phase: 'grids', label: 'Grid cell ' + key, for: names };
    });
    sink({ type: 'phase', phase: 'grids', total: Object.keys(gridUrls).length });
    var grids = Object.keys(gridUrls).length ? await fetchAll(gridUrls, gridMeta, sink) : {};
    var badCell = {};
    Object.keys(grids).forEach(function (key) {
      var r = grids[key], j = r.body != null ? parseJson(r.body) : null;
      if (!j || !j.properties || j.properties.temperature == null) { badCell[key] = r.error || 'The grid data had no temperature series.'; return; }
      bundle.grids[key] = slim(j.properties, tz[key], j.geometry || null);
    });
    Object.keys(bundle.peaks).forEach(function (id) {
      var e = bundle.peaks[id];
      if (e.grid != null && badCell[e.grid] != null) { e.error = badCell[e.grid]; delete e.grid; }
    });
    return bundle;
  }
  function countOk(bundle) { var n = 0; Object.keys(bundle.peaks).forEach(function (id) { if (bundle.peaks[id].grid != null) n++; }); return n; }

  var nwsFlight = null;   // one pull at a time
  function nws(q, init) {
    var refresh = q.get('refresh') === '1', stream = q.get('stream') === '1';
    return (async function () {
      var rec = await kvGet('nws'), age = ageOf(rec);
      if (rec && age < cfg.ttl && !refresh) return json(rec.v, 'hit');
      if (rec && refresh && age < cfg.minRefresh) return json(rec.v, 'hit-throttled');
      if (nwsFlight) {                       // someone else is pulling right now: wait for the new copy, or give the old one
        if (rec) return json(rec.v, 'stale');
        try { var b = await nwsFlight; return json(b, 'hit'); } catch (e) { return fail(502, String(e.message || e)); }
      }
      if (stream) return ndjson(async function (send) {
        var res = await pull(send, rec);
        send({ type: 'result', state: res.state, ok: res.ok, total: res.total, cells: res.cells, bundle: res.bundle });
      });
      try { var r = await pull(function () {}, rec); return json(r.bundle, r.state); } catch (e) { return fail(502, String(e.message || e)); }
    })();
  }
  // Pull everything from NWS and save it. Returns { bundle, state, ok, total, cells }. Throws when nothing came back and there is no saved copy.
  async function pull(sink, rec) {
    var p = (async function () {
      var bundle = await buildBundle(sink), ok = countOk(bundle);
      if (ok === 0) {
        if (rec) return { bundle: rec.v, state: 'stale-error', ok: 0, total: Object.keys(bundle.peaks).length, cells: 0 };
        var first = bundle.peaks[Object.keys(bundle.peaks)[0]];
        throw new Error('The NWS service returned no forecasts. First error: ' + ((first && first.error) || 'unknown'));
      }
      await kvSet('nws', bundle);
      return { bundle: bundle, state: 'miss', ok: ok, total: Object.keys(bundle.peaks).length, cells: Object.keys(bundle.grids).length };
    })();
    nwsFlight = p.then(function (r) { return r.bundle; });
    nwsFlight.catch(function () {});
    try { return await p; } finally { nwsFlight = null; }
  }

  /* ------------------------------------------------------------------ Mount Washington Auto Road (api/autoroad.php) */
  // Keep only what the dashboard uses: air temperature, good readings, numbers only.
  function arSlim(raw) {
    var stations = [];
    Object.keys(raw).forEach(function (key) {
      var st = raw[key];
      if (!st || typeof st !== 'object' || Array.isArray(st) || !st.metadata || !Array.isArray(st.measurements)) return;
      var md = st.metadata;
      if (md.stationDecommissionDate) { var dd = strtotime(md.stationDecommissionDate); if (dd === false || dd < now()) return; }   // (PHP reads an unparsable date as 0)
      var z = md.elevationMasl;
      if (!isNumeric(z)) return;
      var sensors = [];
      st.measurements.forEach(function (m) {
        // air temperature only: never the road surface, pavement or ground temperature, and only in degrees C (or F, converted)
        if ((m.measurement_key || '') !== 'air_temperature' || AR_NOT_AIR.test(String(m.measurement_name || ''))) return;
        var unit = String(m.unitSymbol || 'degC').toLowerCase(), toC;
        if (unit === 'degc' || unit === 'c') toC = false; else if (unit === 'degf' || unit === 'f') toC = true; else return;
        (m.sensors || []).forEach(function (q) {
          if (AR_NOT_AIR.test(String(q.instrument_notes || ''))) return;
          var t = [], v = [];
          (q.series || []).forEach(function (p) {
            var ts = p.date != null ? strtotime(p.date) : false, val = p.value != null ? p.value : null;
            if (ts === false || !isNumeric(val) || (parseInt(p.qa_flag || 0, 10) || 0) > 0) return;
            val = toC ? (Number(val) - 32) * 5 / 9 : Number(val);
            if (val <= -60 || val >= 50) return;
            t.push(ts); v.push(round(val, 2));
          });
          if (t.length) sensors.push({ id: q.instrument_id != null ? q.instrument_id : null, note: String(q.instrument_notes || '').slice(0, 60), t: t, v: v });
        });
      });
      if (!sensors.length) return;
      stations.push({ id: String(md.stationName != null ? md.stationName : key).slice(0, 12), name: String(md.stationLongName != null ? md.stationLongName : key).slice(0, 40),
        z: Number(z), lat: md.latitude != null && isNumeric(md.latitude) ? Number(md.latitude) : null, lon: md.longitude != null && isNumeric(md.longitude) ? Number(md.longitude) : null, sensors: sensors });
    });
    return stations;
  }
  async function arFetch() {
    var r = await httpGet(cfg.autoroadUrl, { timeout: 15, maxBytes: MAX_BYTES.ar });
    if (r.error) throw new Error(r.error);
    var raw = parseJson(r.body);
    if (!raw || typeof raw !== 'object') throw new Error('the answer was not JSON');
    var stations = arSlim(raw);
    if (stations.length < 2) throw new Error('the answer held fewer than two stations with temperature');
    return { format: FORMAT_AR, fetched: gmdateC(), source: 'Mount Washington Auto Road feed', stations: stations };
  }
  var arFlight = null;
  async function autoroad() {
    var rec = await kvGet('autoroad');
    if (rec && ageOf(rec) < cfg.autoroadTtl) return json(rec.v, 'hit');
    if (!arFlight) arFlight = arFetch().finally(function () { arFlight = null; });
    try { var out = await arFlight; await kvSet('autoroad', out); return json(out, 'miss'); }
    catch (e) { if (rec) return json(rec.v, 'stale-error'); return fail(502, 'The Auto Road feed did not answer (' + (e.message || e) + ').'); }
  }

  /* ------------------------------------------------------------------ model pressure levels (api/upperair.php) */
  function uaPeak(id) {
    if (!/^[a-z0-9-]{1,40}$/.test(id)) return null;
    var list = cfg.peaks || [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.id === id && isNumeric(p.lat) && isNumeric(p.lon)) return { id: id, lat: Number(p.lat), lon: Number(p.lon) };
    }
    return null;
  }
  function uaSeries(a, n, dec) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(Array.isArray(a) && a[i] != null && isNumeric(a[i]) ? round(Number(a[i]), dec) : null);
    return out;
  }
  async function uaFetch(peak) {
    var vars = ['pressure_msl'];
    UA_LEVELS.forEach(function (p) { vars.push('temperature_' + p + 'hPa', 'relative_humidity_' + p + 'hPa', 'geopotential_height_' + p + 'hPa'); });
    var q = { latitude: fmt4(peak.lat), longitude: fmt4(peak.lon), hourly: vars.join(','), timeformat: 'unixtime', timezone: 'UTC', forecast_days: 8, past_hours: 6 };
    if (cfg.upperairModels !== '') q.models = cfg.upperairModels;
    var qs = Object.keys(q).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]); }).join('&');
    var r = await httpGet(cfg.upperairUrl + (cfg.upperairUrl.indexOf('?') < 0 ? '?' : '&') + qs, { timeout: 20, maxBytes: MAX_BYTES.ua });
    var raw = r.body != null ? parseJson(r.body) : null;
    if (r.error && r.status === 0) throw new Error(r.error);
    if (!r.ok) {
      var why = raw && raw.reason != null ? ': ' + String(raw.reason).replace(/[^\x20-\x7e]/g, '').slice(0, 120) : '';
      throw new Error('HTTP ' + r.status + why);
    }
    if (!raw || !raw.hourly || !Array.isArray(raw.hourly.time)) throw new Error('the answer had no hourly data');
    var h = raw.hourly, times = [];
    h.time.forEach(function (t) { if (!isNumeric(t)) throw new Error('the answer had a bad time'); times.push(parseInt(t, 10)); });
    var n = times.length;
    if (n < 12) throw new Error('the answer held under 12 hours');
    var out = { format: FORMAT_UA, fetched: gmdateC(), source: 'Open-Meteo model pressure levels' + (cfg.upperairModels !== '' ? ' (' + cfg.upperairModels + ')' : ''),
      peak: peak.id, lat: peak.lat, lon: peak.lon, elevation: raw.elevation != null && isNumeric(raw.elevation) ? Number(raw.elevation) : null,
      levels: UA_LEVELS.slice(), times: times, mslp: uaSeries(h.pressure_msl, n, 1), t: {}, z: {}, rh: {} };
    var usable = 0, cnt = function (a) { return a.filter(function (x) { return x != null; }).length; };
    UA_LEVELS.forEach(function (p) {
      var k = String(p);
      out.t[k] = uaSeries(h['temperature_' + p + 'hPa'], n, 1);
      out.z[k] = uaSeries(h['geopotential_height_' + p + 'hPa'], n, 0);
      out.rh[k] = uaSeries(h['relative_humidity_' + p + 'hPa'], n, 0);
      if (cnt(out.t[k]) >= 12 && cnt(out.z[k]) >= 12) usable++;
    });
    if (usable < 3) throw new Error('the answer held fewer than three pressure levels');
    return out;
  }
  var uaFlight = {};
  async function upperair(q) {
    var peak = uaPeak(q.get('peak') || '');
    if (!peak) return fail(400, 'Give ?peak= with one of the 48 summit ids.');
    var key = 'upperair_' + peak.id, rec = await kvGet(key);
    if (rec && ageOf(rec) < cfg.upperairTtl) return json(rec.v, 'hit');
    if (!uaFlight[key]) uaFlight[key] = uaFetch(peak).finally(function () { delete uaFlight[key]; });
    try { var out = await uaFlight[key]; await kvSet(key, out); return json(out, 'miss'); }
    catch (e) { if (rec) return json(rec.v, 'stale-error'); return fail(502, 'The model pressure-level service did not answer (' + (e.message || e) + ').'); }
  }

  /* ------------------------------------------------------------------ observed surface pressure (api/metar.php) */
  // hPa from a value the API gives in Pa (or, defensively, already in hPa).
  function mtHpa(v) {
    if (!v || typeof v !== 'object' || v.value == null || !isNumeric(v.value)) return null;
    if (v.qualityControl === 'X' || v.qualityControl === 'B') return null;   // rejected or bad by the NWS quality control
    var p = Number(v.value);
    if (p > 2000) p /= 100;
    return p > 500 && p < 1200 ? round(p, 2) : null;
  }
  async function mtStation(id, zFallback) {
    var url = String(cfg.base).replace(/\/+$/, '') + '/stations/' + encodeURIComponent(id) + '/observations?limit=14';
    var r = await httpGet(url, { accept: 'application/geo+json', timeout: 15, maxBytes: MAX_BYTES.mt });
    if (r.status === 0 && r.error) throw new Error(id + ': ' + r.error);
    if (!r.ok) throw new Error(id + ': HTTP ' + r.status);
    var raw = parseJson(r.body);
    if (!raw || !Array.isArray(raw.features)) throw new Error(id + ': the answer had no observations');
    var obs = [], z = zFallback, name = id;
    raw.features.forEach(function (f) {
      var p = f && f.properties;
      if (!p || typeof p !== 'object') return;
      var ts = p.timestamp != null ? strtotime(p.timestamp) : false;
      if (ts === false || ts < now() - 8 * 3600) return;
      if (p.elevation && p.elevation.value != null && isNumeric(p.elevation.value)) z = Number(p.elevation.value);
      if (p.stationName) name = String(p.stationName).slice(0, 60);
      var t = p.temperature && p.temperature.value != null && isNumeric(p.temperature.value) ? round(Number(p.temperature.value), 1) : null;
      var slp = mtHpa(p.seaLevelPressure), stn = mtHpa(p.barometricPressure);
      if (slp === null && stn === null) return;
      obs.push({ t: ts, temp: t, slp: slp, stn: stn });
    });
    obs.sort(function (a, b) { return a.t - b.t; });
    return { id: id, name: name, z: z, obs: obs };
  }
  async function mtFetch() {
    var stations = [], errs = [], ids = Object.keys(cfg.metarStations);
    for (var i = 0; i < ids.length; i++) {
      try {
        var s = await mtStation(ids[i], Number(cfg.metarStations[ids[i]]));
        if (s.obs.length) stations.push(s); else errs.push(ids[i] + ': no pressure readings in the last 8 hours');
      } catch (e) { errs.push(e.message || String(e)); }
    }
    if (!stations.length) throw new Error(errs.join('; ') || 'no stations');
    return { format: FORMAT_MT, fetched: gmdateC(), source: 'NWS station observations', stations: stations };
  }
  var mtFlight = null;
  async function metar() {
    var rec = await kvGet('metar');
    if (rec && ageOf(rec) < cfg.metarTtl) return json(rec.v, 'hit');
    if (!mtFlight) mtFlight = mtFetch().finally(function () { mtFlight = null; });
    try { var out = await mtFlight; await kvSet('metar', out); return json(out, 'miss'); }
    catch (e) { if (rec) return json(rec.v, 'stale-error'); return fail(502, 'The observation service did not answer (' + (e.message || e) + ').'); }
  }

  /* ------------------------------------------------------------------ answers shaped like the PHP ones */
  function json(obj, state, status) {
    return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Cache': state || 'miss' } });
  }
  function fail(code, msg) {
    return new Response(JSON.stringify({ error: msg }), { status: code, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  // A newline-delimited JSON body that fills in while `run` works: run(send) calls send(event) for each line.
  function ndjson(run) {
    var enc = new TextEncoder();
    var body = new ReadableStream({
      start: function (controller) {
        var send = function (ev) { try { controller.enqueue(enc.encode(JSON.stringify(ev) + '\n')); } catch (e) {} };
        run(send).then(function () { try { controller.close(); } catch (e) {} }, function (e) { send({ type: 'error', message: (e && e.message) || String(e) }); try { controller.close(); } catch (x) {} });
      }
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Cache': 'miss-stream' } });
  }

  function direct() {
    if (cfg.direct === true) return true;
    if (cfg.direct === false) return false;
    return isNative();
  }
  // Drop-in for fetch(): answers api/<service>.php requests itself in direct mode, and is plain fetch() otherwise.
  function feedFetch(url, init) {
    var u = String(url), m = direct() ? u.match(/^(?:\.\/)?api\/(nws|autoroad|upperair|metar)\.php(?:\?(.*))?$/) : null;
    if (!m) return root.fetch(url, init);
    var q = new URLSearchParams(m[2] || '');
    switch (m[1]) {
      case 'nws': return nws(q, init);
      case 'autoroad': return autoroad();
      case 'upperair': return upperair(q);
      default: return metar();
    }
  }

  return {
    fetch: feedFetch, direct: direct, configure: configure, config: function () { return cfg; },
    // exposed for the tests
    _arSlim: arSlim, _slim: slim, _cellCenter: cellCenter, _mtHpa: mtHpa, _round: round, _strtotime: strtotime, _httpGet: httpGet,
    _kv: { get: kvGet, set: kvSet, clear: function () { mem = {}; } }, _isNumeric: isNumeric
  };
});
