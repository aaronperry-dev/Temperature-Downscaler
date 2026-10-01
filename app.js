(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var PEAKS = NH48;
  // The forecast, Auto Road, model-level and pressure requests go through Feeds (feeds.js). On a PHP server that is plain fetch() to api/*.php;
  // inside the Android app Feeds answers them itself, straight from the public services.
  var feedFetch = function (u, o) { return window.Feeds ? Feeds.fetch(u, o) : fetch(u, o); };
  var DIRECT = function () { return !!(window.Feeds && Feeds.direct()); };
  var LIVE_NAME = 'MWARVTP';      // what the live Auto Road series is called on screen
  var S = {
    peak: PEAKS[0], terrain: { z: PEAKS[0].m },
    nws: null, nwsExample: true, fcCustom: null, fcCustomExample: false, fc: null, fcSource: 'none', zOverride: null, zModel: null,
    method: 'consensus', gamma: 6.5, auto: true, damp: 0, speed: 1, bias: 0, imperial: true, tab: 'pk', win: 72, sort: 'ht',
    res: [], sum: null, cmp: [], ov: [],
    stn: null, stnPrep: null, stnExample: false, tgt: { lat: NaN, lon: NaN }, radius: 60, decay: 0.7,
    net: null, netPrep: null, netCache: {}, bandwidth: 30,
    clim: Core.CLIM_DEFAULT.slice(), climDiurnal: 1.0,
    weighting: 'regime', hourLabels: 'auto', hidden: {}, rw: null, regimes: [], lapseNet: [], ens: null,
    live: { on: true, hours: 6, tower: true, raw: null, status: 'idle', msg: '', stale: false, loading: false }, lv: null, deferDraw: false,
    ua: { on: true, byPeak: {}, errors: {}, loading: false }, pr: { raw: null, obs: null, anchor: null, status: 'idle', msg: '', stale: false, loading: false, at: null }, uaHour: 0
  };
  try { S.imperial = localStorage.getItem('sd-units') !== 'metric'; } catch (e) {}
  try { var su = JSON.parse(localStorage.getItem('sd-ua') || 'null'); if (su) S.ua.on = su.on !== false; } catch (e) {}
  try { var sl = JSON.parse(localStorage.getItem('sd-live') || 'null'); if (sl) { S.live.on = sl.on !== false; S.live.tower = sl.tower !== false; if ([3, 6, 9, 12].indexOf(sl.hours) >= 0) S.live.hours = sl.hours; } } catch (e) {}

  /* ---------- units and formatting ---------- */
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function tU(c) { return S.imperial ? c * 9 / 5 + 32 : c; }
  function dU(c) { return S.imperial ? c * 9 / 5 : c; }          // temperature difference
  function zUn(m) { return S.imperial ? m * 3.28084 : m; }
  function wU(k) { return S.imperial ? k / 1.609344 : k; }
  function lapseU(k) { return S.imperial ? k * 1.8 / 3.28084 : k; }  // K/km -> F per 1000 ft
  function lapseFromU(v) { return S.imperial ? v * 3.28084 / 1.8 : v; }
  function dist(km) { return S.imperial ? (km / 1.609344).toFixed(1) + ' mi' : km.toFixed(1) + ' km'; }
  function sgn(v, d) { var s = v.toFixed(d); return (v > 0 && +s !== 0 ? '+' : '') + s.replace('-', '−'); }
  function fT(c, d) {
    var s = tU(c).toFixed(d == null ? 0 : d);
    if (+s === 0) s = (0).toFixed(d == null ? 0 : d);   // never show "-0"
    return s.replace('-', '−');
  }
  function fZ(m) { return Math.round(zUn(m)).toLocaleString('en-US'); }
  function fW(k) { return String(Math.round(wU(k))); }
  var tUnit = function () { return S.imperial ? '°F' : '°C'; };
  var zUnit = function () { return S.imperial ? 'ft' : 'm'; };
  var wUnit = function () { return S.imperial ? 'mph' : 'km/h'; };
  var lUnit = function () { return S.imperial ? '°F/1000 ft' : 'K/km'; };
  function fDay(ms) { var d = new Date(ms); return DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]; }
  function fHour(ms) { var d = new Date(ms); return DAYS[d.getUTCDay()] + ' ' + String(d.getUTCHours()).padStart(2, '0') + ':00'; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function showMsg(id, text, kind) {
    var m = $(id); if (!text) { m.hidden = true; return; }
    m.hidden = false; m.className = 'msg' + (kind ? ' ' + kind : ''); m.textContent = text;
  }

  /* ---------- summit ---------- */
  function locate() {
    S.terrain = { z: S.peak.m };
    syncTarget(); reprepStations();
    S.netPrep = netPrepFor(S.peak);
  }

  /* ---------- the NWS forecasts of all summits as a station network ---------- */
  // One pseudo-station per distinct NWS grid cell: its elevation, its position and its hourly forecast temperature.
  function rebuildNet() {
    S.net = S.nws ? Core.buildNwsNetwork(S.nws, PEAKS) : null;
    S.rw = S.net ? Core.regionalWeather(S.net) : null;
    S.netCache = {};
    S.netPrep = netPrepFor(S.peak);
  }
  function netPrepFor(p) {
    if (!S.net || S.net.n < 2) return { error: 'The NWS network needs at least two grid cells.' };
    return S.netCache[p.id] || (S.netCache[p.id] = Core.networkTarget(S.net, p.lat, p.lon));
  }
  function netUsable(min) { return !!(S.net && S.net.n >= min && S.net.zMax - S.net.zMin >= 100 && S.netPrep && !S.netPrep.error); }
  function setPeak(p) {
    S.peak = p; $('peakSel').value = p.id; S.zOverride = null;
    S.fcCustom = null; S.fcCustomExample = false; $('fcText').value = ''; showMsg('fcMsg', '');
    S.stn = null; S.stnPrep = null; S.stnExample = false; $('stText').value = ''; showMsg('stMsg', '');
    locate(); recompute(); loadUpperAir(true);
  }

  function readFileAs(file, how) {
    return new Promise(function (res, rej) {
      var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = function () { rej(new Error('Could not read that file.')); };
      how === 'buf' ? r.readAsArrayBuffer(file) : r.readAsText(file);
    });
  }
  /* ---------- NWS forecast ---------- */
  function exampleStart() {
    var n = new Date(); return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
  }
  function loadExampleNws() {
    var pb = Core.parseNwsBundle(Core.exampleNwsBundle(PEAKS, exampleStart()));
    pb.example = true; S.nws = pb; S.nwsExample = true; rebuildNet();
  }
  function cellCount(pb) { var g = {}; Object.keys(pb.peaks).forEach(function (k) { if (pb.peaks[k].grid) g[pb.peaks[k].grid] = 1; }); return Object.keys(g).length; }
  // Accepts a bundle from fetch_nh48_nws.py or one raw /gridpoints response. Throws a readable Error on anything else.
  function applyNwsText(text) {
    var det = Core.detectNwsInput(text);
    if (det.kind === 'bundle') {
      var pb = Core.parseNwsBundle(det.obj);
      if (!pb.ok) throw new Error('That file has no usable forecast for any summit.' + (det.obj.peaks && Object.keys(det.obj.peaks).length ? ' Example error: ' + (pb.peaks[Object.keys(pb.peaks)[0]].error || '') : ''));
      pb.example = !!det.obj.example; S.nws = pb; S.nwsExample = pb.example; rebuildNet();
      return 'bundle';
    }
    if (det.kind === 'gridpoint') {
      var g = Core.parseNwsGrid(det.props, { tz: det.props.timeZone });
      if (!g.rows.length) throw new Error(g.warnings.join(' ') || 'That response holds no hourly data.');
      if (!S.nws || S.nwsExample) S.nws = { peaks: {}, ok: 0, failed: 0, generated: null, warnings: [], example: false };
      S.nws.peaks[S.peak.id] = { rows: g.rows, zModel: g.zModel, updateTime: g.updateTime, tz: g.tz, grid: 'pasted', warnings: g.warnings };
      S.nws.ok = Object.keys(S.nws.peaks).filter(function (k) { return S.nws.peaks[k].rows.length; }).length;
      S.nwsExample = false; rebuildNet();
      return 'gridpoint';
    }
    throw new Error('That is neither a file written by fetch_nh48_nws.py nor a /gridpoints response from api.weather.gov.');
  }
  function afterNwsChange(kind) {
    S.zOverride = null;
    recompute();
    var np = S.nws.peaks[S.peak.id];
    if (kind === 'gridpoint') showMsg('nwsMsg', 'Loaded the pasted response for ' + S.peak.name + '.', np && np.warnings && np.warnings.length ? 'warn' : '');
    else showMsg('nwsMsg', S.nwsExample ? '' : S.nws.ok + ' of ' + Object.keys(S.nws.peaks).length + ' summits loaded' + (S.nws.failed ? '; ' + S.nws.failed + ' had no forecast (see the table).' : '.'), S.nws.failed ? 'warn' : '');
  }
  /* ---------- forecast from the PHP service (or, in the Android app, straight from NWS through feeds.js) ---------- */
  var API_URL = 'api/nws.php';

  /* ---------- API call log (the pop-up) ---------- */
  var LOG = { has: false, pDone: 0, pTotal: 0, gDone: 0, gTotal: 0, phase: 'points', calls: 0, fails: 0, retries: 0, timer: null };
  var retryable = function (s) { return s === 0 || s === 429 || s >= 500; };
  function logShow(v) { clearTimeout(LOG.timer); $('calls').hidden = !v; }
  function logAdd(li) {
    var ol = $('callsList'), near = ol.scrollHeight - ol.scrollTop - ol.clientHeight < 40;
    ol.append(li);
    if (near) ol.scrollTop = ol.scrollHeight;    // follow the newest call unless the reader scrolled up
  }
  function logProgress() {
    var g = LOG.phase === 'grids', done = g ? LOG.gDone : LOG.pDone, total = g ? LOG.gTotal : LOG.pTotal;
    var pct = total ? Math.min(100, Math.round(done / total * 100)) : 0;
    $('callsFill').style.width = pct + '%'; $('callsBar').setAttribute('aria-valuenow', String(pct));
    $('callsCount').textContent = done + ' / ' + total;
  }
  function logBegin(quiet) {
    clear($('callsList'));
    LOG = { has: true, pDone: 0, pTotal: 0, gDone: 0, gTotal: 0, phase: 'points', calls: 0, fails: 0, retries: 0, timer: null };
    $('calls').className = 'calls';
    $('callsStatus').textContent = 'Starting.'; $('callsCount').textContent = ''; $('callsFill').style.width = '0%';
    $('nwsLogBtn').hidden = false;
    logShow(!quiet);
  }
  function logSection(text) { logAdd(el('li', 'call sec', text)); }
  function logEvent(ev) {
    if (ev.type === 'start') {
      LOG.phase = 'points'; LOG.pTotal = ev.total;
      $('callsStatus').textContent = 'Looking up the forecast grid cell for each of ' + ev.total + ' summits.';
      logSection('Step 1: find the grid cell for each summit'); logProgress();
    } else if (ev.type === 'phase') {
      LOG.phase = 'grids'; LOG.gTotal = ev.total;
      $('callsStatus').textContent = 'Downloading ' + ev.total + ' grid-cell forecasts. Nearby summits share a cell.';
      logSection('Step 2: download the forecast for ' + ev.total + ' grid cell' + (ev.total === 1 ? '' : 's')); logProgress();
    } else if (ev.type === 'wait') {
      logAdd(el('li', 'call wait', 'Waiting ' + ev.seconds + ' s, then retrying ' + ev.count + ' call' + (ev.count === 1 ? '' : 's') + '.'));
    } else if (ev.type === 'call') {
      var fin = ev.attempt >= 4 || !retryable(ev.status), ok = ev.status >= 200 && ev.status < 300;
      LOG.calls++; if (ev.attempt > 1) LOG.retries++;
      if (fin) { if (ev.phase === 'grids') LOG.gDone++; else LOG.pDone++; if (!ok) LOG.fails++; }
      var li = el('li', 'call'), name = el('span', 'cn', ev.label || ev.path);
      if (ev.attempt > 1) name.append(el('span', 'tag', 'retry ' + (ev.attempt - 1)));
      li.append(name,
        el('span', 'pill ' + (ok ? 'ok' : ev.status >= 400 && ev.status < 500 ? 'warn' : 'bad'), ev.status ? String(ev.status) : 'no response'),
        el('span', 'ms', ev.ms + ' ms'),
        el('span', 'p', (ev.method || 'GET') + ' ' + ev.path));
      if (ev.for && ev.for.length) li.append(el('span', 'for', 'For ' + ev.for.join(', ')));
      else if (!ok && ev.status === 0 && ev.error) li.append(el('span', 'for', ev.error));
      logAdd(li); logProgress();
    }
  }
  function logDone(ev) {
    var c = $('calls'); c.className = 'calls done';
    $('callsFill').style.width = '100%'; $('callsBar').setAttribute('aria-valuenow', '100');
    var t = 'Done. ' + ev.ok + ' of ' + ev.total + ' summits have a forecast, from ' + ev.cells + ' grid cell' + (ev.cells === 1 ? '' : 's') + '.';
    if (ev.state === 'stale-error') { c.className = 'calls err'; t = 'NWS did not answer. Showing the last saved forecast.'; }
    else if (LOG.fails) t += ' ' + LOG.fails + ' call' + (LOG.fails === 1 ? '' : 's') + ' failed.';
    $('callsStatus').textContent = t;
    logAdd(el('li', 'call sec', t));
    if (!c.hidden && !LOG.fails && ev.state !== 'stale-error') LOG.timer = setTimeout(function () { logShow(false); }, 7000);   // tidy up after a clean pull; hovering keeps it
  }
  function logFail(msg) {
    if (!LOG.has) return;
    $('calls').className = 'calls err';
    $('callsStatus').textContent = 'Stopped: ' + msg;
    logAdd(el('li', 'call bad', msg));
  }
  $('callsX').onclick = function () { logShow(false); };
  $('nwsLogBtn').onclick = function () { logShow(true); $('callsList').scrollTop = $('callsList').scrollHeight; };
  $('calls').addEventListener('pointerenter', function () { clearTimeout(LOG.timer); });
  $('calls').addEventListener('focusin', function () { clearTimeout(LOG.timer); });
  $('calls').addEventListener('keydown', function (e) { if (e.key === 'Escape') { logShow(false); $('nwsRefresh').focus(); } });

  // Reads a newline-delimited JSON body and calls onEvent for each line as it arrives.
  async function readStream(res, onEvent) {
    var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
    function flush(final) {
      var nl;
      while ((nl = buf.indexOf('\n')) >= 0) { var line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) onEvent(JSON.parse(line)); }
      if (final && buf.trim()) { var last = buf; buf = ''; onEvent(JSON.parse(last)); }
    }
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      flush(false);
    }
    buf += dec.decode(); flush(true);
  }

  var LOADING = false;
  // quiet = a background refresh: the call log fills in but does not pop up.
  async function loadFromServer(force, quiet) {
    if (LOADING) return;
    LOADING = true;
    var btn = $('nwsRefresh'); btn.disabled = true;
    var haveReal = !!(S.nws && !S.nwsExample), streamed = false;
    if (!quiet) showMsg('nwsMsg', force ? 'Asking NWS for a fresh forecast. This can take up to a minute.' : 'Loading the forecast. The first load after a pause can take up to a minute.');
    try {
      var res = await feedFetch(API_URL + '?stream=1' + (force ? '&refresh=1' : ''), { cache: 'no-store' });
      var ctype = res.headers.get('Content-Type') || '';
      if (res.ok && /ndjson/i.test(ctype) && res.body && res.body.getReader) {
        // The server is pulling from NWS right now and reports each call as it finishes.
        streamed = true; logBegin(!!quiet);
        var result = null;
        await readStream(res, function (ev) {
          if (ev.type === 'error') throw new Error(ev.message);
          if (ev.type === 'result') result = ev; else logEvent(ev);
        });
        if (!result) throw new Error('The connection closed before the forecast finished.');
        logDone(result);
        var k = applyNwsText(JSON.stringify(result.bundle));
        afterNwsChange(k);
        if (result.state === 'stale-error') showMsg('nwsMsg', 'NWS did not answer, so this is the last saved forecast.', 'warn');
        return;
      }
      var text = await res.text();
      if (!res.ok) {
        var j = null; try { j = JSON.parse(text); } catch (e) {}
        throw new Error((j && j.error) || 'The forecast service answered ' + res.status + '.');
      }
      if (/<\?php/.test(text.slice(0, 300))) throw new Error('The server sent back the PHP source instead of running it. Serve this folder with PHP (php -S localhost:8080) or with serve.py, not with python -m http.server.');
      if (/^\s*</.test(text)) throw new Error('The server answered with a web page instead of forecast data. Check that api/nws.php is reachable at this address.');
      var kind = applyNwsText(text);
      afterNwsChange(kind);
      var st = res.headers.get('X-Cache');
      if (force && st === 'hit-throttled') showMsg('nwsMsg', 'The server pulled a forecast a few minutes ago, so this is that copy. No new NWS calls were made.');
      else if (st === 'stale-error') showMsg('nwsMsg', 'NWS did not answer, so this is the last saved forecast.', 'warn');
    } catch (e) {
      if (streamed) logFail(e.message);
      showMsg('nwsMsg', 'Could not load the forecast from ' + (DIRECT() ? 'the National Weather Service' : API_URL) + '. ' + e.message + (haveReal ? ' The forecast already on screen is unchanged.' : ' Showing example data.'), 'err');
    } finally { btn.disabled = false; LOADING = false; }
  }

  async function onNwsFile(file) {
    if (!file) return;
    showMsg('nwsMsg', 'Reading ' + file.name + '…');
    try {
      var text = await readFileAs(file, 'text');
      var kind = applyNwsText(text);
      afterNwsChange(kind);
    } catch (e) { showMsg('nwsMsg', e.message, 'err'); }
  }
  function nwsPeak() { return S.nws && S.nws.peaks[S.peak.id]; }
  function fStamp(iso, tz) {
    var d = new Date(Core.wallMs(Date.parse(iso), tz || 'America/New_York'));
    return DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  }
  function renderSource() {
    var pb = S.nws, info = $('srcInfo'), tag = $('srcTag');
    tag.hidden = !S.nwsExample;
    if (!pb) { info.textContent = ''; return; }
    if (S.nwsExample) {
      info.textContent = 'These are invented numbers in the shape of a real NWS pull, so the page has something to show. They are not a forecast. Use Refresh forecast for the real thing.';
      return;
    }
    var txt = pb.ok + ' of ' + Object.keys(pb.peaks).length + ' summits have a forecast, from ' + cellCount(pb) + ' NWS grid cell' + (cellCount(pb) === 1 ? '' : 's') + '.';
    if (pb.generated) {
      txt += ' Pulled ' + fStamp(pb.generated) + ' Eastern.';
      var age = (Date.now() - Date.parse(pb.generated)) / 3600e3;
      if (age >= 12) txt += ' That was ' + (age < 48 ? Math.round(age) + ' hours' : Math.round(age / 24) + ' days') + ' ago; run the script again for a fresh forecast.';
    }
    info.textContent = txt;
  }

  /* ---------- effective forecast for the selected summit ---------- */
  function colsOf(rows) {
    var has = function (k) { return rows.some(function (r) { return r[k] != null; }); };
    return { rh: has('rh'), wind: has('wind'), cloud: has('cloud'), precip: has('precip'), levels: has('lev'), thickness: has('lev'), pressure: has('mslp') };
  }
  function windowRows(rows) { return S.win >= 9999 ? rows : rows.slice(0, S.win); }
  function buildFc() {
    var np = nwsPeak(), src = null;
    if (S.fcCustom) { src = S.fcCustom; S.fcSource = 'custom'; }
    else if (np && np.rows && np.rows.length) { var ua0 = uaData(), rws = ua0 ? Core.attachUpperAir(np.rows, ua0, S.pr.anchor) : np.rows; src = { rows: rws, cols: colsOf(rws) }; S.fcSource = 'nws'; }
    else S.fcSource = 'none';
    S.fc = src ? { rows: windowRows(src.rows), cols: src.cols } : null;
  }
  function modelZ() {
    if (S.zOverride != null) return S.zOverride;
    var np = nwsPeak();
    return np && np.zModel != null ? np.zModel : null;
  }
  var cellWord = function () { return S.fcSource === 'nws' ? 'NWS cell' : 'Model cell'; };

  /* ---------- custom forecast (CSV) ---------- */
  function loadExampleForecast() {
    var zM = S.zModel != null ? S.zModel : 1120;
    $('fcText').value = Core.exampleForecastCsv(exampleStart(), zM);
    S.fcCustomExample = true; parseForecastText();
  }
  function parseForecastText() {
    var txt = $('fcText').value;
    if (!txt.trim()) { S.fcCustom = null; S.fcCustomExample = false; showMsg('fcMsg', ''); if (S.stn) parseStationText(); else recompute(); return; }
    var f = Core.parseForecast(txt);
    S.fcCustom = f.rows.length ? f : null;
    showMsg('fcMsg', f.warnings.length ? f.warnings.join(' ') : (f.rows.length ? f.rows.length + ' hours read; they replace the NWS forecast for this summit. Columns: temperature' +
      (f.cols.wind ? ', wind' : '') + (f.cols.rh ? ', humidity' : '') + (f.cols.cloud ? ', cloud' : '') + (f.cols.precip ? ', precipitation' : '') + (f.cols.levels ? ', upper level' : f.cols.thickness ? ', upper level height' : '') + (f.cols.pressure ? ', pressure' : '') + '.' : ''),
      f.rows.length ? (f.warnings.length ? 'warn' : '') : 'err');
    if (S.stn) parseStationText(); else recompute();
  }

  /* ---------- stations (BCDG) ---------- */
  function loadExampleStations() {
    var zM = S.zModel != null ? S.zModel : 1120;
    $('stText').value = Core.exampleStationsCsv(exampleStart(), zM);
    S.stnExample = true; parseStationText();
  }
  function syncTarget() {
    S.tgt = { lat: S.peak.lat, lon: S.peak.lon };
    $('tgtLat').value = S.tgt.lat.toFixed(4); $('tgtLon').value = S.tgt.lon.toFixed(4);
    $('tgtRow').hidden = !(S.stn && S.stn.mode === 'latlon');
  }
  function reprepStations() {
    if (!S.stn || S.stn.stations.length < 2 || !S.stn.mode) return;
    S.stnPrep = Core.prepareBcdg(S.stn, S.tgt);
  }
  function parseStationText() {
    if (!$('stText').value.trim()) { S.stn = null; S.stnPrep = null; S.stnExample = false; showMsg('stMsg', ''); syncTarget(); recompute(); return; }
    var st = Core.parseStations($('stText').value);
    S.stn = st; S.stnPrep = null;
    $('tgtRow').hidden = !(st.mode === 'latlon');
    if (st.stations.length >= 2 && st.mode) S.stnPrep = Core.prepareBcdg(st, S.tgt);
    var prep = S.stnPrep, msg = '', kind = '';
    buildFc();
    if (prep && prep.error) { msg = prep.error; kind = 'warn'; }
    else if (prep) {
      var cover = S.fc ? S.fc.rows.filter(function (r) { return prep.byTime[r.t]; }).length : null;
      msg = st.stations.length + ' stations, ' + st.hours + ' hours. Nearest ' + prep.nearestKm.toFixed(1) + ' km, farthest ' + prep.farthestKm.toFixed(1) + ' km from the summit.' +
        (cover != null ? ' ' + cover + ' of ' + S.fc.rows.length + ' forecast hours have station data.' : '') + (st.warnings.length ? ' ' + st.warnings.join(' ') : '');
      if (cover === 0) kind = 'warn';
    } else { msg = st.warnings.join(' '); kind = 'warn'; }
    showMsg('stMsg', msg, kind);
    recompute();
  }


  /* ---------- methods and recompute ---------- */
  var NEED_NET = 'Needs a forecast pull with three or more NWS grid cells at different elevations. Use Refresh forecast on the All 48 tab.';
  var G_CELL = 'Lapse rate from this summit’s forecast cell', G_EXTRA = 'Needs extra inputs (custom forecast)',
      G_NET = 'Uses all 48 summits’ NWS forecasts as stations', G_OWN = 'Uses your own stations', G_ALL = 'Combined';
  var METHODS = [
    { id: 'fixed', group: G_CELL, name: 'Fixed lapse', short: 'Fixed', desc: function () { return 'One cooling rate, ' + lapseU(S.gamma).toFixed(1) + ' ' + lUnit() + ', for every hour.'; } },
    { id: 'conditions', group: G_CELL, name: 'Conditions', short: 'Conditions', desc: function () { return 'A rate chosen each hour from humidity, precipitation, cloud, wind and time of day.'; } },
    { id: 'adiabatic', group: G_CELL, name: 'Adiabatic parcel', short: 'Adiabatic', desc: function () { return 'Lifts the cell’s air to the summit: dry adiabatic (' + lapseU(Core.GAMMA_D * 1000).toFixed(1) + ' ' + lUnit() + ') up to its condensation level, moist adiabatic above. The steepest cooling that lifted air can show.'; }, need: 'Needs humidity (rh_pct) in a custom forecast.' },
    { id: 'climatology', group: G_CELL, name: 'Monthly climatology', short: 'Climatology', desc: function () { return 'The month’s typical cooling rate (table on Setup), steeper by day and weaker at night. Ignores the weather.'; } },
    { id: 'levels', group: G_EXTRA, name: 'Levels', short: 'Levels', desc: function () { return S.fcSource === 'nws' ? 'Interpolates in height between the NWS cell and the model’s pressure level nearest the summit.' : 'Interpolates between the model cell and an upper-level temperature.'; }, need: 'Needs the model pressure levels (loaded from api/upperair.php) or t_upper_c and z_upper_m in a custom forecast.' },
    { id: 'hypsometric', group: G_EXTRA, name: 'Hypsometric', short: 'Hypsometric', desc: function () { return S.fcSource === 'nws' ? 'The model’s 950–700 hPa heights and temperatures put the summit in a pressure layer (hypsometric equation); the NWS cell’s own difference from the model is carried up and fades with height.' : 'Uses the model pressure and the height of an upper level to get the layer-mean virtual temperature, then the lapse rate that fits it.'; }, need: 'Needs the model pressure levels (loaded from api/upperair.php) or z_upper_m in a custom forecast.' },
    { id: 'bcdg', group: G_NET, name: 'BCDG · NWS forecasts', short: 'BCDG NWS', desc: function () { return 'The gridded-MOS analysis run on the NWS grid cells: each cell’s temperature moved to the summit with the lapse rate the cells imply, then corrected in five passes.'; }, need: NEED_NET },
    { id: 'regression', group: G_NET, name: 'Elevation regression', short: 'Regression', desc: function () { return 'One straight line through every cell’s elevation and temperature each hour, read at the summit height.'; }, need: NEED_NET },
    { id: 'wlr', group: G_NET, name: 'Local regression', short: 'Local reg.', desc: function () { return 'The same line fitted locally: cells count more the nearer they are and the closer their elevation is to the summit’s (the PRISM idea).'; }, need: NEED_NET },
    { id: 'gids', group: G_NET, name: 'GIDS', short: 'GIDS', desc: function () { return 'Gradient plus inverse distance squared: fits temperature to position and elevation over all cells, moves each cell to the summit, then averages with 1/d² weights.'; }, need: 'Needs five or more NWS grid cells at different elevations. Use Refresh forecast on the All 48 tab.' },
    { id: 'bcdgcsv', group: G_OWN, name: 'BCDG · your stations', short: 'BCDG CSV', desc: function () { return 'The same analysis on station temperatures you paste on the Setup tab.'; }, need: 'Needs two or more stations with different elevations.' },
    { id: 'consensus', group: G_ALL, name: 'Most likely', short: 'Most likely', desc: function () { return S.weighting === 'regime' ? 'The middle of all the methods, weighted by how well the cooling rate each implies fits the regional weather regime and the rate the NWS cells show.' : 'The plain median of every method available, hour by hour.'; } }
  ];
  function avail() {
    var f = S.fc;
    return { fixed: true, conditions: true, adiabatic: !!(f && f.cols.rh), climatology: true, levels: !!(f && f.cols.levels), hypsometric: !!(f && f.cols.thickness),
      bcdg: netUsable(3), regression: netUsable(3), wlr: netUsable(3), gids: netUsable(5),
      bcdgcsv: !!(S.stnPrep && !S.stnPrep.error), consensus: true };
  }
  function methodName(id) { return METHODS.filter(function (m) { return m.id === id; })[0].name; }
  function renderMethods() {
    var host = clear($('methods')), av = avail(), lastGroup = null;
    METHODS.forEach(function (m) {
      if (m.group !== lastGroup) { var gl = el('div', 'mgroup', m.group); gl.setAttribute('role', 'presentation'); host.append(gl); lastGroup = m.group; }
      var b = el('button', 'opt'); b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(S.method === m.id)); b.disabled = !av[m.id];
      b.append(el('span', 'n', m.name), el('span', 'd', av[m.id] || !m.need ? m.desc() : m.need));
      b.onclick = function () { setMethod(m.id); };
      host.append(b);
    });
  }
  function setMethod(m) { S.method = m; recompute(); }
  // The summit adjustments that make sense for a method: the diurnal-swing removal only applies to methods whose rate is prescribed.
  function effectiveFor(method) { return { damping: Core.PRESCRIBED[method] ? S.damp : 0, speedUp: S.speed }; }
  function optsFor(method, np) {
    var ef = effectiveFor(method);
    var o = { zModel: np ? np.zModel : S.zModel, zSummit: np ? np.z : S.terrain.z, method: method, gamma: S.gamma, damping: ef.damping, speedUp: ef.speedUp, bias: S.bias,
      clim: S.clim, climDiurnal: S.climDiurnal, net: { prep: np ? np.prep : S.netPrep, bandwidthKm: S.bandwidth } };
    o.bcdg = { prep: method === 'bcdgcsv' ? S.stnPrep : o.net.prep, radiusKm: S.radius, decay: S.decay, passes: 5 };
    return o;
  }
  function runMethod(method, consensusRaw) {
    var o = optsFor(method); o.consensusRaw = consensusRaw;
    return Core.downscale(S.fc.rows, o);
  }
  function cmpEntry(m, res) {
    var d = res.map(function (o) { return o.tSummit - o.tModel; });
    return { id: m.id, name: m.name, short: m.short, res: res, sum: Core.summarize(res), used: res.filter(function (o) { return o.source === m.id; }).length,
      dMin: Math.min.apply(null, d), dMax: Math.max.apply(null, d) };
  }
  // Measured pressure change over 6 h at each forecast hour, when the forecast carries mslp_hpa or p_sfc_hpa (a custom forecast); else null.
  function pressureTendency(rows) {
    var p = rows.map(function (r) { return r.mslp != null ? r.mslp : r.pSfc != null ? r.pSfc : null; }), n = rows.length;
    return rows.map(function (_, i) {
      var j0 = Math.max(0, i - 3), j1 = Math.min(n - 1, i + 3);
      return j1 > j0 && p[j0] != null && p[j1] != null ? (p[j1] - p[j0]) * 6 / (j1 - j0) : null;
    });
  }
  // Regime and cell-implied lapse rate for every forecast hour, from the regional weather of the NWS network.
  function buildRegimes() {
    var rows = S.fc.rows, pt = pressureTendency(rows), ob = S.pr.obs && S.pr.obs.ok && S.pr.obs.tend3 != null ? S.pr.obs : null;
    if (ob) {   // a measured change beats the model's for the hours around the observation
      var tw = Core.wallMs(ob.t, nwsTz());
      rows.forEach(function (r, i) { if (Math.abs(r.t - tw) <= 3 * 3600e3) pt[i] = ob.tend3 * 2; });
    }
    S.regimes = rows.map(function (r, i) { return Core.classifyRegime(S.rw && S.rw.byTime[r.t], new Date(r.t).getUTCHours(), pt[i]); });
    S.lapseNet = rows.map(function (r) { return S.net && S.net.byTime[r.t] ? Core.regionalLapse(S.net, S.net.byTime[r.t]) : null; });
  }
  function recompute() {
    buildPressure();
    buildFc();
    S.zModel = modelZ();
    S.netPrep = netPrepFor(S.peak);
    var av = avail();
    if (!av[S.method]) S.method = 'conditions';
    var ef = effectiveFor(S.method);
    $('damp').value = S.damp; $('speed').value = ef.speedUp;
    $('damp').disabled = !Core.PRESCRIBED[S.method];
    $('dampNote').textContent = Core.PRESCRIBED[S.method] ? '' : 'The ' + methodName(S.method) + ' method already carries the real daily cycle, so this adjustment is off for it.';
    $('gamma').disabled = S.method !== 'fixed';
    var pbtn = $('presetRow').querySelectorAll('button');
    pbtn[0].textContent = 'Standard atmosphere ' + lapseU(6.5).toFixed(1); pbtn[1].textContent = 'Dry adiabatic ' + lapseU(9.8).toFixed(1);
    pbtn.forEach(function (b) { b.disabled = S.method !== 'fixed'; });
    if (document.activeElement !== $('gamma')) $('gamma').value = S.gamma;
    $('gammaVal').textContent = lapseU(S.gamma).toFixed(1) + ' ' + lUnit();
    $('dampVal').textContent = Math.round(S.damp * 100) + '%';
    $('speedVal').textContent = '×' + ef.speedUp.toFixed(2);
    $('biasVal').textContent = sgn(dU(S.bias), 1) + ' ' + tUnit();
    $('radiusVal').textContent = Math.round(S.radius) + ' km';
    $('decayVal').textContent = '×' + S.decay.toFixed(2);
    $('bandwidthVal').textContent = Math.round(S.bandwidth) + ' km';
    $('zModelLab').textContent = 'Grid-cell elevation (' + zUnit() + ')';
    renderMethods(); renderClim();
    S.res = []; S.sum = null; S.cmp = []; S.ens = null; S.lv = null;
    if (S.fc && S.zModel != null) {
      METHODS.forEach(function (m) { if (m.id !== 'consensus' && av[m.id]) S.cmp.push(cmpEntry(m, runMethod(m.id))); });
      buildRegimes();
      // percentiles and the most-likely value across the methods; the constant bias is taken out and added back once by the consensus run
      S.ens = Core.ensemble(S.cmp.map(function (c) { return { id: c.id, res: c.res }; }), { mode: S.weighting, regimes: S.regimes, lapse: S.lapseNet, dzKm: (S.terrain.z - S.zModel) / 1000 });
      buildLive();
      var shift = S.lv && S.lv.ok && S.lv.applied ? S.lv.adj.shift : null;
      S.cmp.push(cmpEntry(METHODS[METHODS.length - 1], runMethod('consensus', S.ens.hours.map(function (h, i) { return h.ml + (shift ? shift[i] : 0) - S.bias; }))));
      var cur = S.cmp.filter(function (c) { return c.id === S.method; })[0] || S.cmp.filter(function (c) { return c.id === 'conditions'; })[0];
      S.method = cur.id; S.res = cur.res; S.sum = cur.sum;
    }
    renderSetupBits(); renderNetwork(); renderSource(); renderStrip(); renderForecast(); renderOverview();
    $('fcTag').hidden = !(S.fcCustom && S.fcCustomExample); $('stTag').hidden = !(S.stn && S.stnExample);
  }

  /* ---------- monthly climatology table ---------- */
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function buildClim() {
    var host = clear($('climGrid'));
    MON.forEach(function (m, i) {
      var f = el('div', 'field'), lab = el('label', '', m), inp = document.createElement('input');
      lab.htmlFor = 'clim' + i; inp.type = 'number'; inp.id = 'clim' + i; inp.step = '0.1'; inp.setAttribute('inputmode', 'decimal');
      inp.oninput = function () { var v = parseFloat(this.value); if (isFinite(v)) { S.clim[i] = lapseFromU(v); recompute(); } };
      f.append(lab, inp); host.append(f);
    });
  }
  function renderClim() {
    MON.forEach(function (m, i) { var inp = $('clim' + i); if (document.activeElement !== inp) inp.value = lapseU(S.clim[i]).toFixed(1); });
    $('climUnit').textContent = lUnit();
    if (document.activeElement !== $('climDiurnal')) $('climDiurnal').value = S.climDiurnal;
    $('climDiurnalVal').textContent = '±' + lapseU(S.climDiurnal).toFixed(1) + ' ' + lUnit();
  }

  /* ---------- the NWS network card ---------- */
  function renderNetwork() {
    var n = S.net, msg = $('netMsg'), tb = clear($('netTbl'));
    if (!n || n.n < 2) { showMsg('netMsg', 'No NWS forecast is loaded, so there is no station network yet. Use Refresh forecast on the All 48 tab.', 'warn'); return; }
    var pr = S.netPrep;
    var t0 = S.fc && S.fc.rows.length ? S.fc.rows[0].t : null, arr = t0 != null ? n.byTime[t0] : null;
    var lap = arr ? Core.bcdgLapse(n.z, arr) : null;
    var txt = n.n + ' NWS grid cell' + (n.n === 1 ? '' : 's') + ' from ' + Object.keys(S.nws.peaks).filter(function (k) { return S.nws.peaks[k].rows && S.nws.peaks[k].rows.length; }).length + ' summits, at ' +
      fZ(n.zMin) + ' to ' + fZ(n.zMax) + ' ' + zUnit() + '. ' + (pr && !pr.error ? 'Nearest to ' + S.peak.name + ': ' + dist(pr.nearestKm) + '. ' : '') +
      (lap && lap.gamma != null ? 'At the first forecast hour the cells imply a cooling rate of ' + lapseU(lap.gamma).toFixed(1) + ' ' + lUnit() + '. ' : '') +
      (S.nwsExample ? 'This is the invented example forecast, built with a steady lapse rate, so these methods agree closely. ' : '') +
      (n.n < 3 || n.zMax - n.zMin < 100 ? 'The spatial methods need at least three cells that differ in elevation by 100 m or more.' : '');
    showMsg('netMsg', txt.trim(), n.n < 3 ? 'warn' : '');
    if (!pr || pr.error) return;
    var order = n.cells.map(function (c, i) { return i; }).sort(function (a, b) { return pr.dTarget[a] - pr.dTarget[b]; });
    var head = ['Grid cell (summits)', 'Elev ' + zUnit(), 'Distance'], thead = el('thead'), hr = el('tr');
    head.forEach(function (h) { hr.append(el('th', '', h)); }); thead.append(hr); tb.append(thead);
    var body = el('tbody');
    order.forEach(function (i) {
      var c = n.cells[i], tr = el('tr', c.ids.indexOf(S.peak.id) >= 0 ? 'sel' : '');
      var first = el('td', '', c.names.join(', ')); first.style.whiteSpace = 'normal'; first.style.minWidth = '150px';
      tr.append(first, el('td', '', fZ(c.z)), el('td', '', dist(pr.dTarget[i])));
      body.append(tr);
    });
    tb.append(body);
  }

  function renderSetupBits() {
    var np = nwsPeak(), z = $('zModel');
    if (document.activeElement !== z) z.value = S.zModel == null ? '' : Math.round(zUn(S.zModel));
    var nz = np && np.zModel != null ? np.zModel : null;
    $('zNws').hidden = nz == null; $('zNws').disabled = S.zOverride == null;
    $('zNote').textContent = (nz != null ? 'The NWS grid cell for ' + S.peak.name + ' is at ' + fZ(nz) + ' ' + zUnit() + '. ' : 'There is no NWS cell elevation for this summit. ') +
      'Model terrain is smoothed, so it usually sits well below the summit. Changing this affects the Forecast tab only.';
  }

  /* ---------- strip / summary ---------- */
  function renderStrip() {
    var s = clear($('strip')), t = S.terrain, zm = S.zModel;
    var add = function (label, val) { var sp = el('span'); sp.append(label + ' '); sp.append(el('b', '', val)); s.append(sp); };
    add('Summit', fZ(t.z) + ' ' + zUnit());
    if (zm != null) {
      var d = t.z - zm;
      add(cellWord(), fZ(zm) + ' ' + zUnit());
      add('Difference', (d >= 0 ? '+' : '−') + fZ(Math.abs(d)) + ' ' + zUnit());
    }
    if (S.lv && S.lv.ok) add(LIVE_NAME, fClock(S.lv.tMs) + (S.lv.applied ? '' : ' (off)'));
    var np = nwsPeak();
    if (S.fcSource === 'custom' && S.fcCustomExample || S.fcSource === 'nws' && S.nwsExample) s.append(el('span', 'tag', 'Example data'));
    else if (S.fcSource === 'custom') s.append(el('span', 'tag', 'Custom forecast'));
    else if (S.fcSource === 'nws' && np && np.updateTime) add('NWS updated', fStamp(np.updateTime, np.tz));
  }

  function renderForecast() {
    var lede = $('lede'), stats = clear($('stats'));
    $('fcTitle').textContent = S.peak.name;
    $('fcSub').textContent = '#' + S.peak.rank + ' of 48 · ' + fZ(S.terrain.z) + ' ' + zUnit() + ' · times are Eastern local';
    if (!S.sum) {
      var np = nwsPeak();
      lede.textContent = S.zModel == null && S.fc ? 'This forecast has no model elevation. Enter one on the Setup tab.' :
        'There is no forecast for this summit yet. ' + (np && np.error ? np.error + ' ' : '') + 'Load an NWS file on the All 48 tab.';
      destroyCharts();
      ['chart1', 'chart2', 'chartReg1', 'chartReg2', 'chartLive', 'chartLiveTrend', 'chartUA', 'chartUAp', 'tbl', 'cmp', 'regTbl', 'liveLede', 'liveFacts', 'liveTbl', 'uaTbl'].forEach(function (i) { clear($(i)); });
      $('liveLine').hidden = true;
      ['freezeNote', 'cmpNote', 'fbNote', 'pNote', 'likelyNote', 'regText', 'liveNote', 'liveTrendNote', 'uaLede', 'uaNote'].forEach(function (i) { $(i).textContent = ''; });
      return;
    }
    var m = S.sum, cold = m.meanDelta < 0, fb = S.res.filter(function (o) { return o.source !== S.method; }).length;
    lede.textContent = '';
    var b = el('b', '', Math.abs(dU(m.meanDelta)).toFixed(1) + ' ' + tUnit() + (cold ? ' colder' : ' warmer'));
    lede.append('The summit runs ', b, ' than the ' + (S.fcSource === 'nws' ? 'NWS grid cell' : 'model cell') + ' on average (' + methodName(S.method) + ', mean lapse ' + lapseU(m.meanGamma).toFixed(1) + ' ' + lUnit() + '). ' +
      (m.below ? 'It sits at or below freezing for ' + m.below + ' of ' + m.hours + ' hours.' : 'It stays above freezing for all ' + m.hours + ' hours.') +
      (fb ? ' ' + fb + ' hour' + (fb > 1 ? 's use' : ' uses') + ' the Conditions rate because this method’s inputs are missing for ' + (fb > 1 ? 'them' : 'it') + '.' : ''));
    function stat(k, v, unit, sub) {
      var d = el('div', 'stat'); d.append(el('div', 'k', k));
      var vv = el('div', 'v', v); if (unit) { var u = el('small', '', ' ' + unit); vv.append(u); }
      d.append(vv); if (sub) d.append(el('div', 's', sub)); stats.append(d);
    }
    stat('Low', fT(m.lo.tSummit, 1), tUnit(), fHour(m.lo.t));
    stat('High', fT(m.hi.tSummit, 1), tUnit(), fHour(m.hi.t));
    if (m.maxWind && S.fc.cols.wind) stat('Coldest feels-like', fT(m.minFeels.feels, 0), tUnit(), fHour(m.minFeels.t));
    else stat('Hours ≤ 0 ' + tUnit(), String(m.below), 'of ' + m.hours, '');
    if (m.maxWind && S.fc.cols.wind) stat('Peak wind', fW(m.maxWind.wSummit), wUnit(), fHour(m.maxWind.t));
    else stat('Mean lapse', lapseU(m.meanGamma).toFixed(1), lUnit(), '');
    renderLikelyNote(); renderLive(); renderUA(); renderRegional(); renderComparison(); renderTable();
    if (S.tab === 'fc' && !(S.deferDraw && chartsZoomed())) drawCharts();
  }

  // What the highlighted line means, and which methods the regional weather favours.
  function renderLikelyNote() {
    var lk = S.cmp.filter(function (c) { return c.id === 'consensus'; })[0], sm = lk.sum, e = S.ens, i;
    var widest = 0, w80 = 0;
    e.hours.forEach(function (h) { widest = Math.max(widest, h.max - h.min); w80 = Math.max(w80, h.p90 - h.p10); });
    var top = Object.keys(e.meanWeight).filter(function (k) { return k !== 'consensus'; }).sort(function (a, b) { return e.meanWeight[b] - e.meanWeight[a]; }).slice(0, 3)
      .map(function (k) { return METHODS.filter(function (m) { return m.id === k; })[0].short + ' ' + Math.round(e.meanWeight[k] * 100) + '%'; });
    $('likelyNote').textContent = 'The heavy line is the most likely summit temperature: ' + fT(sm.lo.tSummit, 1) + ' ' + tUnit() + ' at the low (' + fHour(sm.lo.t) + ') and ' + fT(sm.hi.tSummit, 1) + ' ' + tUnit() +
      ' at the high (' + fHour(sm.hi.t) + '). The shaded bands hold the middle 50% and 80% of the methods' + (e.mode === 'regime' ? ', weighted by how well each method\u2019s cooling rate fits the regional weather' : ', all counted equally') +
      '. At the widest hour the middle 80% span ' + dU(w80).toFixed(1) + ' ' + tUnit() + ' and all methods ' + dU(widest).toFixed(1) + ' ' + tUnit() + '.' +
      (e.mode === 'regime' ? ' Weighted most over this period: ' + top.join(', ') + '.' : '') +
      ' This describes how far the methods disagree; it is not a calibrated probability.' +
      (S.lv && S.lv.ok && S.lv.applied ? ' For the first ' + S.live.hours + ' hours after the Auto Road reading the heavy line is also pulled toward the MWARVTP line, so it can leave the bands there.' : '');
    $('wRegime').setAttribute('aria-pressed', String(S.weighting === 'regime')); $('wEqual').setAttribute('aria-pressed', String(S.weighting === 'equal'));
    $('hAuto').setAttribute('aria-pressed', String(S.hourLabels === 'auto')); $('hEvery').setAttribute('aria-pressed', String(S.hourLabels === 'every'));
  }

  // Regional weather card: how many hours fall in each regime, and the cooling rate each regime makes likely.
  function renderRegional() {
    var counts = {}, sig = { low: 0, high: 0, neutral: 0 }, measured = 0;
    S.regimes.forEach(function (r) { counts[r.id] = (counts[r.id] || 0) + 1; sig[r.pressure]++; if (r.pressureSrc === 'measured') measured++; });
    var parts = Core.REGIME_ORDER.filter(function (id) { return counts[id]; }).map(function (id) { return Core.REGIMES[id].label + ' ' + counts[id] + ' h'; });
    var first = S.regimes[0];
    $('regText').textContent = 'The regional weather is the average over the ' + (S.net ? S.net.n : 0) + ' NWS grid cells. Over these ' + S.regimes.length + ' hours it reads as: ' + parts.join(', ') + '. ' +
      'Pressure signature: low ' + sig.low + ' h, high ' + sig.high + ' h, neutral ' + sig.neutral + ' h. ' +
      (measured ? 'The signature comes from real pressure for ' + measured + ' of the hours' + (S.fcSource === 'nws' ? ' (' + (uaData() ? 'the model’s sea-level pressure' + (S.pr.anchor ? ' adjusted to the airport observations' : '') : 'the airport observations') + ')' : ' (the pressure in your forecast)') + '. ' :
        'NWS grids carry no pressure, so the signature is inferred from regional cloud, precipitation, humidity, wind and temperature trend. ' + (S.fcSource === 'nws' ? 'The model pressure and airport observation feeds are not available right now. ' : 'Add mslp_hpa to a custom forecast to use real pressure. ')) +
      (first ? 'The first hour is ' + first.label.toLowerCase() + '.' : '');
    var tb = clear($('regTbl')), thead = el('thead'), hr = el('tr');
    ['Regime', 'Pressure', 'Expected cooling', 'Hours'].forEach(function (h) { hr.append(el('th', '', h)); }); thead.append(hr); tb.append(thead);
    var body = el('tbody');
    Core.REGIME_ORDER.forEach(function (id) {
      var g = Core.REGIMES[id], tr = el('tr'), td = el('td', '', g.label); td.style.whiteSpace = 'normal';
      tr.append(td, el('td', '', g.pressure === 'neutral' ? '\u2014' : g.pressure), el('td', '', lapseU(g.mu).toFixed(1) + ' \u00b1 ' + lapseU(g.sigma).toFixed(1) + ' ' + lUnit()), el('td', '', String(counts[id] || 0)));
      body.append(tr);
    });
    tb.append(body);
  }

  /* ---------- all 48 ---------- */
  var OV_OK = { fixed: 1, conditions: 1, adiabatic: 1, climatology: 1, bcdg: 1, regression: 1, wlr: 1, gids: 1 };   // methods the table can run for every summit
  function ovMethod() { return OV_OK[S.method] ? S.method : 'conditions'; }
  function overviewFor(p) {
    var np = S.nws && S.nws.peaks[p.id];
    if (!np || !np.rows || !np.rows.length) return { p: p, err: (np && np.error) || 'No forecast in the file.' };
    if (np.zModel == null) return { p: p, err: 'No grid-cell elevation.' };
    var m = ovMethod(), o = optsFor(m, { zModel: np.zModel, z: p.m, prep: netPrepFor(p) });
    var res = Core.downscale(windowRows(np.rows), o);
    return { p: p, zS: p.m, sum: Core.summarize(res), hasWind: np.rows.some(function (r) { return r.wind != null; }) };
  }
  function renderOverview() {
    var tb = clear($('ov'));
    if (!S.nws) return;
    var rows = PEAKS.map(overviewFor);
    var ok = rows.filter(function (r) { return !r.err; });
    if (S.sort === 'cold') ok.sort(function (a, b) { return a.sum.lo.tSummit - b.sum.lo.tSummit; });
    else if (S.sort === 'wind') ok.sort(function (a, b) { return (b.hasWind ? b.sum.maxWind.wSummit : -1) - (a.hasWind ? a.sum.maxWind.wSummit : -1); });
    var bad = rows.filter(function (r) { return r.err; });
    var head = ['Summit', 'Low', 'High', 'Feels', 'Wind'];
    var thead = el('thead'), hr = el('tr'); head.forEach(function (h) { hr.append(el('th', '', h)); }); thead.append(hr); tb.append(thead);
    var body = el('tbody');
    ok.concat(bad).forEach(function (r) {
      var sel = r.p.id === S.peak.id, tr = el('tr', (sel ? 'sel ' : '') + (!r.err && r.sum.lo.tSummit <= 0 ? 'cold' : '')), first = el('td');
      var bt = el('button', 'linkbtn', r.p.name); bt.type = 'button'; bt.onclick = function () { setPeak(r.p); setTab('fc'); };
      first.append(bt);
      first.append(el('div', 'small muted', fZ(r.err ? r.p.m : r.zS) + ' ' + zUnit() + ''));
      tr.append(first);
      if (r.err) { var td = el('td', 'small muted', r.err); td.colSpan = 4; td.style.textAlign = 'left'; td.style.whiteSpace = 'normal'; tr.append(td); }
      else {
        var s = r.sum;
        [fT(s.lo.tSummit, 0), fT(s.hi.tSummit, 0), r.hasWind ? fT(s.minFeels.feels, 0) : '', r.hasWind ? fW(s.maxWind.wSummit) : ''].forEach(function (v) { tr.append(el('td', '', v)); });
      }
      body.append(tr);
    });
    tb.append(body);
    var first = S.nws.peaks[S.peak.id] && S.nws.peaks[S.peak.id].rows && S.nws.peaks[S.peak.id].rows[0];
    $('ovNote').textContent = 'Lowest and highest summit temperature (' + tUnit() + '), coldest feels-like and peak wind (' + wUnit() + ') over ' + (S.win >= 9999 ? 'the whole forecast' : 'the next ' + S.win + ' hours of each forecast') +
      (first ? ', starting ' + fHour(first.t) : '') + '. Tinted rows dip to freezing or below. ' + methodName(ovMethod()) + ' method with the current summit adjustments.' +
      (ovMethod() !== S.method ? ' (The selected ' + methodName(S.method) + ' method needs inputs this table does not have.)' : '') + ' Tap a name for its forecast.';
  }


  function renderComparison() {
    var tb = clear($('cmp')), head = ['Method', 'Δ cell', 'Δ range', 'Lapse', 'Low', 'High', '≤ 0 h', 'Weight'];
    var thead = el('thead'), hr = el('tr'); head.forEach(function (h) { hr.append(el('th', '', h)); }); thead.append(hr); tb.append(thead);
    var body = el('tbody'), ens = S.ens;
    S.cmp.forEach(function (c) {
      var tr = el('tr', c.id === S.method ? 'sel' : ''), first = el('td');
      if (c.id === S.method) first.append(el('b', '', c.short));
      else { var bt = el('button', 'linkbtn', c.short); bt.type = 'button'; bt.onclick = function () { setMethod(c.id); }; first.append(bt); }
      if (c.used < c.res.length) { var part = el('div', 'small muted', c.used + '/' + c.res.length + ' h'); first.append(part); }
      tr.append(first);
      [sgn(dU(c.sum.meanDelta), 1), sgn(dU(c.dMin), 1) + ' to ' + sgn(dU(c.dMax), 1), lapseU(c.sum.meanGamma).toFixed(1), fT(c.sum.lo.tSummit, 1), fT(c.sum.hi.tSummit, 1), String(c.sum.below),
        c.id === 'consensus' ? '' : Math.round((ens.meanWeight[c.id] || 0) * 100) + '%'].forEach(function (v) { tr.append(el('td', '', v)); });
      body.append(tr);
    });
    tb.append(body);
    var ind = S.cmp.filter(function (c) { return c.id !== 'consensus'; });
    var his = ind.map(function (c) { return c.sum.hi.tSummit; }), los = ind.map(function (c) { return c.sum.lo.tSummit; });
    var spreadHi = Math.max.apply(null, his) - Math.min.apply(null, his), spreadLo = Math.max.apply(null, los) - Math.min.apply(null, los);
    $('cmpNote').textContent = ind.length < 2 ? 'Only one method has its inputs.' :
      'Δ cell is how far each method moves the summit temperature from the raw NWS cell value: its mean over the period, and its smallest and largest hourly change (' + tUnit() + '). Lapse is the mean cooling rate it implies (' + lUnit() + '). Low, High and hours at or below freezing follow. Weight is the share each method got in the most-likely line, averaged over the period; it is the same for every method in equal-weight mode. The methods differ by up to ' + dU(Math.max(spreadHi, spreadLo)).toFixed(1) + ' ' + tUnit() +
      ' at the extremes. A small note under a name means fewer hours had its inputs. Tap a method to switch to it.';
  }

  /* ---------- live look: the Auto Road stations ---------- */
  var AR_URL = 'api/autoroad.php', AR_REFRESH_MS = 5 * 60 * 1000;
  function nwsTz() { var np = nwsPeak(); return (np && np.tz) || 'America/New_York'; }
  function fClock(instantMs) { var d = new Date(Core.wallMs(instantMs, nwsTz())); return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()); }
  function fAge(min) { return min < 1.5 ? 'just now' : min < 90 ? Math.round(min) + ' min ago' : (min / 60).toFixed(1) + ' h ago'; }
  function saveLive() { try { localStorage.setItem('sd-live', JSON.stringify({ on: S.live.on, hours: S.live.hours, tower: S.live.tower })); } catch (e) {} }
  function median(a) { var s = a.slice().sort(function (x, y) { return x - y; }), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }

  async function loadAutoRoad(quiet) {
    var L = S.live;
    if (L.loading) return;
    L.loading = true; $('liveRefresh').disabled = true;
    try {
      var res = await feedFetch(AR_URL, { cache: 'no-store' }), text = await res.text();
      if (!res.ok) { var j = null; try { j = JSON.parse(text); } catch (e) {} throw new Error((j && j.error) || 'The Auto Road service answered ' + res.status + '.'); }
      if (/<\?php/.test(text.slice(0, 300))) throw new Error('The server sent back the PHP source instead of running it. Serve this folder with PHP or with serve.py.');
      if (/^\s*</.test(text)) throw new Error('The server answered with a web page instead of data. Check that api/autoroad.php is reachable at this address.');
      var data = Core.parseAutoRoad(JSON.parse(text));
      if (!data.ok) throw new Error(data.warnings[0] || 'There were no usable readings.');
      L.raw = data; L.at = Date.now(); L.status = 'ok'; L.msg = ''; L.stale = res.headers.get('X-Cache') === 'stale-error';
    } catch (e) { L.status = 'error'; L.msg = e.message; }
    L.loading = false; $('liveRefresh').disabled = false;
    S.deferDraw = !!quiet; recompute(); S.deferDraw = false;
  }

  /* ---------- model pressure levels (api/upperair.php) and observed pressure (api/metar.php) ---------- */
  var UA_URL = 'api/upperair.php', MT_URL = 'api/metar.php', UA_FRESH_MS = 45 * 60e3, UA_REFRESH_MS = 30 * 60e3, MT_REFRESH_MS = 10 * 60e3;
  function saveUa() { try { localStorage.setItem('sd-ua', JSON.stringify({ on: S.ua.on })); } catch (e) {} }
  function uaEntry() { return S.ua.on ? S.ua.byPeak[S.peak.id] || null : null; }
  function uaData() { var e = uaEntry(); return e ? e.data : null; }
  function tzOf(p) { var np = S.nws && S.nws.peaks[p.id]; return (np && np.tz) || 'America/New_York'; }
  function syncUaBtn() { $('uaRefresh').disabled = S.ua.loading || S.pr.loading; }
  async function getJson(url, label) {
    var res = await feedFetch(url, { cache: 'no-store' }), text = await res.text();
    if (!res.ok) { var j = null; try { j = JSON.parse(text); } catch (e) {} throw new Error((j && j.error) || 'The ' + label + ' answered ' + res.status + '.'); }
    if (/<\?php/.test(text.slice(0, 300))) throw new Error('The server sent back the PHP source instead of running it. Serve this folder with PHP or with serve.py.');
    if (/^\s*</.test(text)) throw new Error('The server answered with a web page instead of data. Check that ' + url.split('?')[0] + ' is reachable at this address.');
    return { json: JSON.parse(text), stale: res.headers.get('X-Cache') === 'stale-error' };
  }
  async function loadUpperAir(quiet, force) {
    var U = S.ua, p = S.peak;
    if (!U.on || U.loading || location.protocol === 'file:') return;
    var e = U.byPeak[p.id];
    if (e && !force && Date.now() - e.at < UA_FRESH_MS) return;
    U.loading = true; syncUaBtn();
    try {
      var r = await getJson(UA_URL + '?peak=' + encodeURIComponent(p.id), 'model pressure-level service');
      var d = Core.parseUpperAir(r.json, tzOf(p));
      if (!d.ok) throw new Error(d.warnings[0] || 'There were no usable pressure levels.');
      U.byPeak[p.id] = { data: d, at: Date.now(), stale: r.stale }; delete U.errors[p.id];
    } catch (err) { U.errors[p.id] = err.message; }
    U.loading = false; syncUaBtn();
    S.deferDraw = !!quiet; recompute(); S.deferDraw = false;
    if (S.peak.id !== p.id) loadUpperAir(true);     // the summit changed while this was loading
  }
  async function loadPressure(quiet) {
    var P = S.pr;
    if (P.loading || location.protocol === 'file:') return;
    P.loading = true; syncUaBtn();
    try {
      var r = await getJson(MT_URL, 'observation service');
      P.raw = r.json; P.at = Date.now(); P.status = 'ok'; P.msg = ''; P.stale = r.stale;
    } catch (err) { P.status = 'error'; P.msg = err.message; }
    P.loading = false; syncUaBtn();
    S.deferDraw = !!quiet; recompute(); S.deferDraw = false;
  }
  // Observed sea-level pressure and how far the model is from it right now. Runs before the forecast rows are built, which carry the result.
  function buildPressure() {
    var P = S.pr, ua = uaData(); P.obs = null; P.anchor = null;
    if (!P.raw) return;
    P.obs = Core.metarPressure(P.raw, { now: Date.now(), modelMslp: ua ? function (ms) { return Core.modelMslpAt(ua, ms); } : null });
    P.anchor = P.obs.ok && ua ? Core.pressureAnchor(ua, P.obs) : null;
  }

  // The live look for the selected summit: what the road stations say about the cooling rate right now, and how much of that
  // to carry into the next few hours. Sets S.lv; when it is applied, S.lv.adj.shift is added to the most-likely line.
  function buildLive() {
    var L = S.live; S.lv = null;
    if (!L.raw) return;
    var now = Date.now(), prof = Core.liveProfile(L.raw, now);
    if (!prof.ok) { S.lv = { ok: false, reason: prof.warnings[0] || 'No usable Auto Road readings.', prof: prof }; return; }
    var run = S.cmp[0].res, times = run.map(function (o) { return o.t; }), zS = S.terrain.z, zC = S.zModel, dz = (zS - zC) / 1000;
    var isWash = S.peak.id === 'mount-washington', tower = prof.tower && prof.tower.ok ? prof.tower : null;
    var used = prof.stations.filter(function (s) { return s.ok; });
    var lat = used.reduce(function (s, x) { return s + (x.lat || 0); }, 0) / used.length, lon = used.reduce(function (s, x) { return s + (x.lon || 0); }, 0) / used.length;
    var dKm = lat ? Core.distKm(S.peak.lat, S.peak.lon, lat, lon) : null;
    var lv = { ok: true, prof: prof, isWash: isWash, tower: tower, dKm: dKm, zC: zC, zS: zS, dz: dz, now: now, used: used,
      ageMin: (now - prof.newest) / 60e3, layers: Core.liveLayers(prof), trend: Core.liveTrend(L.raw, now, { holdOutTower: isWash }), mode: 'profile' };
    lv.fit = Core.liveLapse(prof, zC, zS, { holdOutTower: isWash });
    var tMs = median(used.map(function (s) { return s.t; }));
    if (isWash && tower && L.tower) {
      lv.mode = 'tower'; tMs = tower.t;
      var kAge = tower.ageMin <= 15 ? 1 : tower.ageMin >= 45 ? 0 : 1 - (tower.ageMin - 15) / 30, kSp = 1 / (1 + Math.pow(tower.spread / 1.5, 2));
      lv.conf = { k: kAge * kSp, parts: { age: kAge, sensors: kSp } };
    } else if (lv.fit.ok) lv.conf = Core.liveConfidence(lv.fit, lv.ageMin, dKm);
    else { lv.ok = false; lv.reason = 'Too few stations remain to fit a lapse rate' + (isWash ? ' without the tower' : '') + '.'; S.lv = lv; return; }
    lv.tMs = tMs;
    var ml = S.ens.hours.map(function (h) { return h.ml; }), cell = run.map(function (o) { return o.tModel; });
    lv.adj = Core.liveAdjust({ times: times, base: ml, cell: cell, tNow: Core.wallMs(tMs, nwsTz()), horizonH: L.hours, dzKm: dz,
      target: lv.mode === 'tower' ? { kind: 'tower', T: tower.T + 6.5 * (tower.z - zS) / 1000 } : { kind: 'profile', gamma: lv.fit.gamma }, k: lv.conf.k });
    lv.tNowWall = Core.wallMs(tMs, nwsTz());
    if (!lv.adj.ok) { lv.ok = false; lv.reason = lv.adj.reason; S.lv = lv; return; }
    lv.gammaLive = lv.mode === 'tower' ? (Math.abs(dz) > 1e-6 ? (lv.adj.tCell0 - lv.adj.tLive0) / dz : null) : lv.fit.gamma;
    if (isWash && tower && lv.fit.ok) lv.check = { predicted: lv.fit.at(tower.z), observed: tower.T };
    lv.applied = L.on && lv.conf.k > 0.005;
    S.lv = lv;
  }

  function confWhy(parts, lv) {
    var names = { fit: 'the stations scatter widely around the line', stable: 'dropping any one station moves the answer a lot', stations: 'few stations sit near this layer',
      age: 'the readings are getting old', reach: 'too few stations near the layer, so the whole mountain was used', extrap: 'part of the layer lies above or below the stations',
      distance: lv.dKm != null ? 'this summit is ' + dist(lv.dKm) + ' from the Auto Road' : 'the summit is far from the Auto Road', sensors: 'the two tower sensors disagree' };
    var worst = Object.keys(parts).sort(function (a, b) { return parts[a] - parts[b]; })[0];
    return parts[worst] < 0.8 ? names[worst] : '';
  }
  var CLS_WORDS = { inversion: 'inversion', 'very stable': 'very stable', stable: 'stable', typical: 'typical', steep: 'steep', superadiabatic: 'superadiabatic' };
  function layerName(L) { return L.lo.id + ' to ' + L.hi.id; }
  function middayClear() {
    var rows = S.fc && S.fc.rows, lv = S.lv; if (!rows || !lv || !lv.ok) return false;
    var best = 0, i; for (i = 1; i < rows.length; i++) if (Math.abs(rows[i].t - lv.tNowWall) < Math.abs(rows[best].t - lv.tNowWall)) best = i;
    var r = rows[best], h = new Date(lv.tNowWall).getUTCHours();
    return h >= 9 && h <= 16 && r.cloud != null && r.cloud < 50;
  }

  function renderLive() {
    var L = S.live, lv = S.lv, isW = S.peak.id === 'mount-washington';
    $('liveTowerRow').hidden = !isW; $('liveTower').checked = L.tower;
    $('liveOn').setAttribute('aria-pressed', String(L.on)); $('liveOff').setAttribute('aria-pressed', String(!L.on)); pressed($('liveHSeg'), 'data-h', L.hours);
    var err = L.status === 'error' ? 'Could not read the Auto Road stations. ' + L.msg + (L.raw ? ' The last reading is still shown, and it is dropped once it is 45 minutes old.' : '') : L.stale ? 'The Auto Road feed did not answer, so this is the last saved copy.' : '';
    if (location.protocol === 'file:') showMsg('liveMsg', 'This page was opened from a file, so the Auto Road service is not available. Serve the folder with PHP or serve.py.', 'warn');
    else showMsg('liveMsg', err, L.status === 'error' ? 'err' : 'warn');
    var lede = clear($('liveLede')), facts = clear($('liveFacts')), tb = clear($('liveTbl')), line = $('liveLine');
    line.hidden = true; $('liveNote').textContent = ''; $('liveTrendNote').textContent = '';
    if (!lv || !lv.ok) {
      lede.textContent = !L.raw ? (L.loading || L.status === 'idle' ? 'Reading the Auto Road stations…' : 'No Auto Road readings yet.') : (lv && lv.reason) || 'No usable Auto Road readings.';
      return;
    }
    var a = lv.adj, k = lv.conf.k, sh0 = a.delta0 * k, endT = lv.tMs + L.hours * 3600e3, why = confWhy(lv.conf.parts, lv);
    var base = a.gammaBase0, liveG = lv.gammaLive, inv = lv.layers.inversions;
    var stat = function (kk, v, unit, sub) { var d = el('div', 'stat'); d.append(el('div', 'k', kk)); var vv = el('div', 'v', v); if (unit) vv.append(el('small', '', ' ' + unit)); d.append(vv); if (sub) d.append(el('div', 's', sub)); facts.append(d); };
    lede.append('As of ' + fClock(lv.tMs) + ' (' + fAge(lv.ageMin) + '), ');
    if (lv.mode === 'tower') {
      lede.append('the Observatory tower reads ', el('b', '', fT(lv.tower.T, 1) + ' ' + tUnit()), '. The most likely forecast for that hour was ' + fT(a.tBase0, 1) + ' ' + tUnit() + ', so the tower is ' +
        Math.abs(dU(a.delta0)).toFixed(1) + ' ' + tUnit() + (a.delta0 >= 0 ? ' warmer' : ' colder') + ' than expected. ');
    } else {
      lede.append('the road stations show a cooling rate of ', el('b', '', lapseU(liveG).toFixed(1) + ' ' + lUnit()), ' (±' + lapseU(lv.fit.se).toFixed(1) + ') between ' + fZ(lv.zC) + ' and ' + fZ(lv.zS) + ' ' + zUnit() +
        (lv.fit.layer ? '' : ' (using every station, since too few sit near that layer)') + ', against ' + (base == null ? 'n/a' : lapseU(base).toFixed(1)) + ' in the forecast for this hour. ');
    }
    if (inv.length) {
      var iv = inv[0];
      lede.append('There is a warm layer: the temperature rises ' + dU(iv.dT).toFixed(1) + ' ' + tUnit() + ' from ' + iv.base.id + ' (' + fZ(iv.base.z) + ' ' + zUnit() + ') to ' + iv.top.id + ' (' + fZ(iv.top.z) + ' ' + zUnit() + '). ');
    }
    if (!L.on) lede.append(LIVE_NAME + ' is not applied; the pink line shows what it would do. ');
    else if (lv.mode === 'tower') lede.append('Most likely now starts from the tower reading and fades back to the forecast by ' + fClock(endT) + '. ');
    else if (Math.abs(sh0) < 0.05) lede.append('That agrees with the forecast, so Most likely is unchanged. ');
    else lede.append(LIVE_NAME + ' moves Most likely ' + (sh0 > 0 ? 'up ' : 'down ') + Math.abs(dU(sh0)).toFixed(1) + ' ' + tUnit() + ' now (' + Math.round(k * 100) + '% of the ' + sgn(dU(a.delta0), 1) + ' ' + tUnit() + ' the stations imply) and fades to nothing by ' + fClock(endT) + '. ');
    if (why) lede.append('Confidence is ' + Math.round(k * 100) + '%, held down because ' + why + '.');
    stat(lv.mode === 'tower' ? 'Lapse, cell to tower' : 'Live lapse', liveG == null ? 'n/a' : lapseU(liveG).toFixed(1), lUnit(), lv.mode === 'tower' ? 'from the tower reading' : 'for ' + fZ(lv.zC) + ' to ' + fZ(lv.zS) + ' ' + zUnit());
    stat('Forecast lapse', base == null ? 'n/a' : lapseU(base).toFixed(1), lUnit(), 'most likely, same hour');
    stat('Change now', sgn(dU(sh0), 1), tUnit(), 'confidence ' + Math.round(k * 100) + '%');
    stat('Fades out', fClock(endT), '', L.hours + ' h after the reading');
    // station table, top of the mountain first
    var head = ['Station', 'Elevation ' + zUnit(), 'Temp ' + tUnit(), 'Read', 'Cooling to the station below', 'Layer', 'Note'];
    var thead = el('thead'), hr = el('tr'); head.forEach(function (h) { hr.append(el('th', '', h)); }); thead.append(hr); tb.append(thead);
    var body = el('tbody'), byId = {}; lv.layers.layers.forEach(function (Ly) { byId[Ly.hi.id] = Ly; });
    var resid = {}; if (lv.fit.ok) lv.fit.resid.forEach(function (r) { resid[r.id] = r; });
    var warmTop = {}; inv.forEach(function (iv) { warmTop[iv.top.id] = 1; });
    lv.prof.stations.slice().sort(function (x, y) { return y.z - x.z; }).forEach(function (s) {
      var Ly = byId[s.id], notes = [], r = resid[s.id];
      if (!s.ok) notes.push(s.reason); else {
        if (s.tower) notes.push(lv.mode === 'tower' ? 'anchors the line' : 'held out; used to check the fit');
        if (r && r.out) notes.push('off the fit by ' + sgn(dU(r.r), 1) + ' ' + tUnit());
        else if (s.sd > 0.8) notes.push('readings vary ' + dU(s.sd).toFixed(1) + ' ' + tUnit());
        if (s.spread > 1.5) notes.push('two sensors differ by ' + dU(s.spread).toFixed(1));
      }
      var tr = el('tr', (!s.ok ? 'tr-off ' : '') + (warmTop[s.id] ? 'tr-warm' : ''));
      tr.append(el('td', '', s.name), el('td', '', fZ(s.z)), el('td', '', s.ok ? fT(s.T, 1) : '—'), el('td', '', s.ok ? fAge(s.ageMin) : fAge(s.ageMin)),
        el('td', '', Ly ? lapseU(Ly.gamma).toFixed(1) + ' ' + lUnit() : ''), el('td', '', Ly ? CLS_WORDS[Ly.cls] + (Ly.thin ? ', thin' : '') : ''), el('td', '', notes.join('; ')));
      tr.lastChild.style.textAlign = 'left'; tr.lastChild.style.whiteSpace = 'normal'; body.append(tr);
    });
    tb.append(body);
    var chk = lv.check ? ' Check: the road stations alone, fitted for ' + fZ(lv.fit.zBot) + ' to ' + fZ(lv.fit.zTop) + ' ' + zUnit() + ' and carried up to the tower, give ' + fT(lv.check.predicted, 1) + ' ' + tUnit() + '; the tower reads ' + fT(lv.check.observed, 1) + ' (' + sgn(dU(lv.check.predicted - lv.check.observed), 1) + ').' : '';
    $('liveNote').textContent = 'Latest reading of each station: the median of its last 8 minutes. Cooling is the temperature drop per unit of height between neighbouring stations (negative in an inversion). Sensors in open sun can read warm' + (middayClear() ? ', and it is midday with a mostly clear sky in the forecast, so treat a warm reading above the trees with caution' : '') + '. A station that disagrees with the rest is given little weight in the fit and is marked.' + chk;
    var tr = lv.trend, n = tr.length;
    if (n > 6) {
      var d1 = tr[n - 1].gamma - tr[Math.max(0, n - 13)].gamma;
      $('liveTrendNote').textContent = 'Cooling rate of the whole mountain (all stations, robust fit) every 5 minutes. Over the last hour it ' + (Math.abs(lapseU(d1)) < 0.05 ? 'hardly changed' : 'changed by ' + sgn(lapseU(d1), 1) + ' ' + lUnit()) + (Math.abs(lapseU(d1)) > 1.2 ? '. A rate moving this fast is a reason to trust the live look for less time.' : '.');
    }
    line.hidden = false;
    line.textContent = L.on ? LIVE_NAME + ' (Auto Road, read ' + fClock(lv.tMs) + '): ' + (Math.abs(sh0) < 0.05 ? 'no change' : sgn(dU(sh0), 1) + ' ' + tUnit()) + ' on the heavy line now, fading to zero by ' + fClock(endT) + '; confidence ' + Math.round(k * 100) + '%. The pink line is the live look at full strength. Details further down.' :
      LIVE_NAME + ' is not applied. The pink line shows what the Auto Road stations would do to the heavy line for the next ' + L.hours + ' h. Details further down.';
  }

  // True while the main chart is zoomed in: a background refresh then leaves the charts alone instead of resetting the zoom.
  function chartsZoomed() {
    if (!CH.chart1) return false;
    var e = CH.chart1.xAxis[0].getExtremes();
    return !!CH.chart1.resetZoomButton || (e.dataMin != null && (e.min > e.dataMin + 60e3 || e.max < e.dataMax - 60e3));
  }

  /* ---------- charts (Highcharts) ---------- */
  // Every chart shares one hourly time axis. Times are Eastern wall-clock hours held as UTC-naive milliseconds, so Highcharts runs in UTC mode.
  var CH = {}, SYNC = false;
  var FAM_VAR = { network: '--fam-network', rate: '--fam-rate', parcel: '--fam-parcel', profile: '--fam-profile' };
  var DASH = { fixed: 'Solid', conditions: 'ShortDash', climatology: 'Dot', adiabatic: 'Solid', levels: 'Solid', hypsometric: 'ShortDash',
    bcdg: 'Solid', regression: 'ShortDash', wlr: 'Dot', gids: 'LongDash', bcdgcsv: 'DashDot' };
  var COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  function compass(d) { return COMPASS[Math.round(d / 22.5) % 16]; }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function esc(t) { return String(t).replace(/[&<>"]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; }); }
  function palette() {
    var css = getComputedStyle(document.documentElement), g = function (n) { return css.getPropertyValue(n).trim(); };
    return { ink: g('--ink'), muted: g('--muted'), faint: g('--faint'), line: g('--line'), grid: g('--grid'), surface: g('--surface'), ice: g('--ice'), marker: g('--marker'),
      feels: g('--feels'), hi: g('--hi-wash'), lo: g('--lo-wash'), live: g('--live'), liveWash: g('--live-wash'), mono: g('--font-data'), body: g('--font-body'),
      fam: { network: g('--fam-network'), rate: g('--fam-rate'), parcel: g('--fam-parcel'), profile: g('--fam-profile') } };
  }
  function destroyCharts() { Object.keys(CH).forEach(function (k) { try { CH[k].destroy(); } catch (e) {} delete CH[k]; }); }

  // Hour ticks: all hours when they fit, otherwise the finest of 1, 2, 3, 4, 6, 12, 24 h steps that keeps the labels legible.
  // Every hour still gets a small tick mark. Labels read HH:00 when there is room, else HH.
  function hourAxis(nHours, plotW) {
    var steps = [1, 2, 3, 4, 6, 12, 24], per = plotW / Math.max(1, nHours), st = 24;
    for (var k = 0; k < steps.length; k++) if (per * steps[k] >= 17) { st = steps[k]; break; }
    return { st: st, wide: per * st >= 38 };
  }
  var EVERY_PX = 20;   // width given to each hour when "every hour" labels are chosen (the chart then scrolls sideways if it must)
  function xAxes(c, times, width, every) {
    var plotW0 = Math.max(200, width - 70), state = { st: 1, wide: false }, DAY = 86400e3;
    var hours = {
      type: 'datetime', minPadding: 0, maxPadding: 0, startOnTick: false, endOnTick: false, title: { text: null },
      minorTickInterval: 3600e3, minorGridLineWidth: 0, minorTickLength: 3, minorTickWidth: 1, minorTickPosition: 'outside', minorTickColor: c.line,
      tickLength: 6, tickWidth: 1, tickColor: c.line, lineColor: c.line, gridLineWidth: 0, crosshair: { width: 1, color: c.faint },
      labels: { y: 16, style: { color: c.muted, fontSize: '11px', fontFamily: c.mono }, formatter: function () { var h = new Date(this.value).getUTCHours(); return state.wide ? pad2(h) + ':00' : pad2(h); } },
      tickPositioner: function (min, max) {
        var w = this.chart.plotWidth || plotW0, hh = every ? { st: 1, wide: false } : hourAxis((max - min) / 3600e3 + 1, w);
        state.st = hh.st; state.wide = hh.wide;
        var out = [], step = hh.st * 3600e3;
        for (var t = Math.ceil(min / step) * step; t <= max; t += step) out.push(t);
        return out;
      }
    };
    var days = {
      type: 'datetime', linkedTo: 0, offset: 0, lineWidth: 0, tickLength: 0, minorTickLength: 0, title: { text: null },
      gridLineWidth: 1, gridLineColor: c.line, minPadding: 0, maxPadding: 0, startOnTick: false, endOnTick: false,
      labels: { align: 'left', x: 4, y: 32, style: { color: c.ink, fontSize: '11px', fontWeight: '600', fontFamily: c.body },
        formatter: function () { var d = new Date(this.value), nm = DAYS[d.getUTCDay()] + ' ' + d.getUTCDate(); return this.chart.plotWidth < 420 ? nm : nm + ' ' + MONTHS[d.getUTCMonth()]; } },
      tickPositioner: function (min, max) {
        var out = [];
        for (var t = Math.ceil(min / DAY) * DAY; t <= max; t += DAY) out.push(t);
        var pxPerMs = (this.chart.plotWidth || plotW0) / Math.max(1, max - min), need = this.chart.plotWidth < 420 ? 62 : 92;
        if (!out.length || (out[0] - min) * pxPerMs >= need) out.unshift(min);   // name the first, partial day too when there is room for its label
        return out;
      }
    };
    return [hours, days];
  }
  // Keep the hidden/shown state of a method in step across the charts that list the methods.
  function syncVis(name, vis) {
    S.hidden[name] = !vis;
    if (SYNC) return;
    SYNC = true;
    Object.keys(CH).forEach(function (k) {
      var ch = CH[k], moved = false;
      ch.series.forEach(function (sr) { if (sr.name === name && sr.visible !== vis) { sr.setVisible(vis, false); moved = true; } });
      if (moved) ch.redraw();
    });
    SYNC = false;
  }
  function baseOptions(c, id, times, height, every) {
    var host = $(id), width = host.clientWidth || 340;
    return {
      chart: { renderTo: id, height: height, backgroundColor: 'transparent', spacing: [8, 10, 6, 4], animation: false, style: { fontFamily: c.body },
        zooming: every ? {} : { type: 'x' }, scrollablePlotArea: every ? { minWidth: times.length * EVERY_PX + 90, scrollPositionX: 0 } : undefined,
        resetZoomButton: { theme: { fill: c.surface, stroke: c.line, r: 6, style: { color: c.ink, fontSize: '12px' }, states: { hover: { fill: c.grid, stroke: c.line, style: { color: c.ink } } } } } },
      title: { text: null }, credits: { enabled: false }, time: { useUTC: true }, accessibility: { enabled: false },
      xAxis: xAxes(c, times, width, every),
      legend: { enabled: true, itemStyle: { color: c.muted, fontWeight: '400', fontSize: '12px' }, itemHoverStyle: { color: c.ink }, itemHiddenStyle: { color: c.faint },
        symbolWidth: 22, itemDistance: 14, margin: 8, padding: 4 },
      plotOptions: { series: { animation: false, turboThreshold: 0, marker: { enabled: false, states: { hover: { enabled: true, radius: 4 } } },
        states: { hover: { lineWidthPlus: 1 }, inactive: { opacity: 0.3 } }, stickyTracking: true,
        events: { show: function () { syncVis(this.name, true); }, hide: function () { syncVis(this.name, false); } } } },
      tooltip: { shared: true, useHTML: true, backgroundColor: c.surface, borderColor: c.line, borderRadius: 6, shadow: false, padding: 8,
        style: { color: c.ink, fontSize: '12px' }, hideDelay: 100 }
    };
  }
  function yAxisOptions(c, title, extra) {
    var o = { title: { text: title, style: { color: c.muted, fontWeight: '400', fontSize: '12px' } }, gridLineColor: c.grid, gridLineWidth: 1, lineWidth: 0,
      startOnTick: true, endOnTick: true, labels: { style: { color: c.muted, fontSize: '11px', fontFamily: c.mono }, formatter: function () { return String(Math.round(this.value * 100) / 100).replace('-', '−'); } } };
    for (var k in extra) o[k] = extra[k];
    return o;
  }
  function pointsOf(times, fn) { return times.map(function (t, i) { var v = fn(i); return [t, v == null || !isFinite(v) ? null : v]; }); }
  function tipRow(color, dash, name, value, extra, bold, pc, placed) {
    var style = 'border-top:2px ' + (/Dot/.test(dash || '') ? 'dotted' : /Dash/.test(dash || '') ? 'dashed' : 'solid') + ' ' + color;
    return '<div class="tt-r' + (bold ? ' b' : '') + (pc != null ? ' p' : '') + '"><i style="' + style + '"></i><span>' + esc(name) + '</span><b>' + value + '</b><em>' + (extra || '') + '</em>' + (pc != null ? '<u' + (placed ? ' class="np"' : '') + '>' + pc + '</u>' : '') + '</div>';
  }
  function regimeTag(i) {
    var r = S.regimes[i]; if (!r) return '';
    return '<div class="tt-s">' + esc(r.label) + (r.pressure === 'neutral' ? '' : ' · ' + r.pressure + '-pressure signature') + '</div>';
  }
  // pressure signature spans as light background bands (high = blue, low = red: the diverging pair, with no band where neutral)
  function pressureBands(c, times) {
    var out = [], cur = null;
    S.regimes.forEach(function (r, i) {
      var k = r.pressure === 'neutral' ? null : r.pressure;
      if (cur && cur.k === k) cur.to = times[i] + 1800e3;
      else { if (cur && cur.k) out.push(cur); cur = { k: k, from: times[i] - 1800e3, to: times[i] + 1800e3 }; }
    });
    if (cur && cur.k) out.push(cur);
    return out.map(function (b) { return { from: b.from, to: b.to, color: b.k === 'high' ? c.hi : c.lo, zIndex: 0 }; });
  }

  function methodSeries(c, times, valueOf, opts) {
    var out = [];
    // key order follows the NIST percentile each method holds among the methods, averaged over the hours shown (highest first)
    var mp = function (m) { var t = 0, n = 0; S.ens.hours.forEach(function (h) { var p = h.pct[m.id]; if (p != null && p === p) { t += p; n++; } }); return n ? t / n : -1; };
    S.cmp.filter(function (m) { return m.id !== 'consensus'; }).sort(function (a, b) { return mp(b) - mp(a); }).forEach(function (m) {
      out.push({ type: 'line', name: m.short, data: pointsOf(times, function (i) { return valueOf(m.res[i], i); }), color: c.fam[Core.FAMILY[m.id]], dashStyle: DASH[m.id] || 'Solid',
        lineWidth: m.id === S.method ? 2.6 : 1.4, zIndex: 2, visible: !S.hidden[m.short], custom: { kind: 'method', id: m.id }, legendIndex: 10 + out.length });
    });
    return out;
  }

  function drawMain(c, times) {
    var ens = S.ens.hours, likely = S.cmp.filter(function (m) { return m.id === 'consensus'; })[0], every = S.hourLabels === 'every';
    var lo = 0, hi = 0;
    likely.res.forEach(function (o, i) { if (o.tSummit < likely.res[lo].tSummit) lo = i; if (o.tSummit > likely.res[hi].tSummit) hi = i; });
    var mark = function (i, up) { return { marker: { enabled: true, radius: 4.5, fillColor: c.ink, lineWidth: 2, lineColor: c.surface },
      dataLabels: { enabled: true, y: up ? -10 : 18, style: { color: c.ink, fontSize: '11px', fontWeight: '600', textOutline: 'none', fontFamily: c.mono },
        formatter: function () { return this.y.toFixed(1) + '°'; } } }; };
    var likelyData = pointsOf(times, function (i) { return tU(likely.res[i].tSummit); }).map(function (p, i) {
      if (i === lo || i === hi) { var o = mark(i, i === hi); o.x = p[0]; o.y = p[1]; return o; }
      return p;
    });
    var cell = pointsOf(times, function (i) { return tU(S.res[i].tModel); });
    var opts = baseOptions(c, 'chart1', times, every ? 470 : 440, every);
    opts.yAxis = yAxisOptions(c, tUnit(), { softMin: tU(0), softMax: tU(0),
      plotLines: [{ value: tU(0), color: c.ice, width: 1.5, dashStyle: 'Dash', zIndex: 1, label: { text: 'Freezing', align: 'left', x: 4, y: -4, style: { color: c.muted, fontSize: '11px' } } }] });
    var series = [
      { type: 'arearange', name: 'Middle 80% of methods', data: times.map(function (t, i) { return [t, tU(ens[i].p10), tU(ens[i].p90)]; }), color: c.ink, fillOpacity: 0.07, lineWidth: 0,
        zIndex: 0, enableMouseTracking: false, visible: !S.hidden['Middle 80% of methods'], legendIndex: 2 },
      { type: 'arearange', name: 'Middle 50% of methods', data: times.map(function (t, i) { return [t, tU(ens[i].p25), tU(ens[i].p75)]; }), color: c.ink, fillOpacity: 0.14, lineWidth: 0,
        zIndex: 1, enableMouseTracking: false, visible: !S.hidden['Middle 50% of methods'], legendIndex: 1 },
      { type: 'line', name: 'Most likely', data: likelyData, color: c.ink, lineWidth: 3.5, zIndex: 6, visible: !S.hidden['Most likely'], custom: { kind: 'likely' }, legendIndex: 0 },
      { type: 'line', name: 'NWS grid cell (raw)', data: cell, color: c.muted, dashStyle: 'Dash', lineWidth: 2, zIndex: 4, visible: !S.hidden['NWS grid cell (raw)'], custom: { kind: 'cell' }, legendIndex: 3 }
    ].concat(methodSeries(c, times, function (o) { return tU(o.tSummit); }));
    if (S.fc.cols.wind) series.push({ type: 'line', name: 'Feels like (selected method)', data: pointsOf(times, function (i) { return tU(S.res[i].feels); }), color: c.feels, dashStyle: 'Dot', lineWidth: 1.8,
      zIndex: 3, visible: S.hidden['Feels like (selected method)'] === false, custom: { kind: 'feels' }, legendIndex: 30 });
    var lb = liveTimeBits(c, times, false);
    if (lb) { series = series.concat(lb.series); opts.xAxis[0].plotBands = lb.bands; opts.xAxis[0].plotLines = lb.lines; }
    opts.series = series;
    opts.tooltip.formatter = function () {
      var i = this.points[0].point.index, en = ens[i], sc = '°';
      // The ten levels of the methods at this hour (NIST percentiles; MIN, MAX and the mean). Each method holds one level and no
      // level is held twice (Core.assignLevels); with more methods than levels the ones left over show a dash. The raw NWS cell,
      // Most likely and MWARVTP are not methods and do not take a level: they show where they fall against the levels.
      var A = Core.assignLevels(en);
      var raw = function (k) {
        if (k.kind === 'cell') return S.res[i].tModel;
        if (k.kind === 'likely') return likely.res[i].tSummit;
        if (k.kind === 'live') return S.lv && S.lv.ok && S.lv.adj.live[i] != null ? S.lv.adj.live[i] : null;
        return null;
      };
      var rows = this.points.filter(function (p) { return p.y != null && p.series.options.custom; }).sort(function (a, b) { return b.y - a.y; });
      var lv = Core.levelValues(en), html = '<div class="tt"><div class="tt-h">' + fHour(times[i]) + '</div>' + regimeTag(i);
      html += '<div class="tt-lv">' + Core.LEVELS.map(function (L, k) { return '<span>' + L + '<b>' + fT(lv[k], 1) + sc + '</b></span>'; }).join('') + '</div>';
      html += liveTipLine(i);
      rows.forEach(function (p) {
        var k = p.series.options.custom, d = p.y - tU(S.res[i].tModel), isCell = k.kind === 'cell', pc = '';
        if (k.kind === 'method') pc = en.pct[k.id] == null ? '' : A[k.id] || '&ndash;';
        else if (k.kind === 'cell' || k.kind === 'likely' || k.kind === 'live') { var r = raw(k), bt = r == null ? null : Core.levelBetween(en, r); pc = bt ? bt.replace('<', '&lt;').replace('>', '&gt;') : ''; }
        html += tipRow(p.series.color, p.series.options.dashStyle, p.series.name, p.y.toFixed(1) + sc, isCell ? '' : sgn(d, 1), k.kind === 'likely', pc, k.kind !== 'method');
      });
      return html + '<div class="tt-f">Right columns: difference from the NWS cell, and the level each method holds (one method per level). Italic entries are not methods: they show where the line falls against the levels.</div></div>';
    };
    CH.chart1 = Highcharts.chart(opts);
  }

  function drawFreeze(c, times) {
    var every = S.hourLabels === 'every', summitZ = zUn(S.terrain.z), opts = baseOptions(c, 'chart2', times, every ? 320 : 300, every);
    opts.legend.enabled = false;
    opts.yAxis = yAxisOptions(c, 'Elevation (' + zUnit() + ')', { softMin: summitZ, softMax: summitZ,
      labels: { style: { color: c.muted, fontSize: '11px', fontFamily: c.mono }, formatter: function () { return Math.round(this.value).toLocaleString('en-US'); } },
      plotLines: [{ value: summitZ, color: c.marker, width: 1.5, dashStyle: 'Dash', zIndex: 4, label: { text: 'Summit ' + Math.round(summitZ).toLocaleString('en-US') + ' ' + zUnit(), align: 'left', x: 4, y: -4, style: { color: c.muted, fontSize: '11px' } } }] });
    opts.series = [{ type: 'line', name: 'Freezing level', data: pointsOf(times, function (i) { return S.res[i].freezeZ == null ? null : zUn(S.res[i].freezeZ); }), color: c.ice, lineWidth: 2.25, zIndex: 3 }];
    opts.tooltip.formatter = function () {
      var i = this.points[0].point.index;
      return '<div class="tt"><div class="tt-h">' + fHour(times[i]) + '</div>' + tipRow(c.ice, 'Solid', 'Freezing level', Math.round(this.points[0].y).toLocaleString('en-US') + ' ' + zUnit(), '', true) + '</div>';
    };
    CH.chart2 = Highcharts.chart(opts);
  }

  function drawRegional(c, times) {
    var every = S.hourLabels === 'every', rw = function (i) { return S.rw && S.rw.byTime[times[i]]; }, bands = pressureBands(c, times);
    var v = function (i, k) { var w = rw(i); return w && w[k] != null ? w[k] : null; };
    var o1 = baseOptions(c, 'chartReg1', times, every ? 250 : 230, every);
    o1.xAxis[0].plotBands = bands;
    o1.yAxis = yAxisOptions(c, '% of the region', { min: 0, max: 100, tickInterval: 25, startOnTick: false, endOnTick: false });
    o1.series = [
      { type: 'area', name: 'Cells with precipitation', data: pointsOf(times, function (i) { var f = v(i, 'precipFrac'); return f == null ? null : f * 100; }), color: c.ice, fillOpacity: 0.22, lineWidth: 1.5, zIndex: 1 },
      { type: 'line', name: 'Cloud cover', data: pointsOf(times, function (i) { return v(i, 'cloud'); }), color: c.ink, lineWidth: 2, zIndex: 3 },
      { type: 'line', name: 'Relative humidity', data: pointsOf(times, function (i) { return v(i, 'rh'); }), color: c.muted, dashStyle: 'ShortDash', lineWidth: 1.6, zIndex: 2 }
    ];
    o1.tooltip.formatter = function () {
      var i = this.points[0].point.index, html = '<div class="tt"><div class="tt-h">' + fHour(times[i]) + '</div>' + regimeTag(i);
      this.points.forEach(function (p) { html += tipRow(p.series.color, p.series.options.dashStyle, p.series.name, Math.round(p.y) + '%', '', false); });
      return html + '</div>';
    };
    CH.chartReg1 = Highcharts.chart(o1);

    var o2 = baseOptions(c, 'chartReg2', times, every ? 220 : 200, every);
    o2.xAxis[0].plotBands = bands;
    o2.legend.enabled = false;
    o2.yAxis = yAxisOptions(c, 'Regional wind (' + wUnit() + ')', { min: 0, softMax: wU(45),
      plotLines: [{ value: wU(35), color: c.muted, width: 1, dashStyle: 'Dash', zIndex: 4, label: { text: 'Windy regime from ' + fW(35) + ' ' + wUnit(), align: 'left', x: 4, y: -4, style: { color: c.muted, fontSize: '11px' } } }] });
    o2.series = [{ type: 'line', name: 'Regional wind', data: pointsOf(times, function (i) { var w = v(i, 'wind'); return w == null ? null : wU(w); }), color: c.ink, lineWidth: 2, zIndex: 3 }];
    o2.tooltip.formatter = function () {
      var i = this.points[0].point.index, d = v(i, 'dir');
      return '<div class="tt"><div class="tt-h">' + fHour(times[i]) + '</div>' + regimeTag(i) +
        tipRow(c.ink, 'Solid', 'Regional wind', this.points[0].y.toFixed(0) + ' ' + wUnit(), d == null ? '' : 'from ' + compass(d), true) + '</div>';
    };
    CH.chartReg2 = Highcharts.chart(o2);
  }

  // Live look on the two time charts: a shaded window from the reading to the end of the horizon, a line at the reading,
  // the full-strength live line (solid when applied, dotted when not) and, for Mount Washington, the tower reading.
  function liveTimeBits(c, times, diff) {
    var lv = S.lv; if (!lv || !lv.ok) return null;
    var a = lv.adj, t0 = lv.tNowWall, t1 = t0 + S.live.hours * 3600e3;
    var cellT = function (i) { return S.res[i].tModel; }, conv = function (v, i) { return diff ? dU(v - cellT(i)) : tU(v); };
    var series = [{ type: 'line', name: LIVE_NAME, data: pointsOf(times, function (i) { return a.live[i] == null ? null : conv(a.live[i], i); }), color: c.live, lineWidth: 2.8,
      dashStyle: S.live.on ? 'Solid' : 'ShortDot', zIndex: 5, visible: !S.hidden[LIVE_NAME], custom: { kind: 'live' }, legendIndex: 4, marker: { enabled: false } }];
    if (lv.mode === 'tower') series.push({ type: 'scatter', name: 'Tower reading', data: [[t0, diff ? dU(a.tLive0 - a.tCell0) : tU(a.tLive0)]], color: c.live, enableMouseTracking: false, zIndex: 7,
      marker: { enabled: true, symbol: 'diamond', radius: 6.5, fillColor: c.live, lineWidth: 2, lineColor: c.surface }, visible: !S.hidden['Tower reading'], legendIndex: 5 });
    return { series: series,
      bands: [{ from: t0, to: t1, color: c.liveWash, zIndex: 0, label: { text: LIVE_NAME, align: 'left', x: 4, y: 12, style: { color: c.muted, fontSize: '11px' } } }],
      lines: [{ value: t0, color: c.live, width: 1.5, dashStyle: 'Dot', zIndex: 4 }] };
  }
  function liveTipLine(i) {
    var lv = S.lv; if (!lv || !lv.ok || !(lv.adj.w[i] > 0)) return '';
    return '<div class="tt-s">' + LIVE_NAME + ' counts ' + Math.round(lv.adj.w[i] * lv.conf.k * 100) + '% in the heavy line this hour</div>';
  }

  function baseLiveOptions(c, id, height) {
    var o = baseOptions(c, id, [0], height, false);
    delete o.plotOptions.series.events; o.chart.zooming = {}; o.chart.spacing = [8, 20, 6, 4]; o.tooltip.shared = false;
    return o;
  }
  function drawLive(c) {
    var lv = S.lv, host = $('chartLive');
    if (!lv || !lv.ok) { clear(host); clear($('chartLiveTrend')); return; }
    var a = lv.adj, fit = lv.fit, st = lv.prof.stations.filter(function (s) { return s.ok; }), byId = {};
    if (fit.ok) fit.resid.forEach(function (r) { byId[r.id] = r; });
    var zs = st.map(function (s) { return s.z; }).concat([lv.zC, lv.zS]), zLo = Math.min.apply(null, zs), zHi = Math.max.apply(null, zs);
    var o = baseLiveOptions(c, 'chartLive', 400);
    o.xAxis = { title: { text: 'Temperature (' + tUnit() + ')', style: { color: c.muted, fontWeight: '400', fontSize: '12px' } }, gridLineWidth: 1, gridLineColor: c.grid, lineColor: c.line, tickColor: c.line,
      labels: { style: { color: c.muted, fontSize: '11px', fontFamily: c.mono }, formatter: function () { return String(Math.round(this.value * 10) / 10).replace('-', '−'); } }, startOnTick: true, endOnTick: true, tickPixelInterval: 60 };
    o.yAxis = yAxisOptions(c, 'Elevation (' + zUnit() + ')', { softMin: zUn(zLo - 60), softMax: zUn(zHi + 80), startOnTick: false, endOnTick: false, tickPixelInterval: 55,
      labels: { style: { color: c.muted, fontSize: '11px', fontFamily: c.mono }, formatter: function () { return Math.round(this.value).toLocaleString('en-US'); } },
      plotLines: [{ value: zUn(lv.zS), color: c.marker, width: 1.5, dashStyle: 'Dash', zIndex: 1, label: { text: 'Summit', align: 'left', x: 4, y: -4, style: { color: c.muted, fontSize: '11px' } } },
        { value: zUn(lv.zC), color: c.faint, width: 1, dashStyle: 'Dash', zIndex: 1, label: { text: 'NWS cell', align: 'left', x: 4, y: -4, style: { color: c.muted, fontSize: '11px' } } }] });
    var pts = st.map(function (s) {
      var r = byId[s.id], out = !!(r && r.out);
      return { x: tU(s.T), y: zUn(s.z), name: s.id, custom: { s: s, resid: r },
        marker: { enabled: true, symbol: s.tower ? 'diamond' : 'circle', radius: s.tower ? 6.5 : 5, fillColor: out ? c.surface : c.ink, lineColor: out ? c.live : c.surface, lineWidth: 2 } };
    });
    var zA = fit.ok ? Math.min(fit.zBot, lv.zC) : lv.zC, zB = fit.ok ? Math.max(fit.zTop, lv.zS) : lv.zS;
    o.series = [
      { type: 'scatter', name: 'Stations, latest', data: pts, color: c.ink, zIndex: 6, lineWidth: 0, custom: { kind: 'stations' },
        dataLabels: { enabled: true, align: 'left', x: 9, y: 4, allowOverlap: true, crop: false, overflow: 'allow', style: { color: c.muted, fontSize: '11px', fontWeight: '400', textOutline: 'none', fontFamily: c.mono }, formatter: function () { return this.point.name; } } }
    ];
    if (fit.ok) o.series.push({ type: 'scatter', name: 'Fit through the stations', data: [[tU(fit.at(zA)), zUn(zA)], [tU(fit.at(zB)), zUn(zB)]], color: c.live, lineWidth: 1.5, dashStyle: 'ShortDash', zIndex: 3, marker: { enabled: false }, custom: { kind: 'fit' } });
    o.series.push(
      { type: 'scatter', name: 'Forecast, NWS cell to summit', data: [[tU(a.tCell0), zUn(lv.zC)], [tU(a.tBase0), zUn(lv.zS)]], color: c.muted, lineWidth: 2, dashStyle: 'Dash', zIndex: 4,
        marker: { enabled: true, radius: 3.5, symbol: 'circle' }, custom: { kind: 'fc' } },
      { type: 'scatter', name: lv.mode === 'tower' ? 'Tower reading, from the NWS cell' : 'Live lapse, from the NWS cell', data: [[tU(a.tCell0), zUn(lv.zC)], [tU(a.tLive0), zUn(lv.zS)]], color: c.live, lineWidth: 3, zIndex: 5,
        marker: { enabled: true, radius: 4, symbol: 'circle' }, custom: { kind: 'live' } });
    o.tooltip.formatter = function () {
      var p = this.point, s = p.custom && p.custom.s;
      if (s) {
        var r = p.custom.resid, h = '<div class="tt"><div class="tt-h">' + esc(s.name) + '</div><div class="tt-s">' + fZ(s.z) + ' ' + zUnit() + ' · read ' + fAge(s.ageMin) + '</div>' +
          tipRow(c.ink, 'Solid', 'Temperature', tU(s.T).toFixed(1) + '°', '') + tipRow(c.muted, 'Solid', 'Varies (8 min)', '±' + dU(s.sd).toFixed(1), '');
        if (r) h += tipRow(c.live, 'Dash', 'Off the fit', sgn(dU(r.r), 1), '', false);
        return h + '</div>';
      }
      return '<div class="tt"><div class="tt-h">' + esc(this.series.name) + '</div><div class="tt-s">' + this.x.toFixed(1) + '° at ' + Math.round(this.y).toLocaleString('en-US') + ' ' + zUnit() + '</div></div>';
    };
    CH.chartLive = Highcharts.chart(o);
  }

  function drawLiveTrend(c) {
    var lv = S.lv, host = $('chartLiveTrend');
    if (!lv || !lv.ok || lv.trend.length < 4) { clear(host); return; }
    var tz = nwsTz(), o = baseLiveOptions(c, 'chartLiveTrend', 260), base = lv.adj.gammaBase0;
    o.legend.enabled = false;
    o.xAxis = { type: 'datetime', title: { text: null }, lineColor: c.line, tickColor: c.line, gridLineWidth: 1, gridLineColor: c.grid, tickPixelInterval: 70,
      labels: { style: { color: c.muted, fontSize: '11px', fontFamily: c.mono }, formatter: function () { var d = new Date(this.value); return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()); } } };
    var vals = lv.trend.map(function (p) { return lapseU(p.gamma); });
    o.yAxis = yAxisOptions(c, 'Cooling with height (' + lUnit() + ')', { softMin: 0, softMax: lapseU(6.5),
      plotBands: [{ from: -1000, to: 0, color: c.liveWash, zIndex: 0 }],
      plotLines: [{ value: 0, color: c.muted, width: 1.5, zIndex: 2, label: { text: 'Below zero: warmer with height', align: 'left', x: 4, y: -4, style: { color: c.muted, fontSize: '11px' } } }].concat(base == null ? [] :
        [{ value: lapseU(base), color: c.muted, width: 1.5, dashStyle: 'Dash', zIndex: 3, label: { text: 'Forecast, this hour', align: 'right', x: -4, y: -4, style: { color: c.muted, fontSize: '11px' } } }]) });
    o.series = [{ type: 'line', name: 'Whole-mountain cooling rate', data: lv.trend.map(function (p, i) { return [Core.wallMs(p.t, tz), vals[i]]; }), color: c.live, lineWidth: 2.25, marker: { enabled: false } }];
    o.tooltip.formatter = function () { var d = new Date(this.x); return '<div class="tt"><div class="tt-h">' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + '</div><div class="tt-s">Cooling rate, all stations</div>' +
      tipRow(c.live, 'Solid', 'Rate', sgn(this.y, 1) + ' ' + lUnit(), '', true) + '</div>'; };
    CH.chartLiveTrend = Highcharts.chart(o);
  }

  /* ---------- model levels and pressure card ---------- */
  function hypRun() { return S.cmp.filter(function (c) { return c.id === 'hypsometric'; })[0] || null; }
  function uaHourIdx() { var n = S.fc ? S.fc.rows.length : 0; return n ? Math.min(Math.max(S.uaHour, 0), n - 1) : 0; }
  function renderUA() {
    var U = S.ua, P = S.pr, ua = uaData(), obs = P.obs, an = P.anchor, rows = S.fc && S.fc.rows, hi = uaHourIdx();
    $('uaOn').setAttribute('aria-pressed', String(U.on)); $('uaOff').setAttribute('aria-pressed', String(!U.on));
    var errs = [];
    if (U.on && U.errors[S.peak.id]) errs.push('Could not read the model pressure levels. ' + U.errors[S.peak.id]);
    if (U.on && uaEntry() && uaEntry().stale) errs.push('The model service did not answer, so these levels are the last saved copy.');
    if (P.status === 'error') errs.push('Could not read the airport observations. ' + P.msg + (P.raw ? ' The last reading is used until it is 3 hours old.' : ''));
    else if (P.stale) errs.push('The observation service did not answer, so this is the last saved copy.');
    if (location.protocol === 'file:') showMsg('uaMsg', 'This page was opened from a file, so the model-level and observation services are not available. Serve the folder with PHP or serve.py.', 'warn');
    else showMsg('uaMsg', errs.join(' '), errs.length ? 'warn' : '');
    var hyp = hypRun(), o = hyp && hyp.res[hi] && hyp.res[hi].hy ? hyp.res[hi] : null, txt = '';
    var slider = $('uaHour'); slider.max = String(Math.max(0, (rows ? rows.length : 1) - 1)); slider.value = String(hi); slider.disabled = !(rows && rows.length > 1 && ua);
    $('uaHourVal').textContent = rows && rows[hi] ? fHour(rows[hi].t) : '';
    if (!S.fc) txt = '';
    else if (!U.on) txt = 'The model pressure levels are switched off, so the Hypsometric and Levels methods have no upper-air data unless you paste a custom forecast that carries it.';
    else if (!ua) txt = S.fcSource === 'nws' ? 'The model pressure levels have not loaded' + (U.loading ? ' yet.' : '.') + ' Until they do, the Hypsometric and Levels methods have no upper-air data.' : 'A custom forecast is in use, so the model pressure levels are not attached to it.';
    else if (o) {
      var h = o.hy;
      txt = 'At ' + fHour(o.t) + ' the summit (' + fZ(S.terrain.z) + ' ' + zUnit() + ') sits between the model’s ' + h.pLo + ' and ' + h.pHi + ' hPa levels (' + fZ(h.zLo) + ' to ' + fZ(h.zHi) + ' ' + zUnit() + '). The model’s free-air temperature at the summit’s height is ' + fT(h.free, 1) + ' ' + tUnit() + '. ' +
        (h.freeCell != null ? 'The NWS cell reads ' + sgn(dU(h.inc), 1) + ' ' + tUnit() + ' against the model at the cell’s height, and that difference is carried to the summit at ' + Math.round(h.w * 100) + '% strength, so ' : 'The NWS cell is too far below the model levels to compare, so ') +
        'the Hypsometric method gives ' + fT(h.tS, 1) + ' ' + tUnit() + ' and a summit pressure near ' + h.pS.toFixed(0) + ' hPa.';
    } else txt = 'The model levels are loaded, but none bracket the summit at this hour, or they failed the thickness check, so Hypsometric falls back to the Conditions rate for it.';
    if (S.fc) {
      if (obs && obs.ok) {
        txt += ' Observed sea-level pressure ' + obs.stations.map(function (s) { return s.id + ' ' + s.mslp.toFixed(1); }).join(', ') + ' hPa at ' + fClock(obs.t) +
          (obs.tend3 != null ? ', ' + (obs.tend3 < -0.3 ? 'falling' : obs.tend3 > 0.3 ? 'rising' : 'steady') + ' ' + Math.abs(obs.tend3).toFixed(1) + ' hPa per 3 h' : '') + '.';
        if (an && an.applied) txt += ' The model reads ' + an.mslpModel.toFixed(1) + ' then, so its pressure is moved by ' + sgn(an.dP, 1) + ' hPa, fading over 12 hours.' + (an.flag === 'far' ? ' That is a large miss; treat the model’s timing of pressure changes with caution.' : '');
        if (obs.warnings.length) txt += ' ' + obs.warnings.join(' ');
      } else txt += ' No observed pressure is available' + (obs && obs.warnings.length ? ' (' + obs.warnings[0] + ')' : P.status === 'error' ? '' : ' yet') + '.';
    }
    $('uaLede').textContent = txt;
    // the levels at the chosen hour
    var tb = clear($('uaTbl')), lev = rows && rows[hi] && rows[hi].lev;
    if (lev && lev.length) {
      var thead = el('thead'), hr = el('tr'); ['Level', 'Height ' + zUnit(), 'Temperature ' + tUnit(), 'Humidity', 'Cooling to the next level', 'Thickness check'].forEach(function (x) { hr.append(el('th', '', x)); }); thead.append(hr); tb.append(thead);
      var body = el('tbody');
      lev.forEach(function (L, k) {
        var N = lev[k + 1], tr = el('tr', o && o.hy.pLo === L.p ? 'sel' : ''), qc = null;
        if (N) { var pr = Core.levelProfile(lev, (L.z + N.z) / 2, 0); qc = pr ? pr.qc : null; }
        [L.p + ' hPa', fZ(L.z), fT(L.t, 1), L.rh != null ? Math.round(L.rh) + '%' : '—', N ? lapseU((L.t - N.t) / (N.z - L.z) * 1000).toFixed(1) + ' ' + lUnit() : '—',
          qc == null ? '—' : sgn(dU(qc), 1) + ' ' + tUnit()].forEach(function (v) { tr.append(el('td', '', v)); });
        body.append(tr);
      });
      tb.append(body);
    }
    $('uaNote').textContent = 'Model levels come from Open-Meteo (NOAA GFS/HRRR and others); observed pressure from the NWS observations at Mt Washington Regional (KHIE) and Eastern Slopes Regional (KIZG). Thickness check: a layer’s mean virtual temperature from its heights (the hypsometric equation) less the mean of its two level temperatures; more than ' + Core.HYPSO_QC_K.toFixed(1) + ' K rejects the hour. ' +
      'Observed pressure is deliberately not fed into the thickness: 1 hPa of error there would move the layer’s implied lapse rate by about 3 K/km for a cell near Mount Washington’s height (2 at 1,400 m, 0.6 at 300 m). It sets the weather regime and the model check, and it moves the summit pressure.';
  }

  function drawUA(c) {
    var host = $('chartUA'), rows = S.fc && S.fc.rows, hi = uaHourIdx();
    if (!rows || !rows[hi] || !rows[hi].lev) { clear(host); return; }
    var lev = rows[hi].lev, hyp = hypRun(), o = hyp && hyp.res[hi] && hyp.res[hi].hy ? hyp.res[hi].hy : null, zC = S.zModel, zS = S.terrain.z;
    var zLo = Math.min(zC, zS) - 1000, zHi = Math.max(zC, zS) + 1150, vis = lev.filter(function (L) { return L.z >= zLo && L.z <= zHi; });
    if (vis.length < 2) vis = lev;
    var ts = vis.map(function (L) { return L.t; }).concat([rows[hi].temp]);
    var stn = hi === 0 && S.lv && S.lv.ok ? S.lv.used : [];
    stn.forEach(function (s) { ts.push(s.T); });
    var oo = baseLiveOptions(c, 'chartUA', 380), fam = c.fam.profile;
    oo.xAxis = { title: { text: 'Temperature (' + tUnit() + ')', style: { color: c.muted, fontWeight: '400', fontSize: '12px' } }, gridLineWidth: 1, gridLineColor: c.grid, lineColor: c.line, tickColor: c.line,
      labels: { style: { color: c.muted, fontSize: '11px', fontFamily: c.mono }, formatter: function () { return String(Math.round(this.value * 10) / 10).replace('-', '−'); } }, startOnTick: true, endOnTick: true, tickPixelInterval: 60 };
    oo.yAxis = yAxisOptions(c, 'Elevation (' + zUnit() + ')', { softMin: zUn(zLo), softMax: zUn(zHi), startOnTick: false, endOnTick: false, tickPixelInterval: 55,
      labels: { style: { color: c.muted, fontSize: '11px', fontFamily: c.mono }, formatter: function () { return Math.round(this.value).toLocaleString('en-US'); } },
      plotLines: [{ value: zUn(zS), color: c.marker, width: 1.5, dashStyle: 'Dash', zIndex: 1, label: { text: 'Summit', align: 'left', x: 4, y: -4, style: { color: c.muted, fontSize: '11px' } } },
        { value: zUn(zC), color: c.faint, width: 1, dashStyle: 'Dash', zIndex: 1, label: { text: 'NWS cell', align: 'left', x: 4, y: -4, style: { color: c.muted, fontSize: '11px' } } }] });
    var lab = { enabled: true, align: 'left', x: 9, y: 4, allowOverlap: true, crop: false, overflow: 'allow', style: { color: c.muted, fontSize: '11px', fontWeight: '400', textOutline: 'none', fontFamily: c.mono }, formatter: function () { return this.point.name; } };
    oo.series = [
      { type: 'scatter', name: 'Model pressure levels', data: vis.map(function (L) { return { x: tU(L.t), y: zUn(L.z), name: L.p + ' hPa' }; }), color: fam, lineWidth: 2, zIndex: 3, dataLabels: lab,
        marker: { enabled: true, symbol: 'circle', radius: 4, fillColor: fam, lineColor: c.surface, lineWidth: 1.5 } },
      { type: 'scatter', name: 'NWS cell forecast', data: [{ x: tU(rows[hi].temp), y: zUn(zC), name: 'NWS cell' }], color: c.ink, zIndex: 6,
        marker: { enabled: true, symbol: 'circle', radius: 6, fillColor: c.ink, lineColor: c.surface, lineWidth: 2 } }
    ];
    if (o && o.freeCell != null) oo.series.push(
      { type: 'scatter', name: 'Model at the cell height', data: [{ x: tU(o.freeCell), y: zUn(zC), name: 'Model' }], color: c.ink, zIndex: 5, marker: { enabled: true, symbol: 'circle', radius: 5.5, fillColor: c.surface, lineColor: c.ink, lineWidth: 2 } },
      { type: 'scatter', name: 'NWS minus model', data: [[tU(o.freeCell), zUn(zC)], [tU(rows[hi].temp), zUn(zC)]], color: c.muted, lineWidth: 2, dashStyle: 'ShortDash', zIndex: 4, marker: { enabled: false } });
    if (o) oo.series.push(
      { type: 'scatter', name: 'Free air at the summit', data: [{ x: tU(o.free), y: zUn(zS), name: 'Free air' }], color: fam, zIndex: 5, marker: { enabled: true, symbol: 'diamond', radius: 6, fillColor: c.surface, lineColor: fam, lineWidth: 2 } },
      { type: 'scatter', name: 'Hypsometric at the summit', data: [{ x: tU(o.tS), y: zUn(zS), name: 'Hypsometric' }], color: fam, zIndex: 7, marker: { enabled: true, symbol: 'diamond', radius: 7.5, fillColor: fam, lineColor: c.surface, lineWidth: 2 } });
    if (stn.length) oo.series.push({ type: 'scatter', name: 'Auto Road stations, latest', data: stn.map(function (s) { return { x: tU(s.T), y: zUn(s.z), name: s.id }; }), color: c.muted, zIndex: 4,
      marker: { enabled: true, symbol: 'circle', radius: 3.5, fillColor: c.muted, lineColor: c.surface, lineWidth: 1 } });
    oo.tooltip.formatter = function () {
      return '<div class="tt"><div class="tt-h">' + esc(this.series.name) + '</div><div class="tt-s">' + (this.point.name && /hPa$|^[A-Z]{2}\d\d$|^SUMT$/.test(this.point.name) ? esc(this.point.name) + ' · ' : '') + this.x.toFixed(1) + '° at ' + Math.round(this.y).toLocaleString('en-US') + ' ' + zUnit() + '</div></div>';
    };
    CH.chartUA = Highcharts.chart(oo);
  }

  function drawUAp(c) {
    var host = $('chartUAp'), ua = uaData(), rows = S.fc && S.fc.rows, obs = S.pr.obs, an = S.pr.anchor;
    if (!ua || !rows || !rows.length) { clear(host); return; }
    var tz = tzOf(S.peak), t0 = rows[0].t, from = t0 - 8 * 3600e3, to = t0 + 72 * 3600e3;
    var recs = ua.times.filter(function (t) { return t >= from && t <= to; }).map(function (t) { return ua.byT[t]; }).filter(function (r) { return r.mslp != null; });
    if (recs.length < 3) { clear(host); return; }
    var o = baseLiveOptions(c, 'chartUAp', 330), fam = c.fam.profile;
    o.xAxis = { type: 'datetime', title: { text: null }, lineColor: c.line, tickColor: c.line, gridLineWidth: 1, gridLineColor: c.grid, tickPixelInterval: 80,
      labels: { style: { color: c.muted, fontSize: '11px', fontFamily: c.mono }, formatter: function () { return fHour(this.value); } } };
    o.yAxis = yAxisOptions(c, 'Sea-level pressure (hPa)', {});
    o.series = [{ type: 'line', name: 'Model as issued', data: recs.map(function (r) { return [r.t, r.mslp]; }), color: c.muted, dashStyle: 'ShortDash', lineWidth: 2, marker: { enabled: false }, zIndex: 2 }];
    if (an && an.applied) o.series.push({ type: 'line', name: 'Model, adjusted to observations', data: recs.map(function (r) { return [r.t, Math.round(Core.anchoredMslp(r, an) * 100) / 100]; }), color: fam, lineWidth: 2.75, marker: { enabled: false }, zIndex: 4 });
    var shapes = ['circle', 'square', 'diamond'];
    (obs && obs.series ? obs.series : []).forEach(function (s, k) {
      o.series.push({ type: 'scatter', name: s.id + ' observed', data: s.pts.map(function (p) { return [Core.wallMs(p.t, tz), Math.round(p.p * 100) / 100]; }).filter(function (d) { return d[0] >= from; }), color: c.ink, zIndex: 6,
        marker: { enabled: true, symbol: shapes[k % 3], radius: 4.5, fillColor: k ? c.surface : c.ink, lineColor: c.ink, lineWidth: 2 } });
    });
    o.tooltip.formatter = function () {
      var p = this.point;
      return '<div class="tt"><div class="tt-h">' + fHour(this.x) + '</div>' + tipRow(this.series.color, this.series.options.dashStyle, this.series.name, this.y.toFixed(1) + ' hPa', '', true) + '</div>';
    };
    CH.chartUAp = Highcharts.chart(o);
  }

  function drawCharts() {
    if (!S.res.length || !S.ens) return;
    destroyCharts();
    if (!window.Highcharts) {
      ['chart1', 'chartLive', 'chartLiveTrend', 'chartUA', 'chartUAp', 'chart2', 'chartReg1', 'chartReg2'].forEach(function (id) { clear($(id)).append(el('p', 'msg err', 'The charts need vendor/highcharts.js and vendor/highcharts-more.js next to index.html.')); });
      return;
    }
    var c = palette(), times = S.res.map(function (o) { return o.t; });
    drawMain(c, times); drawLive(c); drawLiveTrend(c); drawUA(c); drawUAp(c); drawFreeze(c, times); drawRegional(c, times);
    var above = S.res.filter(function (o) { return o.freezeZ != null && o.freezeZ > S.terrain.z; }).length;
    $('freezeNote').textContent = (above ? 'The freezing level is above the summit for ' + above + ' of ' + S.res.length + ' hours, so those hours are above freezing at the top.' : 'The freezing level stays below the summit for the whole period.') + ' It comes from the selected method’s summit temperature and lapse rate, the rate held between ' + lapseU(3.5).toFixed(1) + ' and ' + lapseU(11).toFixed(1) + ' ' + lUnit() + '.';
  }

  function renderTable() {
    var tb = clear($('tbl')), hasW = S.fc.cols.wind, hasP = S.fc.cols.precip;
    var liveCol = !!(S.lv && S.lv.ok && S.lv.adj.w.some(function (w) { return w > 0; }));
    var head = ['Time', 'Model ' + tUnit(), 'Summit ' + tUnit()];
    if (liveCol) head.push(LIVE_NAME + ' ' + tUnit());
    if (hasW) head.push('Feels ' + tUnit(), 'Wind ' + wUnit());
    if (hasP) head.push('Precip');
    head.push('Lapse', 'Freeze ' + zUnit(), 'Summit hPa', 'Regional weather');
    var thead = el('thead'), hr = el('tr'); head.forEach(function (h) { hr.append(el('th', '', h)); }); thead.append(hr); tb.append(thead);
    var body = el('tbody'), fb = 0, std = 0;
    S.res.forEach(function (o, i) {
      var tr = el('tr', (o.tSummit <= 0 ? 'cold' : '') + (new Date(o.t).getUTCHours() === 0 ? ' day' : ''));
      var rg = S.regimes[i];
      var fell = o.source !== S.method; if (fell) fb++; if (o.pSrc === 'standard') std++;
      var c = [fHour(o.t), fT(o.tModel, 1), fT(o.tSummit, 1)];
      if (liveCol) c.push(S.lv.adj.live[i] == null ? '' : fT(S.lv.adj.live[i], 1));
      if (hasW) c.push(fT(o.feels, 0), o.wSummit == null ? '' : fW(o.wSummit));
      if (hasP) c.push(o.precip ? o.precip.toFixed(1) + ' mm ' + o.phase : '');
      c.push(lapseU(o.gamma).toFixed(1) + (fell ? '*' : ''), o.freezeZ == null ? '' : fZ(o.freezeZ), o.pSummit.toFixed(1), rg ? rg.label + (rg.pressure === 'neutral' ? '' : ' \u00b7 ' + rg.pressure) : '');
      c.forEach(function (v, k) { var td = el('td', '', v); if (k === c.length - 1) td.style.textAlign = 'left'; tr.append(td); }); body.append(tr);
    });
    tb.append(body);
    $('fbNote').textContent = fb ? '* This hour used the Conditions rate because the method\u2019s inputs were missing.' : '';
    $('pNote').textContent = std ? 'Summit pressure starts from the standard atmosphere at the model cell height because no pressure is available for this forecast' + (S.fcSource === 'nws' ? ' (the model pressure levels have not loaded).' : ' (add a p_sfc_hpa or mslp_hpa column).') : '';
  }

  /* ---------- CSV export ---------- */
  function csvText() {
    var rows = [['time', 'model_temp_c', 'summit_temp_c', 'feels_like_c', 'summit_wind_kph', 'lapse_k_per_km', 'freezing_level_m', 'summit_pressure_hpa', 'precip_mm', 'precip_type', 'method',
      'most_likely_c', 'methods_min_c', 'methods_p5_c', 'methods_p10_c', 'methods_p25_c', 'methods_p50_c', 'methods_mean_c', 'methods_p75_c', 'methods_p90_c', 'methods_p95_c', 'methods_max_c', 'weighting', 'regional_regime', 'pressure_signature', 'most_likely_before_live_c', 'mwarvtp_c', 'live_weight', 'pressure_source']];
    var lvOk = !!(S.lv && S.lv.ok && S.live.on);
    S.res.forEach(function (o, i) {
      var h = S.ens && S.ens.hours[i], rg = S.regimes[i];
      rows.push([Core.isoLocal(o.t), o.tModel.toFixed(2), o.tSummit.toFixed(2), o.feels.toFixed(1), o.wSummit == null ? '' : o.wSummit.toFixed(0), o.gamma.toFixed(2),
        o.freezeZ == null ? '' : Math.round(o.freezeZ), o.pSummit.toFixed(1), o.precip == null ? '' : o.precip, o.phase, o.source,
        h ? h.ml.toFixed(2) : ''].concat(Core.LEVELS.map(function (L, k) { return h ? Core.levelValues(h)[k].toFixed(2) : ''; })).concat([S.ens ? S.ens.mode : '', rg ? rg.label : '', rg ? rg.pressure : '',
        h ? h.ml.toFixed(2) : '', lvOk && S.lv.adj.live[i] != null ? S.lv.adj.live[i].toFixed(2) : '', lvOk ? (S.lv.adj.w[i] * S.lv.conf.k).toFixed(3) : '', o.pSrc || '']));
    });
    // RFC 4180: a field with a comma, quote or line break is wrapped in quotes (regime labels such as "Clear and calm, day" have commas)
    var cell = function (v) { v = String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    return rows.map(function (r) { return r.map(cell).join(','); }).join('\n');
  }
  async function doExport() {
    if (!S.res.length) return;
    var text = csvText(), done = false;
    try {
      var dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null;
      if (dl) { await dl.save({ filename: S.peak.id + '-forecast.csv', data: text }); done = true; showMsg('exportMsg', 'Saved ' + S.peak.id + '-forecast.csv.'); }
    } catch (e) { /* declined or unavailable: fall through to copy */ }
    if (!done) {
      try { await navigator.clipboard.writeText(text); showMsg('exportMsg', 'Copied the CSV to your clipboard.'); done = true; } catch (e) {}
    }
    if (!done) {
      showMsg('exportMsg', 'Select the text below and copy it.', 'warn');
      var ta = document.createElement('textarea'); ta.value = text; ta.readOnly = true; ta.style.marginTop = '8px'; ta.id = 'exportTa'; $('exportMsg').append(ta); ta.focus(); ta.select();
    }
  }

  /* ---------- tabs ---------- */
  var TABS = [['pk', 'tab-pk', 'p-pk'], ['fc', 'tab-fc', 'p-fc'], ['in', 'tab-in', 'p-in']];
  function setTab(id) {
    S.tab = id;
    TABS.forEach(function (t) { $(t[1]).setAttribute('aria-selected', String(t[0] === id)); $(t[2]).hidden = t[0] !== id; });
    if (id === 'fc') drawCharts();
    window.scrollTo(0, 0);
  }

  /* ---------- wiring ---------- */
  function setUnits(imp) {
    S.imperial = imp; $('u-metric').setAttribute('aria-pressed', String(!imp)); $('u-imp').setAttribute('aria-pressed', String(imp));
    try { localStorage.setItem('sd-units', imp ? 'imp' : 'metric'); } catch (e) {}
    recompute();
  }
  function pressed(host, attr, val) { Array.prototype.forEach.call(host.querySelectorAll('button'), function (b) { b.setAttribute('aria-pressed', String(b.getAttribute(attr) === String(val))); }); }
  /* ---------- theme ---------- */
  var THEME = 'auto', darkMq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function setTheme(t, save) {
    THEME = t;
    if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
    pressed($('themeSeg'), 'data-t', t);
    if (save) { try { if (t === 'auto') localStorage.removeItem('sd-theme'); else localStorage.setItem('sd-theme', t); } catch (e) {} }
    if (S.tab === 'fc') drawCharts();      // the charts read their colors when drawn
  }
  $('themeSeg').onclick = function (e) { var b = e.target.closest('button'); if (b) setTheme(b.getAttribute('data-t'), true); };
  if (darkMq) {
    var onScheme = function () { if (THEME === 'auto' && S.tab === 'fc') drawCharts(); };
    if (darkMq.addEventListener) darkMq.addEventListener('change', onScheme); else if (darkMq.addListener) darkMq.addListener(onScheme);
  }
  $('u-metric').onclick = function () { setUnits(false); };
  $('u-imp').onclick = function () { setUnits(true); };
  TABS.forEach(function (t) { $(t[1]).onclick = function () { setTab(t[0]); }; });
  PEAKS.forEach(function (p) { var o = document.createElement('option'); o.value = p.id; o.textContent = p.rank + '. ' + p.name + ' · ' + p.ft.toLocaleString('en-US') + ' ft'; $('peakSel').append(o); });
  $('peakSel').onchange = function () { var p = PEAKS.filter(function (q) { return q.id === $('peakSel').value; })[0]; if (p) setPeak(p); };
  $('winSeg').onclick = function (e) { var b = e.target.closest('button'); if (!b) return; S.win = +b.getAttribute('data-h'); pressed($('winSeg'), 'data-h', S.win); recompute(); };
  $('sortSeg').onclick = function (e) { var b = e.target.closest('button'); if (!b) return; S.sort = b.getAttribute('data-s'); pressed($('sortSeg'), 'data-s', S.sort); renderOverview(); };
  $('nwsRefresh').onclick = function () { loadFromServer(true, false); };
  $('nwsFile').onchange = function () { onNwsFile(this.files[0]); this.value = ''; };
  $('nwsExample').onclick = function () { loadExampleNws(); afterNwsChange('bundle'); };
  $('nwsPasteGo').onclick = function () {
    try { var kind = applyNwsText($('nwsPaste').value); afterNwsChange(kind); } catch (e) { showMsg('nwsMsg', e.message, 'err'); }
  };
  var dstn; $('stText').oninput = function () { S.stnExample = false; clearTimeout(dstn); dstn = setTimeout(parseStationText, 250); };
  $('stFile').onchange = async function () {
    var f = this.files[0]; if (!f) return;
    try { $('stText').value = await readFileAs(f, 'text'); S.stnExample = false; parseStationText(); } catch (e) { showMsg('stMsg', e.message, 'err'); }
    this.value = '';
  };
  $('stExample').onclick = loadExampleStations;
  function onTgt() { S.tgt = { lat: parseFloat($('tgtLat').value), lon: parseFloat($('tgtLon').value) }; if (S.stn) { S.stnPrep = null; reprepStations(); parseStationText(); } }
  $('tgtLat').oninput = onTgt; $('tgtLon').oninput = onTgt;
  $('radius').oninput = function () { S.radius = parseFloat(this.value); recompute(); };
  $('decay').oninput = function () { S.decay = parseFloat(this.value); recompute(); };
  $('bandwidth').oninput = function () { S.bandwidth = parseFloat(this.value); recompute(); };
  $('presetRow').onclick = function (e) { var b = e.target.closest('button'); if (!b || b.disabled) return; S.gamma = parseFloat(b.getAttribute('data-g')); recompute(); };
  $('climDiurnal').oninput = function () { S.climDiurnal = parseFloat(this.value); recompute(); };
  $('climReset').onclick = function () { S.clim = Core.CLIM_DEFAULT.slice(); S.climDiurnal = 1.0; recompute(); };
  $('zModel').oninput = function () { var v = parseFloat(this.value); if (isFinite(v)) { S.zOverride = S.imperial ? v / 3.28084 : v; recompute(); } };
  $('zNws').onclick = function () { S.zOverride = null; recompute(); };
  $('gamma').oninput = function () { S.gamma = parseFloat(this.value); recompute(); };
  $('damp').oninput = function () { S.damp = parseFloat(this.value); recompute(); };
  $('speed').oninput = function () { S.speed = parseFloat(this.value); recompute(); };
  $('bias').oninput = function () { S.bias = parseFloat(this.value); recompute(); };
  var deb; $('fcText').oninput = function () { S.fcCustomExample = false; clearTimeout(deb); deb = setTimeout(parseForecastText, 250); };
  $('fcFile').onchange = async function () {
    var f = this.files[0]; if (!f) return;
    try { $('fcText').value = await readFileAs(f, 'text'); S.fcCustomExample = false; parseForecastText(); } catch (e) { showMsg('fcMsg', e.message, 'err'); }
    this.value = '';
  };
  $('fcExample').onclick = loadExampleForecast;
  $('fcClear').onclick = function () { $('fcText').value = ''; parseForecastText(); };
  $('exportBtn').onclick = doExport;
  $('wSeg').onclick = function (e) { var b = e.target.closest('button'); if (!b) return; S.weighting = b.getAttribute('data-w'); recompute(); };
  $('hSeg').onclick = function (e) { var b = e.target.closest('button'); if (!b) return; S.hourLabels = b.getAttribute('data-h'); renderLikelyNote(); if (S.tab === 'fc') drawCharts(); };
  $('liveOnSeg').onclick = function (e) { var b = e.target.closest('button'); if (!b) return; S.live.on = b.getAttribute('data-v') === '1'; saveLive(); recompute(); };
  $('liveHSeg').onclick = function (e) { var b = e.target.closest('button'); if (!b) return; S.live.hours = +b.getAttribute('data-h'); saveLive(); recompute(); };
  $('liveTower').onchange = function () { S.live.tower = this.checked; saveLive(); recompute(); };
  $('liveRefresh').onclick = function () { loadAutoRoad(false); };
  $('uaOnSeg').onclick = function (e) { var b = e.target.closest('button'); if (!b) return; S.ua.on = b.getAttribute('data-v') === '1'; saveUa(); recompute(); if (S.ua.on) loadUpperAir(true); };
  $('uaRefresh').onclick = function () { loadUpperAir(false, true); loadPressure(false); };
  $('uaHour').oninput = function () { S.uaHour = +this.value; renderUA(); if (S.tab === 'fc' && window.Highcharts) { var c = palette(); if (CH.chartUA) { try { CH.chartUA.destroy(); } catch (e) {} delete CH.chartUA; } drawUA(c); } };
  var rz; window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(function () { if (S.tab === 'fc') drawCharts(); }, 120); });
  document.fonts && document.fonts.ready && document.fonts.ready.then(function () { if (S.tab === 'fc') drawCharts(); });

  /* ---------- boot ---------- */
  $('u-metric').setAttribute('aria-pressed', String(!S.imperial)); $('u-imp').setAttribute('aria-pressed', String(S.imperial));
  var savedTheme = 'auto'; try { var st0 = localStorage.getItem('sd-theme'); if (st0 === 'light' || st0 === 'dark') savedTheme = st0; } catch (e) {}
  setTheme(savedTheme, false);
  buildClim();
  loadExampleNws();
  if (DIRECT()) $('nwsHelp').textContent = 'In this app there is no server: it asks api.weather.gov itself and keeps the answer on the phone for an hour, so the forecast is still there when you are offline. To work from a saved copy instead, load a .json file of the same kind, or paste one summit\u2019s /gridpoints response.';
  $('peakSel').value = S.peak.id;
  syncTarget();
  locate(); recompute();
  if (location.protocol === 'file:') {
    showMsg('nwsMsg', 'This page was opened from a file, so the PHP service is not available. Serve the folder with PHP to get live forecasts (see the README).', 'warn');
    $('nwsRefresh').disabled = true;
  } else {
    loadFromServer(false);
    loadAutoRoad(false);
    loadUpperAir(true); loadPressure(true);
    setInterval(function () { if (!document.hidden) loadUpperAir(true, true); }, UA_REFRESH_MS);
    setInterval(function () { if (!document.hidden) loadPressure(true); }, MT_REFRESH_MS);
    setInterval(function () { if (!document.hidden) loadFromServer(false, true); }, 15 * 60 * 1000);
    setInterval(function () { if (!document.hidden) loadAutoRoad(true); }, AR_REFRESH_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && S.live.at && Date.now() - S.live.at > 3 * 60e3) loadAutoRoad(true); });
  }
})();
