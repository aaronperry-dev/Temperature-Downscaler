/* Summit Downscaler core: forecast parsing, NWS gridpoint parsing, pressure, and the downscaling methods (fixed, conditions,
   adiabatic parcel, monthly climatology, levels, hypsometric, BCDG, elevation regression, local regression, GIDS, consensus).
   Works in the browser (global Core) and in Node (module.exports) so it can be tested. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var M_PER_DEG_LAT = 110950;
  var M_PER_DEG_LON = 111320;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function clamp01(v) { return clamp(v, 0, 1); }

  /* ----------------------------------------------------------- forecast */

  var ALIASES = {
    time: ['time', 'datetime', 'date', 'timestamp', 'valid', 'valid_time', 'validtime'],
    temp: ['temp_c', 't2m_c', 'temperature_c', 'temp', 't2m', 'temperature', 'tmp', 'temp_f', 't2m_f', 'temperature_f'],
    rh: ['rh', 'rh_pct', 'humidity', 'relative_humidity', 'rh2m'],
    wind: ['wind_kph', 'wind_kmh', 'wind', 'wind_speed', 'wind_mph', 'wind_ms', 'wind_mps'],
    cloud: ['cloud', 'cloud_pct', 'cloud_cover', 'clouds'],
    precip: ['precip_mm', 'precip', 'rain', 'precipitation', 'rain_mm'],
    tU: ['t_upper_c', 't_upper', 't850_c', 't700_c', 't850', 't700', 'temp_upper', 'temp_upper_c'],
    zU: ['z_upper_m', 'z_upper', 'z850_m', 'z700_m', 'z850', 'z700', 'height_upper', 'height_upper_m'],
    pSfc: ['p_sfc_hpa', 'psfc_hpa', 'sp_hpa', 'surface_pressure_hpa', 'station_pressure_hpa', 'p_sfc', 'pressure_hpa', 'pressure'],
    mslp: ['mslp_hpa', 'slp_hpa', 'pmsl_hpa', 'mslp', 'slp'],
    pU: ['p_upper_hpa', 'p_level_hpa', 'plevel_hpa', 'p_upper']
  };

  function num(s) {
    if (s == null) return null;
    s = String(s).trim();
    if (s === '' || /^(nan|na|null|none|-)$/i.test(s)) return null;
    var v = Number(s);
    return v === v ? v : null;
  }

  function parseTime(s) {
    s = String(s).trim().replace(/(Z|[+-]\d\d:?\d\d)$/i, '').replace(' ', 'T');
    if (/^\d{4}-\d\d-\d\d$/.test(s)) s += 'T00:00';
    var t = Date.parse(s + (/T\d\d:\d\d(:\d\d)?$/.test(s) ? 'Z' : ''));
    return t === t ? t : null;
  }

  function parseForecast(text) {
    var out = { rows: [], cols: {}, warnings: [] };
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim() && !/^\s*#/.test(l); });
    if (lines.length < 2) { out.warnings.push('Paste a header row and at least one data row.'); return out; }
    var first = lines[0];
    var delim = first.indexOf('\t') >= 0 ? '\t' : first.indexOf(';') >= 0 && first.indexOf(',') < 0 ? ';' : ',';
    var head = first.split(delim).map(function (h) { return h.trim().toLowerCase().replace(/[\s\-()°%]+/g, '_').replace(/^_+|_+$/g, ''); });
    var idx = {}, unit = {};
    Object.keys(ALIASES).forEach(function (k) {
      for (var a = 0; a < ALIASES[k].length; a++) {
        var j = head.indexOf(ALIASES[k][a]);
        if (j >= 0) { idx[k] = j; unit[k] = ALIASES[k][a]; break; }
      }
    });
    if (idx.time == null) { out.warnings.push('No time column found. Name it time, datetime or timestamp.'); return out; }
    if (idx.temp == null) { out.warnings.push('No temperature column found. Name it temp_c (or temp_f).'); return out; }
    var skipped = 0;
    for (var i = 1; i < lines.length; i++) {
      var p = lines[i].split(delim);
      var t = parseTime(p[idx.time]), T = num(p[idx.temp]);
      if (t == null || T == null) { skipped++; continue; }
      var row = { t: t, temp: /_f$/.test(unit.temp) ? (T - 32) * 5 / 9 : T };
      ['rh', 'wind', 'cloud', 'precip', 'tU', 'zU', 'pSfc', 'mslp', 'pU'].forEach(function (k) {
        if (idx[k] == null) return;
        var v = num(p[idx[k]]);
        if (v == null) return;
        if (k === 'wind') {
          if (unit.wind === 'wind_mph') v *= 1.609344;
          else if (unit.wind === 'wind_ms' || unit.wind === 'wind_mps') v *= 3.6;
        }
        if ((k === 'pSfc' || k === 'mslp' || k === 'pU') && v > 2000) v /= 100; // Pa -> hPa
        row[k] = v;
      });
      out.rows.push(row);
    }
    out.rows.sort(function (a, b) { return a.t - b.t; });
    out.cols = { rh: idx.rh != null, wind: idx.wind != null, cloud: idx.cloud != null, precip: idx.precip != null,
      levels: idx.tU != null && idx.zU != null, thickness: idx.zU != null, pressure: idx.pSfc != null || idx.mslp != null };
    if (skipped) out.warnings.push(skipped + ' row' + (skipped > 1 ? 's' : '') + ' skipped (bad time or temperature).');
    if (!out.rows.length) out.warnings.push('No usable rows.');
    return out;
  }

  /* ---------------------------------------------- pressure and hypsometry */

  var G0 = 9.80665, RD = 287.05, EPS = 0.622;
  function satVapPa(tC) { return 611.2 * Math.exp(17.67 * tC / (tC + 243.5)); } // Bolton (1980)
  function specHum(rh, tC, pHpa) {              // specific humidity (kg/kg) from relative humidity
    if (rh == null) return 0;
    var e = clamp(rh, 0, 100) / 100 * satVapPa(tC), p = pHpa * 100;
    return EPS * e / (p - (1 - EPS) * e);
  }
  function satSpecHum(tC, pHpa) { return specHum(100, tC, pHpa); }
  function virtualK(tC, q) { return (tC + 273.15) * (1 + 0.608 * q); }
  function stdPressure(z) { return 1013.25 * Math.pow(1 - 2.25577e-5 * z, 5.25588); }
  function pressureFromMslp(mslp, z, tC) { return mslp * Math.exp(-G0 * z / (RD * (tC + 273.15 + 0.00325 * z))); }

  // hypsometric equation: pressure after climbing dz metres through a layer of mean virtual temperature tvMean (K)
  function hypsoPressure(p1, tvMean, dz) { return p1 * Math.exp(-G0 * dz / (RD * tvMean)); }

  // layer thickness (m) between pBase and pTop when virtual temperature falls linearly with height at gam K/m
  function hypsoThickness(tvBase, pBase, pTop, gam) {
    if (Math.abs(gam) < 1e-7) return RD * tvBase / G0 * Math.log(pBase / pTop);
    return tvBase / gam * (1 - Math.pow(pTop / pBase, RD * gam / G0));
  }

  // the cooling rate (K/m) that makes the hypsometric thickness equal the model's pBase-to-pTop thickness dz
  function solveGamma(tvBase, pBase, pTop, dz) {
    var lo = -0.010, hi = 0.020;
    if (dz >= hypsoThickness(tvBase, pBase, pTop, lo)) return lo;
    if (dz <= hypsoThickness(tvBase, pBase, pTop, hi)) return hi;
    for (var k = 0; k < 50; k++) {
      var mid = (lo + hi) / 2;
      if (hypsoThickness(tvBase, pBase, pTop, mid) > dz) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  function modelPressure(row, zM) {
    if (row.pSfc != null) return { p: row.pSfc, src: 'model' };
    if (row.mslp != null) return { p: pressureFromMslp(row.mslp, zM, row.temp), src: 'mslp' };
    return { p: stdPressure(zM), src: 'standard' };
  }

  // pressure at the summit for any downscaled temperature tS
  function summitPressure(pM, tM, rh, tS, dz) {
    var qM = specHum(rh, tM, pM), tvM = virtualK(tM, qM), p = hypsoPressure(pM, tvM, dz);
    for (var k = 0; k < 2; k++) {
      var tvS = virtualK(tS, Math.min(qM, satSpecHum(tS, p)));
      p = hypsoPressure(pM, (tvM + tvS) / 2, dz);
    }
    return p;
  }

  // Hypsometric downscaling for one hour. The model's surface pressure, 2 m temperature and the geopotential
  // height of an upper pressure level fix the layer-mean virtual temperature; the virtual lapse rate that
  // reproduces that thickness carries the temperature up to the summit.
  function hypsoHour(r, zM, zS, pM) {
    var pU = r.pU != null ? r.pU : 700, dzU = r.zU - zM;
    var qM = specHum(r.rh, r.temp, pM), tvM = virtualK(r.temp, qM);
    var gam = solveGamma(tvM, pM, pU, dzU), tvU = tvM - gam * dzU, tvS;
    if (zS <= r.zU) tvS = tvM - gam * (zS - zM); else tvS = tvU - 0.0065 * (zS - r.zU);
    var tS = tvS / (1 + 0.608 * qM) - 273.15, pS;
    for (var k = 0; k < 3; k++) {
      pS = hypsoPressure(pM, (tvM + tvS) / 2, zS - zM);
      tS = tvS / (1 + 0.608 * Math.min(qM, satSpecHum(tS, pS))) - 273.15;
    }
    return { tS: tS, gammaV: gam * 1000, meanTv: G0 * dzU / (RD * Math.log(pM / pU)) - 273.15 };
  }

  /* ------------------------ hypsometric interpolation through the model's pressure levels */

  // The model's isobaric levels (950, 925, 900, 850, 800 and 700 hPa) each carry a temperature and a geopotential height.
  // A level is an exact pressure, so this needs no surface pressure. That is deliberate. A layer's thickness is a small difference
  // of large numbers: 1 hPa of error in a surface pressure moves the lapse rate the thickness implies by about 3 K/km for a base
  // near Mount Washington's height (2 K/km at 1,400 m, 0.6 at 300 m). Observed pressure is therefore never fed into the
  // thickness; it goes where it is robust
  // (the regime signal, a model check, the summit pressure).
  var HYPSO_LV_M = 700;      // vertical reach of the NWS-minus-model difference: it fades by 1/e over this height, m
  var HYPSO_QC_K = 2.5;      // largest allowed gap between a layer's thickness-derived and temperature-derived mean, K
  var HYPSO_BELOW_M = 400;   // how far below the lowest level the free-air profile may be extended to reach the NWS cell, m
  var HYPSO_INC_MAX = 6;     // the NWS-minus-model difference is held to this size, K

  // Free-air state at height zT (m) through levels [{p, z, t, rh}] sorted by height. The pressure at zT comes from the
  // hypsometric equation through the layer's virtual temperatures; temperature and humidity are then interpolated linearly in ln p
  // between the two levels. Null outside the levels (below the lowest only when allowBelow, in m, says how far).
  function levelProfile(lv, zT, allowBelow) {
    var n = lv ? lv.length : 0, i = -1, k;
    if (n < 2) return null;
    if (zT < lv[0].z) { if (!(allowBelow > 0) || zT < lv[0].z - allowBelow) return null; i = 0; }
    else if (zT > lv[n - 1].z) return null;
    else for (k = 0; k < n - 1; k++) if (zT <= lv[k + 1].z) { i = k; break; }
    var a = lv[i], b = lv[i + 1];
    if (!(b.z > a.z) || !(a.p > b.p)) return null;
    var qa = specHum(a.rh, a.t, a.p), qb = specHum(b.rh, b.t, b.p), tva = virtualK(a.t, qa), tvb = virtualK(b.t, qb);
    var lnab = Math.log(a.p / b.p), tvS = tva + (tvb - tva) * (zT - a.z) / (b.z - a.z), pS = a.p, tS = a.t, f = 0;
    for (k = 0; k < 5; k++) {
      pS = a.p * Math.exp(-G0 * (zT - a.z) / (RD * (tva + tvS) / 2));
      f = Math.log(a.p / pS) / lnab;
      tS = a.t + f * (b.t - a.t);
      tvS = virtualK(tS, Math.min(qa + f * (qb - qa), satSpecHum(tS, pS)));
    }
    // qc: the layer's mean virtual temperature from its thickness (the hypsometric equation) less the mean of its two ends
    return { t: tS, p: pS, f: f, gamma: -(b.t - a.t) / (b.z - a.z) * 1000, qc: G0 * (b.z - a.z) / (RD * lnab) - (tva + tvb) / 2, a: a, b: b };
  }

  // The model level nearest in height to the summit that lies above the NWS cell, for the Levels method.
  function levelNear(lv, zS, zM) {
    var best = null;
    (lv || []).forEach(function (L) { if (L.z > zM + 50 && (!best || Math.abs(L.z - zS) < Math.abs(best.z - zS))) best = L; });
    return best;
  }

  // Hypsometric downscaling for one hour from the model's pressure levels. The free-air temperature at the summit's height comes
  // from the layer that brackets it. The NWS cell then pulls it toward its own forecast: the difference between the NWS
  // temperature and the model's free-air temperature at the cell's height is carried up (or down) and fades with vertical distance,
  // so a cell sitting near the summit counts almost fully and a valley cell hardly at all.
  function hypsoLevels(r, zM, zS) {
    var lv = r.lev;
    if (!lv || lv.length < 2) return null;
    var S = levelProfile(lv, zS, 0);
    if (!S || Math.abs(S.qc) > HYPSO_QC_K) return null;
    var M = levelProfile(lv, zM, HYPSO_BELOW_M);
    var w = M ? Math.exp(-Math.abs(zS - zM) / HYPSO_LV_M) : 0, inc = M ? clamp(r.temp - M.t, -HYPSO_INC_MAX, HYPSO_INC_MAX) : 0;
    return { tS: S.t + w * inc, pS: S.p, free: S.t, freeCell: M ? M.t : null, inc: inc, w: w, gammaLayer: S.gamma, qc: S.qc, pLo: S.a.p, pHi: S.b.p, zLo: S.a.z, zHi: S.b.z };
  }

  /* ------------------------------------------- model pressure levels and observed pressure */

  var UA_FORMAT = 'nh48-upperair-v1', METAR_FORMAT = 'nh48-metar-v1', PRESSURE_TAU_H = 12;

  function finiteOrNull(v) { return v != null && v !== '' && isFinite(v) ? +v : null; }

  // Sort a level list by height and keep only physically ordered, plausible levels (pressure falls as height rises).
  function cleanLevels(lev) {
    var s = lev.filter(function (L) { return L.p > 100 && L.p < 1100 && L.z > -500 && L.z < 12000 && L.t > -90 && L.t < 50; })
      .sort(function (a, b) { return a.z - b.z; }), out = [];
    s.forEach(function (L) { if (!out.length || (L.z > out[out.length - 1].z && L.p < out[out.length - 1].p)) out.push(L); });
    return out;
  }

  // The slim answer of api/upperair.php -> hourly records keyed by the forecast's wall-clock hour (the same key the NWS rows use).
  // {format, levels:[hPa], times:[epoch s], mslp:[hPa], t:{"850":[degC]}, z:{"850":[m]}, rh:{"850":[%]}}
  function parseUpperAir(obj, tz) {
    var out = { ok: false, byT: {}, times: [], epochs: [], levels: [], warnings: [], fetched: obj && obj.fetched || null, lat: null, lon: null, elevation: null, source: obj && obj.source || '' };
    if (!obj || obj.format !== UA_FORMAT || !Array.isArray(obj.times) || !obj.times.length) { out.warnings.push('That is not a model pressure-level answer.'); return out; }
    tz = tz || 'America/New_York';
    out.lat = finiteOrNull(obj.lat); out.lon = finiteOrNull(obj.lon); out.elevation = finiteOrNull(obj.elevation);
    var lv = (obj.levels || []).map(Number).filter(function (p) { return isFinite(p) && p > 100 && p < 1100; }).sort(function (a, b) { return b - a; });
    out.levels = lv;
    var nLev = 0, nMsl = 0;
    obj.times.forEach(function (ts, i) {
      var ms = Number(ts) * 1000;
      if (!isFinite(ms)) return;
      var rec = { t: wallMs(ms, tz), epoch: ms, mslp: null, lev: [] };
      var m = finiteOrNull(obj.mslp && obj.mslp[i]);
      if (m != null && m > 850 && m < 1100) { rec.mslp = m; nMsl++; }
      var raw = [];
      lv.forEach(function (p) {
        var z = finiteOrNull(obj.z && obj.z[p] && obj.z[p][i]), tt = finiteOrNull(obj.t && obj.t[p] && obj.t[p][i]), rh = obj.rh && obj.rh[p] ? finiteOrNull(obj.rh[p][i]) : null;
        if (z != null && tt != null) raw.push({ p: p, z: z, t: tt, rh: rh != null ? clamp(rh, 1, 100) : null });
      });
      rec.lev = cleanLevels(raw);
      if (rec.lev.length >= 2) nLev++;
      out.byT[rec.t] = rec; out.times.push(rec.t); out.epochs.push(ms);
    });
    out.ok = nLev > 0;
    if (!nLev) out.warnings.push('The answer holds no usable pressure levels.');
    if (!nMsl) out.warnings.push('The answer holds no sea-level pressure.');
    return out;
  }

  // Model sea-level pressure at an instant, interpolated between hours. Null when the instant is more than 3 h outside the series.
  function modelMslpAt(ua, epochMs) {
    var ep = ua && ua.epochs, n = ep ? ep.length : 0, i;
    if (!n) return null;
    var val = function (k) { return ua.byT[ua.times[k]].mslp; };
    if (epochMs <= ep[0]) return epochMs >= ep[0] - 3 * HOUR ? val(0) : null;
    if (epochMs >= ep[n - 1]) return epochMs <= ep[n - 1] + 3 * HOUR ? val(n - 1) : null;
    for (i = 0; i < n - 1; i++) {
      if (epochMs <= ep[i + 1]) {
        var a = val(i), b = val(i + 1);
        if (a == null || b == null) return a != null ? a : b;
        return a + (b - a) * (epochMs - ep[i]) / (ep[i + 1] - ep[i]);
      }
    }
    return null;
  }

  // Station pressure to sea level. Same reduction as pressureFromMslp, inverted.
  function reduceToMsl(pStn, z, tC) {
    var t = tC != null && isFinite(tC) ? tC : 15 - 0.0065 * z;
    return pStn * Math.exp(G0 * z / (RD * (t + 273.15 + 0.00325 * z)));
  }

  // The answer of api/metar.php ({format, stations:[{id, z, obs:[{t: epoch s, temp, slp, stn}]}]}) -> the observed sea-level pressure
  // now and its 3 h tendency. Sea-level pressure is used as reported; otherwise the station pressure is reduced. Two stations that
  // differ by more than 3 hPa are not averaged: the one nearer the model is kept (opts.modelMslp(epochMs)).
  function metarPressure(data, opts) {
    opts = opts || {};
    var now = opts.now != null ? opts.now : Date.now();
    var out = { ok: false, mslp: null, t: null, tend3: null, stations: [], series: [], spread: null, warnings: [] };
    if (!data || data.format !== METAR_FORMAT || !Array.isArray(data.stations)) { out.warnings.push('That is not an observed-pressure answer.'); return out; }
    var st = [];
    data.stations.forEach(function (s) {
      var pts = [];
      (s.obs || []).forEach(function (o) {
        var t = Number(o.t) * 1000, p = null, how = '';
        var slp = finiteOrNull(o.slp), stn = finiteOrNull(o.stn), z = finiteOrNull(s.z);
        if (slp != null && slp > 940 && slp < 1070) { p = slp; how = 'slp'; }
        else if (stn != null && z != null) { var m = reduceToMsl(stn, z, finiteOrNull(o.temp)); if (m > 940 && m < 1070) { p = m; how = 'stn'; } }
        if (p != null && isFinite(t) && t <= now + 10 * 60e3 && now - t <= 8 * HOUR) pts.push({ t: t, p: p, how: how });
      });
      pts.sort(function (a, b) { return a.t - b.t; });
      if (pts.length) st.push({ id: String(s.id || '?'), pts: pts, last: pts[pts.length - 1] });
    });
    out.series = st.map(function (s) { return { id: s.id, pts: s.pts.map(function (p) { return { t: p.t, p: p.p }; }) }; });
    var fresh = st.filter(function (s) { return now - s.last.t <= 3 * HOUR; });
    if (!fresh.length) { out.warnings.push(st.length ? 'The newest observed pressure is more than 3 h old.' : 'No station reported a usable pressure.'); return out; }
    var use = fresh;
    if (fresh.length >= 2) {
      var lo = Math.min.apply(null, fresh.map(function (s) { return s.last.p; })), hi = Math.max.apply(null, fresh.map(function (s) { return s.last.p; }));
      out.spread = hi - lo;
      if (hi - lo > 3) {
        out.warnings.push('The stations differ by ' + (hi - lo).toFixed(1) + ' hPa.');
        var mm = opts.modelMslp ? opts.modelMslp(Math.max.apply(null, fresh.map(function (s) { return s.last.t; }))) : null;
        if (mm != null) { use = [fresh.slice().sort(function (a, b) { return Math.abs(a.last.p - mm) - Math.abs(b.last.p - mm); })[0]]; out.warnings.push('Kept ' + use[0].id + ', the one nearer the model.'); }
      }
    }
    out.mslp = use.reduce(function (s, x) { return s + x.last.p; }, 0) / use.length;
    out.t = Math.max.apply(null, use.map(function (s) { return s.last.t; }));
    var tends = [];
    use.forEach(function (s) {
      var pts = s.pts.filter(function (p) { return s.last.t - p.t <= 6 * HOUR; });
      if (pts.length >= 3 && pts[pts.length - 1].t - pts[0].t >= 2 * HOUR) {
        var tb = 0, pb = 0; pts.forEach(function (p) { tb += p.t / pts.length; pb += p.p / pts.length; });
        var sxy = 0, sxx = 0; pts.forEach(function (p) { sxy += (p.t - tb) * (p.p - pb); sxx += (p.t - tb) * (p.t - tb); });
        if (sxx > 0) tends.push(3 * HOUR * sxy / sxx);
      }
    });
    if (tends.length) out.tend3 = tends.reduce(function (a, b) { return a + b; }, 0) / tends.length;
    out.stations = use.map(function (s) { return { id: s.id, mslp: s.last.p, t: s.last.t, how: s.last.how }; });
    out.ok = true;
    return out;
  }

  // Observed sea-level pressure against the model's at the same instant. The difference is a measure of how far the model's
  // pressure field is off right now, and it fades with a 12 h time constant. It moves the modelled pressure and its tendency.
  // It does not touch the hypsometric temperatures (see the note above).
  function pressureAnchor(ua, obs) {
    var out = { applied: false, dP: 0, tObs: null, mslpObs: null, mslpModel: null, flag: '' };
    if (!ua || !ua.ok || !obs || !obs.ok || obs.mslp == null) return out;
    var m = modelMslpAt(ua, obs.t);
    if (m == null) return out;
    var d = obs.mslp - m;
    return { applied: true, dP: d, tObs: obs.t, mslpObs: obs.mslp, mslpModel: m, flag: Math.abs(d) >= 4 ? 'far' : Math.abs(d) >= 2 ? 'off' : 'ok' };
  }
  function anchoredMslp(rec, anchor) {
    if (!rec || rec.mslp == null) return null;
    if (!anchor || !anchor.applied) return rec.mslp;
    var dh = (rec.epoch - anchor.tObs) / HOUR;
    return rec.mslp + anchor.dP * (dh > 0 ? Math.exp(-dh / PRESSURE_TAU_H) : 1);
  }

  // Forecast rows carrying the model's levels and the (observation-anchored) sea-level pressure for their hour. Rows with no model hour are returned as they are.
  function attachUpperAir(rows, ua, anchor) {
    if (!ua || !ua.ok) return rows;
    return rows.map(function (r) {
      var u = ua.byT[r.t];
      if (!u) return r;
      var c = {}, k;
      for (k in r) if (Object.prototype.hasOwnProperty.call(r, k)) c[k] = r[k];
      if (u.lev.length >= 2) c.lev = u.lev;
      var m = anchoredMslp(u, anchor);
      if (m != null && c.mslp == null) c.mslp = m;
      return c;
    });
  }

  /* -------------------------------------------- stations and BCDG analysis */

  var STN_ALIASES = {
    name: ['station', 'name', 'id', 'site', 'stid'],
    lat: ['lat', 'latitude'], lon: ['lon', 'lng', 'long', 'longitude'],
    e: ['east_km', 'x_km', 'east'], n: ['north_km', 'y_km', 'north'],
    z: ['elev_m', 'elevation_m', 'elev', 'elevation', 'z_m', 'z'],
    time: ALIASES.time, temp: ALIASES.temp
  };

  // long format: one row per station per hour
  function parseStations(text) {
    var out = { stations: [], obs: [], mode: null, hours: 0, warnings: [] };
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim() && !/^\s*#/.test(l); });
    if (lines.length < 2) { out.warnings.push('Paste a header row and station rows.'); return out; }
    var first = lines[0];
    var delim = first.indexOf('\t') >= 0 ? '\t' : first.indexOf(';') >= 0 && first.indexOf(',') < 0 ? ';' : ',';
    var head = first.split(delim).map(function (h) { return h.trim().toLowerCase().replace(/[\s\-()°%]+/g, '_').replace(/^_+|_+$/g, ''); });
    var idx = {}, unit = {};
    Object.keys(STN_ALIASES).forEach(function (k) {
      for (var a = 0; a < STN_ALIASES[k].length; a++) {
        var j = head.indexOf(STN_ALIASES[k][a]);
        if (j >= 0) { idx[k] = j; unit[k] = STN_ALIASES[k][a]; break; }
      }
    });
    var need = ['name', 'z', 'time', 'temp'].filter(function (k) { return idx[k] == null; });
    if (need.length) { out.warnings.push('Missing column' + (need.length > 1 ? 's' : '') + ': ' + need.map(function (k) { return { name: 'station', z: 'elev_m', time: 'time', temp: 'temp_c' }[k]; }).join(', ') + '.'); return out; }
    if (idx.lat != null && idx.lon != null) out.mode = 'latlon';
    else if (idx.e != null && idx.n != null) out.mode = 'offset';
    else { out.warnings.push('Give each station either lat and lon, or east_km and north_km from the summit.'); return out; }
    var seen = {}, times = {}, skipped = 0;
    for (var i = 1; i < lines.length; i++) {
      var p = lines[i].split(delim), name = (p[idx.name] || '').trim();
      var t = parseTime(p[idx.time]), T = num(p[idx.temp]), z = num(p[idx.z]);
      var a = out.mode === 'latlon' ? num(p[idx.lat]) : num(p[idx.e]), b = out.mode === 'latlon' ? num(p[idx.lon]) : num(p[idx.n]);
      if (!name || t == null || T == null || z == null || a == null || b == null) { skipped++; continue; }
      if (/_f$/.test(unit.temp)) T = (T - 32) * 5 / 9;
      if (!seen[name]) {
        seen[name] = true;
        out.stations.push(out.mode === 'latlon' ? { name: name, z: z, lat: a, lon: b } : { name: name, z: z, e: a, n: b });
      }
      out.obs.push({ name: name, t: t, T: T }); times[t] = true;
    }
    out.hours = Object.keys(times).length;
    if (skipped) out.warnings.push(skipped + ' row' + (skipped > 1 ? 's' : '') + ' skipped (missing value).');
    if (out.stations.length < 2) out.warnings.push('BCDG needs at least two stations with different elevations.');
    return out;
  }

  // planar coordinates (km) with the summit at the origin, plus station-to-station distances
  function prepareBcdg(parsed, target) {
    var st = parsed.stations, n = st.length, pos;
    if (n < 2) return { error: 'Need at least two stations.' };
    if (parsed.mode === 'latlon') {
      if (!target || !isFinite(target.lat) || !isFinite(target.lon)) return { error: 'Enter the summit latitude and longitude.' };
      var kx = M_PER_DEG_LON * Math.cos(target.lat * Math.PI / 180) / 1000, ky = M_PER_DEG_LAT / 1000;
      pos = st.map(function (s) { return [(s.lon - target.lon) * kx, (s.lat - target.lat) * ky]; });
    } else pos = st.map(function (s) { return [s.e, s.n]; });
    var dT = pos.map(function (p) { return Math.hypot(p[0], p[1]); });
    var D = pos.map(function (a) { return pos.map(function (b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }); });
    var index = {}, byTime = {};
    st.forEach(function (s, k) { index[s.name] = k; });
    parsed.obs.forEach(function (o) {
      var arr = byTime[o.t];
      if (!arr) { arr = byTime[o.t] = new Float64Array(n); for (var q = 0; q < n; q++) arr[q] = NaN; }
      arr[index[o.name]] = o.T;
    });
    return { names: st.map(function (s) { return s.name; }), z: st.map(function (s) { return s.z; }), dTarget: dT, D: D, n: n, byTime: byTime,
      nearestKm: Math.min.apply(null, dT), farthestKm: Math.max.apply(null, dT) };
  }

  // MDL's lapse rate: the sum of temperature differences (higher station minus lower station) over the sum of the
  // elevation differences, taken across station pairs. Returned as a cooling rate in K/km (positive when it cools with height).
  function bcdgLapse(z, T) {
    var sT = 0, sZ = 0;
    for (var i = 0; i < z.length; i++) {
      if (T[i] !== T[i]) continue;
      for (var j = i + 1; j < z.length; j++) {
        if (T[j] !== T[j]) continue;
        var hi = z[i] >= z[j] ? i : j, lo = hi === i ? j : i, dz = z[hi] - z[lo];
        if (dz <= 0) continue;
        sT += T[hi] - T[lo]; sZ += dz;
      }
    }
    return { gamma: sZ > 0 ? -1000 * sT / sZ : null, spread: sZ };
  }

  // Successive-correction (Bergthorsson-Doos, Cressman weights) analysis of station temperatures to the summit.
  // Every station is first moved to the summit's elevation with the local lapse rate; a mean first guess is then
  // corrected over `passes` passes with a shrinking radius of influence. opts: {radiusKm, decay, passes}
  function bcdgAnalyze(prep, temps, zT, opts) {
    var ids = [], i, k;
    for (i = 0; i < prep.n; i++) if (temps[i] === temps[i]) ids.push(i);
    if (ids.length < 2) return null;
    var zs = prep.z, lap = bcdgLapse(zs, temps);
    if (lap.gamma == null || lap.spread < 200) return null;
    var gamma = clamp(lap.gamma, -5, 11), m = ids.length;
    var obs = ids.map(function (s) { return temps[s] - gamma * (zT - zs[s]) / 1000; });
    var first = obs.reduce(function (a, b) { return a + b; }, 0) / m;
    var A = obs.map(function () { return first; }), At = first;
    var passes = opts.passes || 5, R0 = opts.radiusKm || 60, decay = opts.decay || 0.7;
    for (k = 0; k < passes; k++) {
      var R = R0 * Math.pow(decay, k), R2 = R * R, nA = new Array(m), sn = 0, sd = 0, a, b;
      for (a = 0; a < m; a++) {
        var nu = 0, de = 0;
        for (b = 0; b < m; b++) {
          var r = prep.D[ids[a]][ids[b]];
          if (r < R) { var w = (R2 - r * r) / (R2 + r * r); nu += w * (obs[b] - A[b]); de += w; }
        }
        nA[a] = A[a] + (de > 0 ? nu / de : 0);
      }
      for (b = 0; b < m; b++) {
        var rt = prep.dTarget[ids[b]];
        if (rt < R) { var wt = (R2 - rt * rt) / (R2 + rt * rt); sn += wt * (obs[b] - A[b]); sd += wt; }
      }
      At += sd > 0 ? sn / sd : 0;
      A = nA;
    }
    return { T: At, gamma: gamma, gammaRaw: lap.gamma, n: m, first: first };
  }

  /* ------------------------------------ adiabatic parcel (dry, then moist) */

  var CPD = 1005.7, GAMMA_D = G0 / CPD;                 // dry adiabatic lapse rate, 9.75 K/km
  function latentHeat(tC) { return 2.501e6 - 2370 * tC; }

  // Saturated (pseudo-)adiabatic lapse rate, K/m, at temperature tK and pressure pPa (AMS Glossary form).
  function moistLapse(tK, pPa) {
    var tC = tK - 273.15, es = satVapPa(tC), rs = EPS * es / (pPa - es), L = latentHeat(tC);
    return G0 * (1 + L * rs / (RD * tK)) / (CPD + L * L * rs * EPS / (RD * tK * tK));
  }
  function dewPointC(tC, rh) {
    if (rh >= 100) return tC;
    var y = Math.log(Math.max(rh, 1) / 100 * satVapPa(tC) / 611.2);
    return 243.5 * y / (17.67 - y);
  }
  // Lift a parcel from zM to zS. Unsaturated air rises on the dry adiabat to its lifting condensation level (Bolton 1980),
  // then on the moist adiabat. Descending air is taken as unsaturated and warms at the dry rate.
  function parcelLift(tC, rh, pHpa, zM, zS) {
    var dz = zS - zM;
    if (Math.abs(dz) < 1e-6) return { tS: tC, lcl: null };
    if (dz < 0) return { tS: tC - GAMMA_D * dz, lcl: null };
    var tK = tC + 273.15, tdK = dewPointC(tC, rh) + 273.15, lcl;
    if (rh >= 98 || tK - tdK < 0.05) lcl = 0;
    else lcl = Math.max(0, (tK - (1 / (1 / (tdK - 56) + Math.log(tK / tdK) / 800) + 56)) / GAMMA_D);
    var z = 0, p = pHpa * 100, t = tK;
    while (z < dz - 1e-9) {
      var h = Math.min(25, dz - z), dry = z < lcl - 1e-6;
      if (dry && z + h > lcl) h = lcl - z;
      var g = dry ? GAMMA_D : moistLapse(t, p), t2 = t - g * h;
      p *= Math.exp(-G0 * h / (RD * (t + t2) / 2));
      t = t2; z += h;
    }
    return { tS: t - 273.15, lcl: lcl };
  }

  /* ------------------------------------ monthly climatological lapse rate */

  // Cooling rate with height, K/km, for January to December. These are generic mid-latitude mountain values, inside the
  // range of published monthly means (about 4 to 7 K/km, lowest in winter, when inversions are common). They are NOT fitted to
  // New Hampshire. Replace them with values from a local station pair.
  var CLIM_DEFAULT = [4.6, 5.0, 5.5, 6.0, 6.3, 6.5, 6.5, 6.4, 6.2, 5.7, 5.0, 4.6];

  // The month's rate, interpolated between mid-month values, plus a daily harmonic that peaks at 15:00 local time
  // (steeper by day, weaker at night). row.t is a wall-clock time, so the UTC getters give local time.
  function climLapse(row, table, diurnal) {
    var d = new Date(row.t), mo = d.getUTCMonth(), dim = new Date(Date.UTC(d.getUTCFullYear(), mo + 1, 0)).getUTCDate();
    var pos = mo + (d.getUTCDate() - 0.5) / dim - 0.5, m0 = Math.floor(pos), f = pos - m0;
    var a = table[(m0 + 12) % 12], b = table[(m0 + 13) % 12];
    var hod = d.getUTCHours() + d.getUTCMinutes() / 60;
    return a + (b - a) * f + (diurnal || 0) * Math.cos(2 * Math.PI * (hod - 15) / 24);
  }

  /* -------------- the 48 NWS point forecasts as a station network (spatial methods) */

  // Each summit's /points call lands in an NWS grid cell that carries its own elevation and hourly temperature. Nearby summits share
  // a cell, so the network has one pseudo-station per distinct cell: the cell elevation, the cell position and the forecast temperature.
  // pb comes from parseNwsBundle; peakList is the NH48 list, used for names and for positions when the bundle has none.
  function buildNwsNetwork(pb, peakList) {
    var byId = {}, cells = {}, order = [], i, k;
    (peakList || []).forEach(function (p) { byId[p.id] = p; });
    Object.keys(pb && pb.peaks || {}).forEach(function (id) {
      var pk = pb.peaks[id];
      if (!pk || !pk.rows || !pk.rows.length || pk.zModel == null) return;
      var key = !pk.grid || pk.grid === 'pasted' ? 'pasted:' + id : pk.grid;   // a pasted response is one summit, never a shared cell
      var c = cells[key];
      if (!c) { c = cells[key] = { key: key, rows: pk.rows, z: pk.zModel, ids: [], names: [], lat: [], lon: [], center: pk.center || null }; order.push(key); }
      var meta = byId[id], lat = pk.lat != null ? pk.lat : meta ? meta.lat : null, lon = pk.lon != null ? pk.lon : meta ? meta.lon : null;
      c.ids.push(id); c.names.push(meta ? meta.name : id);
      if (lat != null && lon != null) { c.lat.push(lat); c.lon.push(lon); }
    });
    var list = order.map(function (key) {
      var c = cells[key], mean = function (a) { return a.reduce(function (s, v) { return s + v; }, 0) / a.length; };
      if (c.center) { c.la = c.center[0]; c.lo = c.center[1]; } else if (c.lat.length) { c.la = mean(c.lat); c.lo = mean(c.lon); }
      return c;
    }).filter(function (c) { return c.la != null; });
    var n = list.length, net = { n: n, cells: list, byTime: {}, hours: 0 };
    if (n < 2) return net;
    var lat0 = 0, lon0 = 0;
    list.forEach(function (c) { lat0 += c.la / n; lon0 += c.lo / n; });
    var kx = M_PER_DEG_LON * Math.cos(lat0 * Math.PI / 180) / 1000, ky = M_PER_DEG_LAT / 1000;
    net.lat0 = lat0; net.lon0 = lon0; net.kx = kx; net.ky = ky;
    net.x = list.map(function (c) { return (c.lo - lon0) * kx; });
    net.y = list.map(function (c) { return (c.la - lat0) * ky; });
    net.z = list.map(function (c) { return c.z; });
    net.names = list.map(function (c) { return c.names[0] + (c.names.length > 1 ? ' +' + (c.names.length - 1) : ''); });
    net.D = net.x.map(function (xa, a) { return net.x.map(function (xb, b) { return Math.hypot(xa - xb, net.y[a] - net.y[b]); }); });
    net.zMin = Math.min.apply(null, net.z); net.zMax = Math.max.apply(null, net.z);
    for (k = 0; k < n; k++) {
      var rows = list[k].rows;
      for (i = 0; i < rows.length; i++) {
        var arr = net.byTime[rows[i].t];
        if (!arr) { arr = net.byTime[rows[i].t] = new Float64Array(n); for (var q = 0; q < n; q++) arr[q] = NaN; net.hours++; }
        arr[k] = rows[i].temp;
      }
    }
    return net;
  }

  // The network as seen from one summit: adds distances to it. The result has the fields bcdgAnalyze reads (n, z, D, dTarget).
  function networkTarget(net, lat, lon) {
    if (!net || net.n < 2 || !isFinite(lat) || !isFinite(lon)) return { error: 'The NWS network needs at least two grid cells.' };
    var tx = (lon - net.lon0) * net.kx, ty = (lat - net.lat0) * net.ky;
    var dT = net.x.map(function (x, i) { return Math.hypot(x - tx, net.y[i] - ty); });
    return { names: net.names, z: net.z, x: net.x, y: net.y, D: net.D, n: net.n, byTime: net.byTime, tx: tx, ty: ty, dTarget: dT,
      nearestKm: Math.min.apply(null, dT), farthestKm: Math.max.apply(null, dT), zMin: net.zMin, zMax: net.zMax };
  }

  /* ----------------------- regression-based spatial methods over the network */

  var LAPSE_MIN = -5, LAPSE_MAX = 11;          // cooling rate limits, K/km, shared with BCDG
  var GRADIENT_MAX = 0.1;                      // largest horizontal temperature gradient GIDS may fit, K/km
  var CELL_KM = 2.5;                           // NWS grid spacing; sets the smallest distance used for weighting
  var WLR_Z_SCALE_M = 500;                     // elevation difference at which local regression halves a station's weight

  // Weighted least-squares line T = tbar + b (z - zbar). Returns null when the weighted spread of elevations is under 30 m.
  function wlsLine(z, T, w) {
    var sw = 0, sz = 0, st = 0, i;
    for (i = 0; i < z.length; i++) { sw += w[i]; sz += w[i] * z[i]; st += w[i] * T[i]; }
    if (!(sw > 0)) return null;
    var zb = sz / sw, tb = st / sw, szz = 0, szt = 0;
    for (i = 0; i < z.length; i++) { var dz = z[i] - zb; szz += w[i] * dz * dz; szt += w[i] * dz * (T[i] - tb); }
    if (Math.sqrt(szz / sw) < 30) return null;
    return { zbar: zb, tbar: tb, b: szt / szz };
  }

  function solveLinear(A, b) {                 // Gaussian elimination with partial pivoting; null if singular
    var n = b.length, M = A.map(function (r, i) { return r.slice().concat([b[i]]); }), i, j, k;
    for (i = 0; i < n; i++) {
      var p = i;
      for (j = i + 1; j < n; j++) if (Math.abs(M[j][i]) > Math.abs(M[p][i])) p = j;
      if (Math.abs(M[p][i]) < 1e-12) return null;
      var tmp = M[i]; M[i] = M[p]; M[p] = tmp;
      for (j = i + 1; j < n; j++) { var f = M[j][i] / M[i][i]; for (k = i; k <= n; k++) M[j][k] -= f * M[i][k]; }
    }
    var x = new Array(n);
    for (i = n - 1; i >= 0; i--) { var s = M[i][n]; for (j = i + 1; j < n; j++) s -= M[i][j] * x[j]; x[i] = s / M[i][i]; }
    return x;
  }

  // Ordinary least squares of T on the columns of X (each row starts with a 1 for the intercept).
  function olsFit(X, T) {
    var p = X[0].length, A = [], b = [], i, j, k;
    for (j = 0; j < p; j++) { A.push(new Array(p).fill(0)); b.push(0); }
    for (i = 0; i < X.length; i++) for (j = 0; j < p; j++) { b[j] += X[i][j] * T[i]; for (k = 0; k < p; k++) A[j][k] += X[i][j] * X[i][k]; }
    return solveLinear(A, b);
  }

  var SPATIAL_MIN = { regression: 3, wlr: 3, gids: 5 };   // fewest stations each method will use in an hour

  // One hour of a spatial method. prep: networkTarget() output; temps: Float64Array of cell temperatures (NaN = missing);
  // zT: summit elevation. kind: 'regression' | 'wlr' | 'gids'. opts.bandwidthKm sets the local regression reach.
  // All three return the summit temperature T and the cooling rate gamma (K/km) they used.
  function spatialAnalyze(kind, prep, temps, zT, opts) {
    opts = opts || {};
    var ids = [], i;
    for (i = 0; i < prep.n; i++) if (temps[i] === temps[i]) ids.push(i);
    if (ids.length < (SPATIAL_MIN[kind] || 3)) return null;
    var z = ids.map(function (s) { return prep.z[s]; }), T = ids.map(function (s) { return temps[s]; }), d = ids.map(function (s) { return prep.dTarget[s]; });
    var ones = z.map(function () { return 1; }), fit, gam, out;

    if (kind === 'regression') {
      // one straight line through every cell's (elevation, temperature) for this hour
      fit = wlsLine(z, T, ones);
      if (!fit) return null;
      gam = clamp(-1000 * fit.b, LAPSE_MIN, LAPSE_MAX);
      return { T: fit.tbar - gam / 1000 * (zT - fit.zbar), gamma: gam, gammaRaw: -1000 * fit.b, n: ids.length };
    }

    if (kind === 'wlr') {
      // a line fitted locally: each cell counts less the farther it is from the summit, and less the more its elevation differs
      // from the summit's (the idea behind PRISM's regression weighting; the weight functions here are simple stand-ins)
      var h = opts.bandwidthKm || 30;
      var w = d.map(function (r, k) { var dz = (z[k] - zT) / WLR_Z_SCALE_M; return Math.exp(-0.5 * r * r / (h * h)) / (1 + dz * dz); });
      fit = wlsLine(z, T, w);
      var local = !!fit, reg = local ? null : wlsLine(z, T, ones);
      if (!fit) {                                  // too little elevation spread nearby: keep the local level, borrow the regional slope
        if (!reg) return null;
        var sw = 0, sz = 0, st = 0;
        for (i = 0; i < z.length; i++) { sw += w[i]; sz += w[i] * z[i]; st += w[i] * T[i]; }
        if (!(sw > 0)) return null;
        fit = { zbar: sz / sw, tbar: st / sw, b: reg.b };
      }
      gam = clamp(-1000 * fit.b, LAPSE_MIN, LAPSE_MAX);
      return { T: fit.tbar - gam / 1000 * (zT - fit.zbar), gamma: gam, gammaRaw: -1000 * fit.b, n: ids.length, localSlope: local };
    }

    // GIDS (Nalder and Wein 1998): regress T on x, y and elevation over all cells, move every cell to the summit's position and
    // elevation with those gradients, then average with 1/distance^2 weights.
    var X = ids.map(function (s) { return [1, prep.x[s], prep.y[s], prep.z[s]]; }), c = olsFit(X, T);
    if (!c) return null;
    var cx = clamp(c[1], -GRADIENT_MAX, GRADIENT_MAX), cy = clamp(c[2], -GRADIENT_MAX, GRADIENT_MAX), cz = clamp(c[3] * 1000, -LAPSE_MAX, -LAPSE_MIN) / 1000;
    var sn = 0, sd = 0;
    for (i = 0; i < ids.length; i++) {
      var s = ids[i], wi = 1 / (d[i] * d[i] + CELL_KM * CELL_KM / 4);
      sn += wi * (T[i] + cx * (prep.tx - prep.x[s]) + cy * (prep.ty - prep.y[s]) + cz * (zT - prep.z[s]));
      sd += wi;
    }
    return { T: sn / sd, gamma: -1000 * cz, gammaRaw: -1000 * c[3], n: ids.length, gradX: cx, gradY: cy };
  }

  /* --------------------------- regional weather, regimes and the weighted ensemble */

  // Regional weather for each forecast hour: the average over the network's grid cells (each cell counted once).
  // Wind direction is the direction the wind comes from, from the mean wind vector. precipFrac is the share of cells with at
  // least 0.1 mm in the hour. tend is the change in the regional mean temperature over 12 h, taken on 24 h running means so the
  // daily cycle drops out (null when the forecast is under 30 h long, which is too short to remove it).
  function regionalWeather(net) {
    var acc = {}, out = { byTime: {}, times: [] };
    if (!net || !net.cells || !net.cells.length) return out;
    net.cells.forEach(function (c) {
      c.rows.forEach(function (r) {
        var a = acc[r.t] || (acc[r.t] = { nT: 0, T: 0, nC: 0, C: 0, nR: 0, R: 0, nW: 0, W: 0, U: 0, V: 0, nP: 0, P: 0, nQ: 0, Q: 0 });
        a.nT++; a.T += r.temp;
        if (r.cloud != null) { a.nC++; a.C += r.cloud; }
        if (r.rh != null) { a.nR++; a.R += r.rh; }
        if (r.wind != null) {
          a.nW++; a.W += r.wind;
          if (r.wdir != null) { a.U -= r.wind * Math.sin(r.wdir * Math.PI / 180); a.V -= r.wind * Math.cos(r.wdir * Math.PI / 180); }
        }
        if (r.precip != null) { a.nP++; if (r.precip >= 0.1) a.P++; }
        if (r.pop != null) { a.nQ++; a.Q += r.pop; }
      });
    });
    var ts = Object.keys(acc).map(Number).sort(function (a, b) { return a - b; });
    ts.forEach(function (t) {
      var a = acc[t], w = { t: t, n: a.nT, temp: a.T / a.nT, cloud: a.nC ? a.C / a.nC : null, rh: a.nR ? a.R / a.nR : null,
        wind: a.nW ? a.W / a.nW : null, dir: null, precipFrac: a.nP ? a.P / a.nP : null, pop: a.nQ ? a.Q / a.nQ : null, tend: null };
      if (a.nW && Math.hypot(a.U, a.V) > 1e-6) w.dir = (Math.atan2(-a.U, -a.V) * 180 / Math.PI + 360) % 360;
      out.byTime[t] = w;
    });
    out.times = ts;
    var n = ts.length;
    if (n >= 30) {
      var T24 = ts.map(function (t, i) {                       // centred 24 h mean, slid inward at the ends
        var lo = Math.min(Math.max(i - 12, 0), n - 24), s = 0;
        for (var j = lo; j < lo + 24; j++) s += out.byTime[ts[j]].temp;
        return s / 24;
      });
      ts.forEach(function (t, i) { out.byTime[t].tend = T24[Math.min(n - 1, i + 6)] - T24[Math.max(0, i - 6)]; });
    }
    return out;
  }

  // Regional weather regimes and the cooling rate (K/km) each one makes likely. These expectations are assumptions drawn
  // from the usual behaviour of mountain lapse rates (steep with daytime mixing or cold advection, near the moist adiabat in
  // saturated air, weak in radiation inversions and warm advection). They are not fitted to New Hampshire data.
  var REGIMES = {
    wet:        { label: 'Wet or frontal', pressure: 'low', mu: 5.2, sigma: 1.0 },
    cold:       { label: 'Cold advection', pressure: 'high', mu: 7.5, sigma: 1.2 },
    warm:       { label: 'Warm advection', pressure: 'low', mu: 4.0, sigma: 1.2 },
    windy:      { label: 'Windy, well mixed', pressure: 'neutral', mu: 6.8, sigma: 1.0 },
    clearDay:   { label: 'Clear and calm, day', pressure: 'high', mu: 8.0, sigma: 1.2 },
    clearNight: { label: 'Clear and calm, night', pressure: 'high', mu: 3.0, sigma: 1.2 },
    clear:      { label: 'Clear and calm', pressure: 'high', mu: 5.5, sigma: 1.5 },
    mixed:      { label: 'Mixed', pressure: 'neutral', mu: 6.0, sigma: 1.5 }
  };
  var REGIME_ORDER = ['wet', 'cold', 'warm', 'windy', 'clearDay', 'clearNight', 'clear', 'mixed'];

  // w: regionalWeather record; hod: local hour; pTend: measured pressure change over 6 h in hPa, when a forecast supplies pressure.
  // NWS grids carry no pressure, so without pTend the low or high signature is inferred from the regime itself.
  function classifyRegime(w, hod, pTend) {
    var id = 'mixed';
    if (w) {
      var coldSector = w.dir != null && (w.dir >= 250 || w.dir <= 20), warmSector = w.dir != null && w.dir >= 60 && w.dir <= 250;
      var cloud = w.cloud != null ? w.cloud : 50, wind = w.wind != null ? w.wind : 15, rh = w.rh != null ? w.rh : 70;
      if ((w.precipFrac != null && w.precipFrac >= 0.25) || (rh >= 92 && cloud >= 80)) id = 'wet';
      else if (w.tend != null && w.tend <= -1.5 && coldSector) id = 'cold';
      else if (w.tend != null && w.tend >= 1.5 && warmSector) id = 'warm';
      else if (wind >= 35) id = 'windy';
      else if (cloud < 35 && wind < 18) id = hod >= 10 && hod <= 17 ? 'clearDay' : hod >= 19 || hod <= 6 ? 'clearNight' : 'clear';
    }
    var g = REGIMES[id], pressure = g.pressure, src = 'inferred';
    if (pTend != null && isFinite(pTend)) {
      src = 'measured';
      if (pTend <= -1.5) pressure = 'low'; else if (pTend >= 1.5) pressure = 'high'; else pressure = 'neutral';
    }
    return { id: id, label: g.label, pressure: pressure, pressureSrc: src, mu: g.mu, sigma: g.sigma };
  }

  // Cooling rate the network's grid cells imply at one hour: a least-squares slope of temperature on elevation, with its standard error.
  function regionalLapse(net, temps) {
    var z = [], T = [], i;
    for (i = 0; i < net.n; i++) if (temps[i] === temps[i]) { z.push(net.z[i]); T.push(temps[i]); }
    var n = z.length;
    if (n < 5) return null;
    var zb = 0, tb = 0;
    for (i = 0; i < n; i++) { zb += z[i] / n; tb += T[i] / n; }
    var szz = 0, szt = 0, ss = 0;
    for (i = 0; i < n; i++) { szz += (z[i] - zb) * (z[i] - zb); szt += (z[i] - zb) * (T[i] - tb); }
    if (Math.sqrt(szz / n) < 30) return null;
    var b = szt / szz;
    for (i = 0; i < n; i++) { var e = T[i] - tb - b * (z[i] - zb); ss += e * e; }
    return { gamma: -1000 * b, se: 1000 * Math.sqrt(ss / (n - 2) / szz), n: n };
  }

  // Percentiles follow the NIST/SEMATECH e-Handbook of Statistical Methods (section 7.2.6.2): with N values in ascending order the
  // p-th percentile sits at rank r = p(N + 1). It is Y[k] + d (Y[k+1] - Y[k]) with k the whole part and d the fraction of r, the
  // smallest value when r < 1 and the largest when r >= N. This is the plotting position i/(N + 1) (Weibull; Hyndman and Fan type 6).
  // With weights, each value sits at the middle of its own slice of the cumulative weight, moved so equal weights give exactly
  // i/(N + 1): position = (W before + w/2 + wbar/2) / (W + wbar), wbar the mean weight. The positions are symmetric (the 10th
  // percentile from the top mirrors the 90th from the bottom). A percentile is read off the sorted values as they are; only when
  // asked for a rank (tieMean) do tied values share the mean of their positions.
  function nistPositions(v, w, tieMean) {
    var idx = [], W = 0, i;
    for (i = 0; i < v.length; i++) if (w[i] > 0 && v[i] === v[i]) { idx.push(i); W += w[i]; }
    if (!idx.length) return null;
    idx.sort(function (a, b) { return v[a] - v[b]; });
    var wbar = W / idx.length, pos = [], cum = 0, k;
    idx.forEach(function (j) { pos.push((cum + w[j] / 2 + wbar / 2) / (W + wbar)); cum += w[j]; });
    for (i = 0; tieMean && i < idx.length; i = k) {   // ties: every member takes the group's mean position
      k = i + 1; while (k < idx.length && v[idx[k]] === v[idx[i]]) k++;
      var m = 0, j; for (j = i; j < k; j++) m += pos[j]; m /= k - i;
      for (j = i; j < k; j++) pos[j] = m;
    }
    return { idx: idx, pos: pos };
  }
  // Weighted quantile q (0 to 1) by the NIST definition; equal weights give the plain NIST percentile.
  function weightedQuantile(v, w, q) {
    var np = nistPositions(v, w);
    if (!np) return NaN;
    var idx = np.idx, pos = np.pos, i;
    if (idx.length === 1 || q <= pos[0]) return v[idx[0]];
    if (q >= pos[pos.length - 1]) return v[idx[idx.length - 1]];
    for (i = 1; i < idx.length; i++) {
      if (q <= pos[i]) {
        var span = pos[i] - pos[i - 1];
        return span > 0 ? v[idx[i - 1]] + (q - pos[i - 1]) / span * (v[idx[i]] - v[idx[i - 1]]) : v[idx[i]];
      }
    }
    return v[idx[idx.length - 1]];
  }
  // Unweighted NIST percentile, p in percent (0 to 100).
  function nistPercentile(values, p) { return weightedQuantile(values, values.map(function () { return 1; }), p / 100); }
  // Percentile rank, in percent, of each value among the others (its NIST plotting position, ties averaged); NaN where the weight is 0.
  function nistRanks(v, w) {
    var out = v.map(function () { return NaN; }), np = nistPositions(v, w, true);
    if (np) np.idx.forEach(function (j, i) { out[j] = 100 * np.pos[i]; });
    return out;
  }
  // The ten levels shown for the methods' summit temperatures at one hour, lowest to highest by convention. MIN and MAX are the
  // coolest and warmest method, P5 to P95 are NIST percentiles and MEAN is the weighted mean. With fewer than 19 methods the NIST
  // rank for P5 is below 1 and for P95 above N, so P5 equals MIN and P95 equals MAX there; they separate once there are more.
  var LEVELS = ['MIN', 'P5', 'P10', 'P25', 'P50', 'MEAN', 'P75', 'P90', 'P95', 'MAX'];
  function levelValues(h) { return [h.min, h.p5, h.p10, h.p25, h.p50, h.mean, h.p75, h.p90, h.p95, h.max]; }
  // Where the levels sit on the percentile scale, for handing them out to methods. MEAN sits where the mean falls among the methods.
  var LEVEL_POS = { MIN: 0, P5: 5, P10: 10, P25: 25, P50: 50, P75: 75, P90: 90, P95: 95, MAX: 100 };
  // Percentile rank, in percent, of a value that may not be one of the methods: linear between the methods' ranks (NIST positions,
  // ties averaged), held at the lowest and highest rank outside them.
  function nistRankOf(v, w, x) {
    var np = nistPositions(v, w, true);
    if (!np || x !== x) return NaN;
    var idx = np.idx, pos = np.pos, n = idx.length, i;
    if (x <= v[idx[0]]) return 100 * pos[0];
    for (i = 1; i < n; i++) if (x <= v[idx[i]]) {
      var d = v[idx[i]] - v[idx[i - 1]];
      return 100 * (d > 0 ? pos[i - 1] + (x - v[idx[i - 1]]) / d * (pos[i] - pos[i - 1]) : pos[i]);
    }
    return 100 * pos[n - 1];
  }
  // One method to a level, never two to the same. h is one hour of ensemble(): ids, vals, wts, pct, mean. Returns {id: level}.
  // The coolest method is MIN and the warmest MAX. The ones between, in order of temperature, are matched in order to P5 through
  // P95 and MEAN (in order of their place on the percentile scale), using as many levels as there are methods, or as many methods
  // as there are levels when there are more, in which case the ones left out have no level. The match is the one that keeps each
  // method nearest to its level's percentile (minimum total distance, by dynamic programming). A single method is P50.
  function assignLevels(h) {
    var ent = [], out = {}, i, j, c;
    h.ids.forEach(function (id, k) { var r = h.pct[id]; if (r === r && r != null) ent.push({ id: id, v: h.vals[k], r: r, k: k }); });
    ent.sort(function (a, b) { return a.v - b.v || a.k - b.k; });
    if (ent.length === 1) { out[ent[0].id] = 'P50'; return out; }
    if (ent.length < 2) return out;
    out[ent[0].id] = 'MIN'; out[ent[ent.length - 1].id] = 'MAX';
    ent = ent.slice(1, -1);
    var lev = LEVELS.filter(function (L) { return L !== 'MIN' && L !== 'MAX'; }).map(function (L, k) { return { L: L, k: k, pos: L === 'MEAN' ? nistRankOf(h.vals, h.wts, h.mean) : LEVEL_POS[L] }; });
    lev.sort(function (a, b) { return a.pos - b.pos || a.k - b.k; });
    var n = ent.length, m = lev.length, K = Math.min(n, m), INF = 1e18, f = [], E = 1e-9;
    for (i = 0; i <= n; i++) { f.push([]); for (j = 0; j <= m; j++) { f[i].push([]); for (c = 0; c <= K; c++) f[i][j].push(c === 0 ? 0 : INF); } }
    for (i = 1; i <= n; i++) for (j = 1; j <= m; j++) for (c = 1; c <= K; c++) {
      var best = Math.min(f[i - 1][j][c], f[i][j - 1][c]);
      if (f[i - 1][j - 1][c - 1] < INF) best = Math.min(best, f[i - 1][j - 1][c - 1] + Math.abs(ent[i - 1].r - lev[j - 1].pos));
      f[i][j][c] = best;
    }
    i = n; j = m; c = K;
    while (c > 0 && i > 0 && j > 0) {
      var cost = f[i][j][c];       // on an exact tie the earlier level wins (P50 before MEAN at the same place)
      if (Math.abs(cost - f[i][j - 1][c]) < E) j--;
      else if (f[i - 1][j - 1][c - 1] < INF && Math.abs(cost - (f[i - 1][j - 1][c - 1] + Math.abs(ent[i - 1].r - lev[j - 1].pos))) < E) { out[ent[i - 1].id] = lev[j - 1].L; i--; j--; c--; }
      else i--;
    }
    return out;
  }
  // For a line that is not one of the methods (the raw cell, Most likely, MWARVTP): where it falls against the levels, without
  // taking one. '<MIN' or '>MAX' outside all the methods, 'MIN' to 'MAX' pairs such as 'P50-P75' between two levels, and '=P50'
  // (within tol) on a level's temperature.
  function levelBetween(h, x, tol) {
    if (!h || x !== x) return null;
    var E = 1e-9, v = levelValues(h);
    if (x < h.min - E) return '<MIN';
    if (x > h.max + E) return '>MAX';
    var lev = LEVELS.map(function (L, k) { return { L: L, v: v[k], k: k }; }).sort(function (a, b) { return a.v - b.v || a.k - b.k; }), i, near = null;
    for (i = 0; i < lev.length; i++) if (Math.abs(lev[i].v - x) <= (tol == null ? 0.05 : tol) && (!near || Math.abs(lev[i].v - x) < Math.abs(near.v - x) - E)) near = lev[i];
    if (near) return '=' + near.L;
    var lo = null, hi = null;
    lev.forEach(function (q) { if (q.v <= x) lo = q; else if (!hi) hi = q; });
    return lo && hi ? lo.L + '\u2013' + hi.L : (lo || hi).L;
  }

  // Methods that share a family are correlated (the four network methods differ little), so each shares one family's weight.
  var FAMILY = { fixed: 'rate', conditions: 'rate', climatology: 'rate', adiabatic: 'parcel', levels: 'profile', hypsometric: 'profile',
    bcdg: 'network', regression: 'network', wlr: 'network', gids: 'network', bcdgcsv: 'network' };
  var SIGMA_METHOD = 1.0;      // spread of lapse rates that still count as plausible, K/km, on top of the uncertainty of the expectation
  var SIGMA_NETWORK = 0.75;    // floor on the uncertainty of the cell-implied lapse rate, K/km
  var WEIGHT_FLOOR = 0.03;     // no method is ever weighted to zero

  // Percentiles and a most-likely temperature across methods, hour by hour.
  // runs: [{id, res}] from downscale(), all on the same hours. opts: {mode:'regime'|'equal', regimes:[regime per hour],
  // lapse:[regionalLapse per hour or null], dzKm}. Only hours where a method ran on its own inputs count for it.
  // 'equal' gives every method the same weight (plain percentiles). 'regime' weights each method by how plausible the cooling rate
  // it implies is, given the regime's expected rate combined (inverse-variance) with the network's own rate, and by its family share.
  // The result describes the disagreement between methods, weighted by plausibility. It is not a calibrated probability forecast.
  function ensemble(runs, opts) {
    opts = opts || {};
    var n = runs.length ? runs[0].res.length : 0, hours = [], sumW = {}, i;
    runs.forEach(function (r) { sumW[r.id] = 0; });
    var mode = opts.mode === 'equal' || Math.abs(opts.dzKm || 0) < 0.02 ? 'equal' : 'regime';
    for (i = 0; i < n; i++) {
      var cand = runs.filter(function (r) { return r.res[i].source === r.id; });
      if (!cand.length) cand = runs;
      var reg = opts.regimes && opts.regimes[i] || null, ln = opts.lapse && opts.lapse[i] || null;
      var mu = reg ? reg.mu : 6.0, sg = reg ? reg.sigma : 1.5;
      if (ln) {
        var g = clamp(ln.gamma, LAPSE_MIN, LAPSE_MAX), sn = Math.sqrt(ln.se * ln.se + SIGMA_NETWORK * SIGMA_NETWORK);
        var p1 = 1 / (sg * sg), p2 = 1 / (sn * sn);
        mu = (mu * p1 + g * p2) / (p1 + p2); sg = Math.sqrt(1 / (p1 + p2));
      }
      var kw = Math.sqrt(sg * sg + SIGMA_METHOD * SIGMA_METHOD), fam = {};
      cand.forEach(function (r) { var f = FAMILY[r.id] || r.id; fam[f] = (fam[f] || 0) + 1; });
      var vals = [], wts = [], wmap = {}, tot = 0;
      cand.forEach(function (r) {
        var o = r.res[i], w = 1;
        if (mode === 'regime') { var z = (o.gamma - mu) / kw; w = Math.exp(-0.5 * z * z) + WEIGHT_FLOOR; w /= Math.sqrt(fam[FAMILY[r.id] || r.id]); }
        vals.push(o.tSummit); wts.push(w); tot += w;
      });
      var mean = 0, pct = {}, rk = nistRanks(vals, wts);
      cand.forEach(function (r, k) { var nw = wts[k] / tot; wmap[r.id] = nw; sumW[r.id] += nw; mean += nw * vals[k]; pct[r.id] = rk[k]; });
      var p50 = weightedQuantile(vals, wts, 0.5);
      hours.push({ t: runs[0].res[i].t, n: cand.length, ids: cand.map(function (r) { return r.id; }), ml: p50, p50: p50, mean: mean,
        p5: weightedQuantile(vals, wts, 0.05), p10: weightedQuantile(vals, wts, 0.1), p25: weightedQuantile(vals, wts, 0.25), p75: weightedQuantile(vals, wts, 0.75),
        p90: weightedQuantile(vals, wts, 0.9), p95: weightedQuantile(vals, wts, 0.95),
        min: Math.min.apply(null, vals), max: Math.max.apply(null, vals), mu: mu, sigma: sg, regime: reg, w: wmap, pct: pct, vals: vals, wts: wts });
    }
    var meanWeight = {};
    runs.forEach(function (r) { meanWeight[r.id] = n ? sumW[r.id] / n : 0; });
    return { hours: hours, meanWeight: meanWeight, mode: mode };
  }

  /* ------------------------------------------------------- downscaling */

  function windChill(tC, kph) {
    if (tC == null || kph == null || tC > 10 || kph <= 4.8) return tC;
    var v = Math.pow(kph, 0.16);
    return 13.12 + 0.6215 * tC - 11.37 * v + 0.3965 * tC * v;
  }

  // lapse rate (K/km) from the conditions at one hour
  function conditionLapse(row) {
    var hr = new Date(row.t).getUTCHours();
    var day = hr >= 10 && hr <= 17, night = hr >= 19 || hr <= 6;
    var wet = (row.rh != null && row.rh >= 90) || (row.precip != null && row.precip > 0.1);
    var cloud = row.cloud != null ? row.cloud : 50, wind = row.wind != null ? row.wind : 15;
    if (wet) return 5.0;
    if (day && cloud < 50 && wind < 20) return 8.0;
    if (night && cloud < 30 && wind < 12) return 3.5;
    return 6.5;
  }

  // Methods that pick the temperature change from a prescribed lapse rate rather than from data that already holds the daily cycle.
  // The "diurnal swing removed" adjustment applies to these only.
  var PRESCRIBED = { fixed: true, conditions: true, adiabatic: true, climatology: true };

  // opts: {zModel, zSummit, method, gamma, damping, speedUp, bias,
  //        bcdg: {prep, radiusKm, decay, passes}          for 'bcdg' (NWS network) and 'bcdgcsv' (your stations),
  //        net:  {prep, bandwidthKm}                      for 'regression', 'wlr' and 'gids',
  //        clim: [12 rates], climDiurnal                  for 'climatology',
  //        consensusRaw: [temperature per row]            for 'consensus'}
  // method: 'fixed' | 'conditions' | 'adiabatic' | 'climatology' | 'levels' | 'hypsometric' | 'bcdg' | 'bcdgcsv' | 'regression' | 'wlr' | 'gids' | 'consensus'
  // A method with no usable inputs for an hour falls back to the Conditions rate for that hour and says so in `source`.
  function downscale(rows, opts) {
    var dz = (opts.zSummit - opts.zModel) / 1000, meth = opts.method;
    var out = [], i;
    for (i = 0; i < rows.length; i++) {
      var r = rows[i], gamma, tS, source = meth, extra = {};
      var uT = r.tU, uZ = r.zU;
      if ((uT == null || uZ == null) && r.lev) { var nl = levelNear(r.lev, opts.zSummit, opts.zModel); if (nl) { uT = nl.t; uZ = nl.z; } }
      var lv = uT != null && uZ != null && uZ > opts.zModel + 50;
      var mp0 = modelPressure(r, opts.zModel), hy = null, hl = null, bc = null, sp = null, ad = null;
      var eff = function (t, fallback) { return Math.abs(dz) > 1e-6 ? (r.temp - t) / dz : fallback; };   // lapse rate that reproduces temperature t
      if (meth === 'hypsometric' && r.lev) hl = hypsoLevels(r, opts.zModel, opts.zSummit);
      if (meth === 'hypsometric' && !hl && r.zU != null && r.zU > opts.zModel + 50 && (r.pU != null ? r.pU : 700) < mp0.p) hy = hypsoHour(r, opts.zModel, opts.zSummit, mp0.p);
      else if ((meth === 'bcdg' || meth === 'bcdgcsv') && opts.bcdg && opts.bcdg.prep && !opts.bcdg.prep.error && opts.bcdg.prep.byTime[r.t]) {
        bc = bcdgAnalyze(opts.bcdg.prep, opts.bcdg.prep.byTime[r.t], opts.zSummit, opts.bcdg);
      } else if ((meth === 'regression' || meth === 'wlr' || meth === 'gids') && opts.net && opts.net.prep && !opts.net.prep.error && opts.net.prep.byTime[r.t]) {
        sp = spatialAnalyze(meth, opts.net.prep, opts.net.prep.byTime[r.t], opts.zSummit, opts.net);
      } else if (meth === 'adiabatic' && r.rh != null) ad = parcelLift(r.temp, r.rh, mp0.p, opts.zModel, opts.zSummit);
      if (meth === 'levels' && lv) {
        var layer = (r.temp - uT) / ((uZ - opts.zModel) / 1000);
        if (opts.zSummit <= uZ) tS = r.temp + (uT - r.temp) * (opts.zSummit - opts.zModel) / (uZ - opts.zModel);
        else tS = uT - 6.5 * (opts.zSummit - uZ) / 1000;
        gamma = eff(tS, layer);
        extra.levelZ = uZ;
      } else if (hl) {
        tS = hl.tS; gamma = eff(tS, hl.gammaLayer);
        extra.hy = hl;
      } else if (hy) {
        tS = hy.tS; gamma = eff(tS, hy.gammaV);
        extra.layerTv = hy.meanTv;
      } else if (bc) {
        tS = bc.T; gamma = eff(tS, bc.gamma);
        extra.nStn = bc.n; extra.localGamma = bc.gamma;
      } else if (sp) {
        tS = sp.T; gamma = eff(tS, sp.gamma);
        extra.nStn = sp.n; extra.localGamma = sp.gamma;
      } else if (ad) {
        tS = ad.tS; gamma = eff(tS, GAMMA_D * 1000);
        extra.lcl = ad.lcl;
      } else if (meth === 'consensus' && opts.consensusRaw && opts.consensusRaw[i] != null) {
        tS = opts.consensusRaw[i]; gamma = eff(tS, 6.5);
      } else {
        if (meth === 'fixed') gamma = opts.gamma;
        else if (meth === 'climatology') gamma = climLapse(r, opts.clim || CLIM_DEFAULT, opts.climDiurnal);
        else { gamma = conditionLapse(r); source = 'conditions'; }
        tS = r.temp - gamma * dz;
      }
      out.push({ t: r.t, tModel: r.temp, raw: tS, gamma: gamma, source: source, row: r, extra: extra });
    }
    // smooth the hour-to-hour steps in condition-based lapse rates with a 1-2-1 filter and recompute
    {
      var g = out.map(function (o) { return o.gamma; });
      for (i = 0; i < out.length; i++) {
        if (out[i].source !== 'conditions') continue;
        var a = i > 0 && out[i - 1].source === 'conditions' ? g[i - 1] : g[i];
        var b = i < out.length - 1 && out[i + 1].source === 'conditions' ? g[i + 1] : g[i];
        var sm = (a + 2 * g[i] + b) / 4;
        out[i].gamma = sm;
        out[i].raw = out[i].tModel - sm * dz;
      }
    }
    // damp the diurnal swing about a 24 h running mean: a centred half-open 24 h window,
    // slid inward at the ends of the series so it always spans a full diurnal cycle
    var damp = clamp01(opts.damping || 0), span = 24 * 3600e3;
    var tMin = out.length ? out[0].t : 0, tMax = out.length ? out[out.length - 1].t : 0;
    for (i = 0; i < out.length; i++) {
      var lo = out[i].t - span / 2, hi = lo + span;
      if (hi > tMax + 1) { hi = tMax + 1; lo = hi - span; }
      if (lo < tMin) { lo = tMin; hi = lo + span; }
      var s = 0, n = 0;
      for (var j = 0; j < out.length; j++) if (out[j].t >= lo && out[j].t < hi) { s += out[j].raw; n++; }
      var rm = n ? s / n : out[i].raw, o = out[i], r2 = o.row;
      o.tSummit = rm + (o.raw - rm) * (1 - damp) + (opts.bias || 0);
      o.wModel = r2.wind != null ? r2.wind : null;
      o.wSummit = o.wModel != null ? o.wModel * (opts.speedUp || 1) : null;
      o.feels = o.wSummit != null ? windChill(o.tSummit, o.wSummit) : o.tSummit;
      o.freezeZ = opts.zSummit + 1000 * o.tSummit / clamp(o.gamma, 3.5, 11); // extend the summit temperature with the hour's rate, held to a plausible range
      var mp = modelPressure(r2, opts.zModel);
      o.pModel = mp.p; o.pSrc = mp.src;
      o.pSummit = summitPressure(mp.p, o.tModel, r2.rh != null ? r2.rh : null, o.tSummit, opts.zSummit - opts.zModel);
      o.layerTv = o.extra.layerTv != null ? o.extra.layerTv : null;
      o.hy = o.extra.hy || null;
      o.nStn = o.extra.nStn != null ? o.extra.nStn : null;
      o.rh = r2.rh != null ? r2.rh : null;
      o.cloud = r2.cloud != null ? r2.cloud : null;
      o.precip = r2.precip != null ? r2.precip : null;
      o.phase = o.precip != null && o.precip > 0.05 ? (o.tSummit <= 0 ? 'snow' : o.tSummit < 1.5 ? 'mix' : 'rain') : '';
    }
    return out;
  }

  function summarize(res) {
    if (!res.length) return null;
    var lo = res[0], hi = res[0], minF = res[0], below = 0, maxW = null, dSum = 0, gSum = 0, wetSnow = 0;
    res.forEach(function (o) {
      if (o.tSummit < lo.tSummit) lo = o;
      if (o.tSummit > hi.tSummit) hi = o;
      if (o.feels < minF.feels) minF = o;
      if (o.tSummit <= 0) below++;
      if (o.wSummit != null && (maxW == null || o.wSummit > maxW.wSummit)) maxW = o;
      dSum += o.tSummit - o.tModel; gSum += o.gamma;
      if (o.phase === 'snow') wetSnow++;
    });
    return { lo: lo, hi: hi, minFeels: minF, below: below, hours: res.length, maxWind: maxW, meanDelta: dSum / res.length, meanGamma: gSum / res.length, snowHours: wetSnow };
  }

  /* -------------------------------------------------------- example data */

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function isoLocal(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + ':00';
  }

  // One hour of a plausible three-day weather story at the model cell: a clear cool day, a clouding-over day and a frontal passage.
  function exampleHour(h) {
    var hod = h % 24, day = Math.floor(h / 24);
    var amp = [5.2, 3.6, 2.0][day], mean = [9.0, 8.0, 6.0][day];
    var front = clamp((h - 50) / 10, 0, 1);
    var temp = mean - 6.5 * front - amp * Math.cos(2 * Math.PI * (hod - 15) / 24) + 0.4 * Math.sin(h * 1.7);
    var cloud = clamp([15, 45, 92][day] + 25 * Math.sin((h - 12) / 9) + 35 * front, 5, 100);
    var precip = h >= 54 && h < 66 ? 0.4 + 2.1 * Math.abs(Math.sin((h - 54) / 3.8)) : h >= 66 && h < 70 ? 0.15 : 0;
    var rh = clamp(88 - 34 * Math.max(0, Math.cos(2 * Math.PI * (hod - 15) / 24)) * (1 - 0.6 * day / 2) + 8 * day + (precip > 0 ? 12 : 0), 30, 100);
    var wind = [9, 16, 28][day] + 4 * Math.sin(h / 4) + 22 * Math.sin(Math.PI * clamp((h - 48) / 24, 0, 1));
    var dayHeat = Math.max(0, Math.cos(2 * Math.PI * (hod - 14) / 24));
    var gam = precip > 0 || rh > 90 ? 5.2 : cloud < 35 ? (dayHeat > 0.3 ? 7.6 : 3.4) : 6.3;
    return { hod: hod, temp: temp, cloud: cloud, precip: precip, rh: rh, wind: Math.max(2, wind), gam: gam, front: front, dayHeat: dayHeat };
  }

  // 72 hours of model output for a valley-floor grid cell at zModel; startMs is midnight (UTC-naive wall clock).
  // The 700 hPa height is derived hydrostatically from the same temperature profile, so the example columns agree.
  function exampleForecastCsv(startMs, zModel) {
    var lines = ['time,temp_c,rh_pct,wind_kph,cloud_pct,precip_mm,p_sfc_hpa,t_upper_c,p_upper_hpa,z_upper_m'];
    for (var h = 0; h < 72; h++) {
      var e = exampleHour(h);
      var pM = stdPressure(zModel) + 3.5 * Math.sin(h / 17) - 7 * e.front;
      var tv = virtualK(e.temp, specHum(e.rh, e.temp, pM));
      var zU = zModel + hypsoThickness(tv, pM, 700, e.gam / 1000);
      var tU = e.temp - e.gam * (zU - zModel) / 1000;
      lines.push([isoLocal(startMs + h * 3600e3), e.temp.toFixed(1), Math.round(e.rh), e.wind.toFixed(0), Math.round(e.cloud), e.precip.toFixed(1),
        pM.toFixed(1), tU.toFixed(1), 700, Math.round(zU)].join(','));
    }
    return lines.join('\n');
  }

  var EXAMPLE_STATIONS = [
    { name: 'Notch Base', e: -9.5, n: -6.0, z: 430, bias: 0.3 },
    { name: 'Tannery Flat', e: 6.8, n: -8.2, z: 640, bias: -0.2 },
    { name: 'Mill Pond', e: -4.1, n: 3.9, z: 820, bias: 0.1 },
    { name: 'Col House', e: 2.6, n: -1.5, z: 1140, bias: -0.3 },
    { name: 'Shoulder Hut', e: -1.8, n: 1.2, z: 1490, bias: 0.2 },
    { name: 'Ridge Tower', e: 3.4, n: 2.7, z: 1670, bias: -0.1 }
  ];

  // Six invented stations around the example summit, with a valley cold pool on clear calm nights.
  function exampleStationsCsv(startMs, zModel) {
    var lines = ['station,east_km,north_km,elev_m,time,temp_c'];
    for (var h = 0; h < 72; h++) {
      var e = exampleHour(h), clearCalmNight = e.cloud < 35 && e.wind < 14 && (e.hod >= 19 || e.hod <= 7);
      EXAMPLE_STATIONS.forEach(function (s, i) {
        var pool = clearCalmNight && s.z < 800 ? -2.4 * (800 - s.z) / 370 : 0;
        var T = e.temp - e.gam * (s.z - zModel) / 1000 + s.bias + pool + 0.25 * Math.sin(h * (1.3 + i * 0.4) + i);
        lines.push([s.name, s.e, s.n, s.z, isoLocal(startMs + h * 3600e3), T.toFixed(1)].join(','));
      });
    }
    return lines.join('\n');
  }

  /* ------------------------------------------------------- NWS gridpoints */

  var HOUR = 3600e3;
  var TZ_FORMATTERS = {};

  // Wall-clock reading of an instant in an IANA zone, as a "UTC-naive" ms value (getUTC* then shows the local time).
  function wallMs(instantMs, tz) {
    var f = TZ_FORMATTERS[tz];
    if (!f) {
      f = TZ_FORMATTERS[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    var p = {};
    f.formatToParts(new Date(instantMs)).forEach(function (x) { p[x.type] = +x.value; });
    return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  }
  // Inverse of wallMs (for a wall time that occurs twice, or never, this returns one sensible instant).
  function instantFromWall(wall, tz) {
    var guess = wall, off = wallMs(guess, tz) - guess;
    var inst = wall - off;
    off = wallMs(inst, tz) - inst;
    return wall - off;
  }

  // ISO 8601 duration such as PT6H, P1D, P1DT6H or PT30M, in ms
  function parseIsoDuration(s) {
    var m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(s).trim());
    if (!m) return null;
    return ((+m[1] || 0) * 7 * 24 + (+m[2] || 0) * 24 + (+m[3] || 0)) * HOUR + (+m[4] || 0) * 60e3 + (+m[5] || 0) * 1e3;
  }
  // "2026-09-30T14:00:00+00:00/PT3H" -> {start,end} in epoch ms
  function parseValidTime(s) {
    var p = String(s).split('/');
    if (p.length !== 2) return null;
    var start = Date.parse(p[0]), dur = parseIsoDuration(p[1]);
    if (!(start === start) || dur == null || dur <= 0) return null;
    return { start: start, end: start + dur };
  }

  function convertUnit(v, uom, kind) {
    uom = String(uom || '');
    if (kind === 'temp') return /degF|\[degF\]/i.test(uom) ? (v - 32) * 5 / 9 : /(^|:)K$/.test(uom) ? v - 273.15 : v;
    if (kind === 'wind') {
      if (/m_s/.test(uom)) return v * 3.6;
      if (/kn|kt/i.test(uom)) return v * 1.852;
      if (/mi_h|mi_i|mph/i.test(uom)) return v * 1.609344;
      return v;
    }
    if (kind === 'len') { // precipitation / snowfall to mm
      if (/in_i|\[in/i.test(uom)) return v * 25.4;
      if (/(^|:)m$/.test(uom)) return v * 1000;
      if (/(^|:)cm$/.test(uom)) return v * 10;
      return v;
    }
    return v;
  }

  // Turn a gridpoint series ({uom, values:[{validTime,value}]}) into intervals, dropping null values.
  function seriesIntervals(series, kind) {
    var out = [];
    if (!series || !series.values) return out;
    for (var i = 0; i < series.values.length; i++) {
      var e = series.values[i], vt = parseValidTime(e.validTime);
      if (!vt || e.value == null || !(e.value === e.value)) continue;
      out.push({ start: vt.start, end: vt.end, v: kind ? convertUnit(Number(e.value), series.uom, kind) : Number(e.value) });
    }
    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }

  // Value at hour h: linear between the starts of back-to-back intervals, held otherwise.
  function instantAt(iv, h) {
    var lo = 0, hi = iv.length - 1, k = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (iv[mid].start <= h) { k = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (k < 0 || h >= iv[k].end) return null;
    var a = iv[k], b = iv[k + 1], dur = a.end - a.start;
    if (dur > HOUR && b && b.start === a.end) return a.v + (b.v - a.v) * (h - a.start) / dur;
    return a.v;
  }

  // Precipitation-like amounts are spread evenly over their interval; returns mm for the hour starting at h.
  function amountAt(iv, h) {
    var tot = 0, seen = false;
    for (var i = 0; i < iv.length; i++) {
      var a = iv[i];
      if (a.end <= h || a.start >= h + HOUR) continue;
      var ov = Math.min(a.end, h + HOUR) - Math.max(a.start, h);
      tot += a.v * ov / (a.end - a.start); seen = true;
    }
    return seen ? tot : null;
  }

  function dewRh(tC, tdC) { return clamp(100 * satVapPa(tdC) / satVapPa(tC), 1, 100); }

  // One NWS gridpoint "properties" object -> hourly rows in the format downscale() takes.
  function parseNwsGrid(props, opts) {
    opts = opts || {};
    var out = { rows: [], zModel: null, updateTime: null, tz: opts.tz || 'America/New_York', warnings: [] };
    if (!props || !props.temperature) { out.warnings.push('The data has no temperature series.'); return out; }
    if (props.elevation && props.elevation.value != null) {
      var ev = Number(props.elevation.value);
      out.zModel = /ft/i.test(props.elevation.unitCode || '') ? ev * 0.3048 : ev;
    }
    out.updateTime = props.updateTime || null;
    var T = seriesIntervals(props.temperature, 'temp');
    if (!T.length) { out.warnings.push('The temperature series is empty.'); return out; }
    var RH = seriesIntervals(props.relativeHumidity), TD = seriesIntervals(props.dewpoint, 'temp');
    var W = seriesIntervals(props.windSpeed, 'wind'), G = seriesIntervals(props.windGust, 'wind');
    var WD = seriesIntervals(props.windDirection), SC = seriesIntervals(props.skyCover);
    var Q = seriesIntervals(props.quantitativePrecipitationAmount, 'len'), SN = seriesIntervals(props.snowfallAmount, 'len');
    var POP = seriesIntervals(props.probabilityOfPrecipitation);
    var h0 = Math.ceil(T[0].start / HOUR) * HOUR, h1 = T[T.length - 1].end;
    var maxH = opts.maxHours || 168, last = -Infinity, dup = 0, n = 0;
    for (var h = h0; h < h1 && n < maxH; h += HOUR) {
      var temp = instantAt(T, h);
      if (temp == null) continue;
      var t = wallMs(h, out.tz);
      if (t <= last) { dup++; continue; }   // the repeated hour when clocks go back
      last = t; n++;
      var row = { t: t, temp: temp };
      var rh = instantAt(RH, h), td = instantAt(TD, h);
      if (rh != null) row.rh = clamp(rh, 1, 100);
      else if (td != null) row.rh = dewRh(temp, Math.min(td, temp));
      var v;
      if ((v = instantAt(W, h)) != null) row.wind = Math.max(0, v);
      if ((v = instantAt(G, h)) != null) row.gust = Math.max(0, v);
      if ((v = instantAt(WD, h)) != null) row.wdir = v;
      if ((v = instantAt(SC, h)) != null) row.cloud = clamp(v, 0, 100);
      if (Q.length) row.precip = Math.max(0, amountAt(Q, h) || 0);
      if (SN.length) row.snow = Math.max(0, amountAt(SN, h) || 0);
      if ((v = instantAt(POP, h)) != null) row.pop = clamp(v, 0, 100);
      out.rows.push(row);
    }
    if (dup) out.warnings.push(dup + ' repeated hour' + (dup > 1 ? 's' : '') + ' from the daylight-saving change dropped.');
    if (!out.rows.length) out.warnings.push('No hourly rows could be built.');
    if (out.zModel == null) out.warnings.push('The data has no grid-cell elevation, so the model elevation must be entered by hand.');
    return out;
  }

  var BUNDLE_FORMAT = 'nh48-nws-v1';

  // Bundle written by fetch_nh48_nws.py: {format, generated, grids:{key:{...gridpoint properties, timeZone}}, peaks:{id:{grid,lat,lon,error}}}
  function parseNwsBundle(obj) {
    var out = { generated: obj.generated || null, peaks: {}, warnings: [], ok: 0, failed: 0 };
    var peaks = obj.peaks || {}, grids = obj.grids || {}, cache = {};
    Object.keys(peaks).forEach(function (id) {
      var pk = peaks[id], g = pk && pk.grid ? grids[pk.grid] : null;
      if (!g) { out.peaks[id] = { error: (pk && pk.error) || 'No forecast was fetched for this summit.', rows: [] }; out.failed++; return; }
      if (!cache[pk.grid]) cache[pk.grid] = parseNwsGrid(g, { tz: g.timeZone || pk.timeZone });
      var p = cache[pk.grid];
      if (!p.rows.length) { out.peaks[id] = { error: p.warnings.join(' ') || 'Empty forecast.', rows: [] }; out.failed++; return; }
      // lat/lon is the point the /points call was made for; center (when the service saved it) is the middle of the grid cell
      out.peaks[id] = { rows: p.rows, zModel: p.zModel, updateTime: p.updateTime, tz: p.tz, grid: pk.grid, warnings: p.warnings,
        lat: pk.lat != null ? pk.lat : null, lon: pk.lon != null ? pk.lon : null,
        center: g.center && g.center.length === 2 && isFinite(g.center[0]) && isFinite(g.center[1]) ? [Number(g.center[0]), Number(g.center[1])] : null };
      out.ok++;
    });
    if (!Object.keys(peaks).length) out.warnings.push('The file lists no summits.');
    return out;
  }

  // Sniff pasted or loaded text: a bundle, or one raw /gridpoints response.
  function detectNwsInput(text) {
    var obj;
    try { obj = JSON.parse(text); } catch (e) { return { kind: null }; }
    if (obj && obj.format === BUNDLE_FORMAT) return { kind: 'bundle', obj: obj };
    var props = obj && obj.properties ? obj.properties : obj;
    if (props && props.temperature && props.temperature.values) return { kind: 'gridpoint', props: props };
    return { kind: null };
  }

  /* --------------------------------------------- example NWS bundle (invented) */

  function hashUnit(str) { // deterministic 0..1 from a string
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 100000) / 100000;
  }

  // Invented forecast in the same shape as the real bundle. startWall is local midnight as a UTC-naive ms value.
  function exampleNwsBundle(peaks, startWall) {
    var tz = 'America/New_York', start = instantFromWall(startWall, tz);
    var cells = {}, out = { format: BUNDLE_FORMAT, generated: new Date(start).toISOString(), example: true, source: 'invented example data', grids: {}, peaks: {} };
    peaks.forEach(function (pk) {
      var key = 'EXAMPLE/' + Math.round(pk.lat / 0.03) + ',' + Math.round(pk.lon / 0.03);
      (cells[key] = cells[key] || []).push(pk);
      out.peaks[pk.id] = { grid: key, lat: pk.lat, lon: pk.lon };
    });
    Object.keys(cells).forEach(function (key) {
      var mean = cells[key].reduce(function (s, p) { return s + p.m; }, 0) / cells[key].length;
      // a 2.5 km NWS cell smooths the mountains down to roughly 55-80% of the summit height
      var zM = Math.round(mean * (0.55 + 0.25 * hashUnit(key)));
      var series = { temperature: [], relativeHumidity: [], windSpeed: [], windGust: [], skyCover: [], quantitativePrecipitationAmount: [] };
      for (var h = 0; h < 72; h++) {
        var e = exampleHour(h), vt = new Date(start + h * HOUR).toISOString().replace('.000Z', '+00:00') + '/PT1H';
        series.temperature.push({ validTime: vt, value: +(e.temp - 6.0 * (zM - 500) / 1000).toFixed(1) });
        series.relativeHumidity.push({ validTime: vt, value: Math.round(e.rh) });
        series.windSpeed.push({ validTime: vt, value: +(e.wind * (1 + zM / 3000)).toFixed(1) });
        series.windGust.push({ validTime: vt, value: +(e.wind * (1 + zM / 3000) * 1.5).toFixed(1) });
        series.skyCover.push({ validTime: vt, value: Math.round(e.cloud) });
        series.quantitativePrecipitationAmount.push({ validTime: vt, value: +e.precip.toFixed(1) });
      }
      out.grids[key] = {
        elevation: { unitCode: 'wmoUnit:m', value: zM }, updateTime: new Date(start).toISOString(), timeZone: tz,
        temperature: { uom: 'wmoUnit:degC', values: series.temperature },
        relativeHumidity: { uom: 'wmoUnit:percent', values: series.relativeHumidity },
        windSpeed: { uom: 'wmoUnit:km_h-1', values: series.windSpeed },
        windGust: { uom: 'wmoUnit:km_h-1', values: series.windGust },
        skyCover: { uom: 'wmoUnit:percent', values: series.skyCover },
        quantitativePrecipitationAmount: { uom: 'wmoUnit:mm', values: series.quantitativePrecipitationAmount }
      };
    });
    return out;
  }

  /* ------------------------------------------------------------------ live look: Mount Washington Auto Road stations */
  // Temperature sensors along the Auto Road (475 m to 1,616 m) and on the summit tower (1,923 m), one reading a minute.
  // The live-look lapse rate is fitted to the profile they draw right now. It is good for the next few hours only.

  var AR_FORMAT = 'nh48-autoroad-v1';
  var LIVE_LAPSE_MIN = -15, LIVE_LAPSE_MAX = 12;   // K/km. Wider than the forecast methods: a real inversion can be steeper than -5 over a layer
  var LIVE_SCALE_KM = 50;                          // distance at which the road profile is only half as representative of a summit
  var LIVE_NOISE_K = 0.3;                          // noise floor added to a station's own scatter when weighting it, K

  function median(a) {
    var s = a.slice().sort(function (x, y) { return x - y; }), n = s.length;
    return !n ? NaN : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }
  var NOT_AIR = /road\s*(surface\s*)?temp|pavement|surface|soil|ground/i;   // labels of measurements and sensors that are not air temperature
  function stationIsTower(st) { return st.id === 'SUMT' || /tower/i.test(st.name || ''); }

  // Reads the endpoint's own answer ({ AR16: {metadata, measurements}, ... }) or the slimmed copy the dashboard's service saves
  // ({ format: 'nh48-autoroad-v1', fetched, stations: [{id, name, z, lat, lon, sensors: [{id, note, t: [epoch s], v: [degC]}]}] }).
  // Returns { ok, stations: [{id, name, z, lat, lon, sensors: [{id, note, pts: [[epoch ms, degC], ...] sorted}]}], fetched, warnings }.
  function parseAutoRoad(obj) {
    var out = { ok: false, stations: [], fetched: null, warnings: [] }, warn = out.warnings;
    if (!obj || typeof obj !== 'object') { warn.push('The Auto Road answer was empty.'); return out; }
    var good = function (v) { return typeof v === 'number' && isFinite(v) && v > -60 && v < 50; };
    var addStation = function (id, name, z, lat, lon, sensors) {
      if (!(typeof z === 'number' && isFinite(z))) { warn.push(id + ' has no elevation.'); return; }
      sensors = sensors.filter(function (s) { return s.pts.length; });
      if (!sensors.length) return;
      out.stations.push({ id: String(id).slice(0, 12), name: String(name || id).slice(0, 40), z: z, lat: isFinite(lat) ? lat : null, lon: isFinite(lon) ? lon : null, sensors: sensors });
    };
    if (obj.format === AR_FORMAT && Array.isArray(obj.stations)) {
      var f = Date.parse(obj.fetched); out.fetched = isFinite(f) ? f : null;
      obj.stations.forEach(function (s) {
        var sens = (s.sensors || []).map(function (q) {
          var pts = [], t = q.t || [], v = q.v || [];
          for (var i = 0; i < t.length && i < v.length; i++) if (good(v[i]) && isFinite(t[i])) pts.push([t[i] * 1000, v[i]]);
          pts.sort(function (a, b) { return a[0] - b[0]; });
          return { id: q.id, note: String(q.note || '').slice(0, 60), pts: pts };
        });
        addStation(s.id, s.name, s.z, s.lat, s.lon, sens);
      });
    } else {
      Object.keys(obj).forEach(function (id) {
        var st = obj[id];
        if (!st || typeof st !== 'object' || !st.metadata || !Array.isArray(st.measurements)) return;
        var md = st.metadata;
        if (md.stationDecommissionDate && Date.parse(md.stationDecommissionDate) < Date.now()) return;
        var sens = [];
        st.measurements.forEach(function (m) {
          // air temperature only: never the road surface, pavement or ground temperature, and only in degrees C (or F, converted)
          if (m.measurement_key !== 'air_temperature' || NOT_AIR.test(String(m.measurement_name || ''))) return;
          var unit = String(m.unitSymbol || 'degC').toLowerCase(), toC = unit === 'degc' || unit === 'c' ? function (v) { return v; } : unit === 'degf' || unit === 'f' ? function (v) { return (v - 32) * 5 / 9; } : null;
          if (!toC) return;
          (m.sensors || []).forEach(function (q) {
            if (NOT_AIR.test(String(q.instrument_notes || ''))) return;
            var pts = [];
            (q.series || []).forEach(function (p) {
              var t = Date.parse(p.date), v = p.value == null ? NaN : toC(Number(p.value));
              if (isFinite(t) && good(v) && !(p.qa_flag > 0)) pts.push([t, v]);
            });
            pts.sort(function (a, b) { return a[0] - b[0]; });
            sens.push({ id: q.instrument_id, note: String(q.instrument_notes || '').slice(0, 60), pts: pts });
          });
        });
        addStation(md.stationName || id, md.stationLongName || id, Number(md.elevationMasl), Number(md.latitude), Number(md.longitude), sens);
      });
    }
    out.stations.sort(function (a, b) { return a.z - b.z; });
    out.ok = out.stations.length >= 2;
    if (!out.ok) warn.push('The Auto Road answer holds fewer than two stations with temperature.');
    return out;
  }

  // Each station's temperature "now": the median of its readings in the last `medianMin` minutes, its scatter over that time,
  // and its age. Sensors on one station are averaged (the tower has two). nowMs is the browser clock (or a test's).
  function liveProfile(data, nowMs, opts) {
    opts = opts || {};
    var medianMin = opts.medianMin || 8, staleMin = opts.staleMin || 45, out = { ok: false, stations: [], tower: null, newest: null, warnings: [], nowMs: nowMs };
    if (!data || !data.ok) return out;
    data.stations.forEach(function (st) {
      var vals = [], sds = [], last = -Infinity;
      st.sensors.forEach(function (s) {
        if (!s.pts.length) return;
        var tl = s.pts[s.pts.length - 1][0], w = s.pts.filter(function (p) { return p[0] >= tl - medianMin * 60e3; }).map(function (p) { return p[1]; });
        if (w.length < 3) return;
        var m = median(w), mad = median(w.map(function (v) { return Math.abs(v - m); }));
        vals.push(m); sds.push(Math.max(0.05, 1.4826 * mad)); if (tl > last) last = tl;
      });
      var e = { id: st.id, name: st.name, z: st.z, lat: st.lat, lon: st.lon, T: NaN, sd: NaN, t: last, ageMin: (nowMs - last) / 60e3, ok: false, reason: '', tower: stationIsTower(st), spread: 0, nSensors: vals.length };
      if (!vals.length) e.reason = 'no recent readings';
      else {
        e.T = vals.reduce(function (s, v) { return s + v; }, 0) / vals.length;
        e.sd = Math.max.apply(null, sds);
        e.spread = vals.length > 1 ? Math.max.apply(null, vals) - Math.min.apply(null, vals) : 0;
        if (e.spread > 1.5) e.sd = Math.max(e.sd, e.spread / 2);         // two sensors that disagree count as noisy
        if (e.ageMin > staleMin) e.reason = 'last reading ' + Math.round(e.ageMin) + ' min ago';
        else e.ok = true;
      }
      out.stations.push(e);
      if (e.ok && (out.newest == null || e.t > out.newest)) out.newest = e.t;
      if (e.tower) out.tower = e;
    });
    out.ok = out.stations.filter(function (s) { return s.ok; }).length >= 3 && out.newest != null;
    if (!out.ok) out.warnings.push('Fewer than three Auto Road stations have a reading from the last ' + staleMin + ' minutes.');
    return out;
  }

  // Robust weighted line through the profile: T = tbar + b (z - zbar), Tukey biweight, stations weighted by 1 / (noise floor^2 + own scatter^2)
  // and, for a layer fit, by a tricube kernel in elevation around the layer. Returns null when the stations span under 100 m.
  function liveLine(st, kernel) {
    var n = st.length, base = st.map(function (s, i) { return kernel[i] / (LIVE_NOISE_K * LIVE_NOISE_K + s.sd * s.sd); });
    var z = st.map(function (s) { return s.z; }), T = st.map(function (s) { return s.T; }), rob = new Array(n).fill(1), fit = null, i, j, it;
    // start from a Theil-Sen line (the median of the slopes between pairs of stations) so that one wild station cannot pull the start
    var slopes = [];
    for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) if (base[i] > 0 && base[j] > 0 && Math.abs(z[j] - z[i]) >= 100) slopes.push((T[j] - T[i]) / (z[j] - z[i]));
    var ts = null;
    if (slopes.length >= 2) {
      var b0 = median(slopes), zb0 = 0, sw0 = 0;
      for (i = 0; i < n; i++) { zb0 += base[i] * z[i]; sw0 += base[i]; }
      zb0 /= sw0;
      ts = { b: b0, a: median(T.map(function (t, k) { return t - b0 * (z[k] - zb0); }).filter(function (v, k) { return base[k] > 0; })), zb: zb0 };
    }
    var robustWeights = function (res) {
      var act = [];
      for (var q = 0; q < n; q++) if (base[q] > 0) act.push(Math.abs(res[q]));
      var sc = Math.max(0.4, 1.4826 * median(act));
      return res.map(function (r) { var u = r / (4.685 * sc); return Math.abs(u) < 1 ? (1 - u * u) * (1 - u * u) : 0; });
    };
    if (ts) rob = robustWeights(T.map(function (t, k) { return t - (ts.a + ts.b * (z[k] - ts.zb)); }));
    if (rob.filter(function (r, k) { return base[k] * r > 0; }).length < 3) rob = new Array(n).fill(1);
    for (it = 0; it < 6; it++) {
      var w = base.map(function (b, k) { return b * rob[k]; });
      var f = wlsLine(z, T, w);
      if (!f) break;
      fit = f;
      var next = robustWeights(T.map(function (t, k) { return t - (f.tbar + f.b * (z[k] - f.zbar)); }));
      var alive = 0; for (i = 0; i < n; i++) if (base[i] * next[i] > 0) alive++;
      if (alive < 3) break;
      rob = next;
    }
    if (!fit) return null;
    var wf = base.map(function (b, k) { return b * rob[k]; }), zb = fit.zbar, resid = [], chi = 0, neff = 0, szz = 0, bmax = Math.max.apply(null, base), scale = 0.4;
    var r0 = T.map(function (t, k) { return t - (fit.tbar + fit.b * (z[k] - zb)); });
    scale = Math.max(0.4, 1.4826 * median(r0.filter(function (r, k) { return base[k] > 0; }).map(Math.abs)));
    for (i = 0; i < n; i++) {
      var rc = Math.max(-3 * scale, Math.min(3 * scale, r0[i]));
      if (base[i] > 0.05 * bmax) { chi += base[i] * rc * rc; neff++; szz += base[i] * (z[i] - zb) * (z[i] - zb); }
      resid.push({ id: st[i].id, r: r0[i], w: base[i] > 0 ? wf[i] / base[i] : 0, out: base[i] > 0 && wf[i] === 0 });
    }
    var dof = Math.max(1, neff - 2), infl = Math.max(1, chi / dof);
    var seB = szz > 0 ? Math.sqrt(infl / szz) : Infinity;
    return { zbar: zb, tbar: fit.tbar, b: fit.b, se: seB * 1000, resid: resid, scale: scale, neff: neff };
  }
  function tricube(u) { u = Math.abs(u); return u >= 1 ? 0 : Math.pow(1 - u * u * u, 3); }

  // The live-look lapse rate for the layer between two heights: opts { zLo, zHi, holdOutTower }. Falls back to the whole column when
  // fewer than three stations fall near the layer. gamma is the cooling rate with height in K/km (negative in an inversion).
  function liveLapse(profile, zLo, zHi, opts) {
    opts = opts || {};
    var st = profile.stations.filter(function (s) { return s.ok && !(opts.holdOutTower && s.tower); });
    var res = { ok: false, n: st.length, layer: false };
    if (st.length < 3) return res;
    var lo = Math.min(zLo, zHi), hi = Math.max(zLo, zHi), mid = (lo + hi) / 2, hw = Math.max((hi - lo) / 2, 200), bw = hw + 300, fit = null;
    if (opts.zLo != null || zLo != null) {
      var ker = st.map(function (s) { return tricube((s.z - mid) / bw); }), near = ker.filter(function (k) { return k > 0.05; }).length;
      if (near >= 3) fit = liveLine(st, ker);
      if (fit) {
        var zs = st.filter(function (s, k) { return ker[k] > 0.05; }).map(function (s) { return s.z; });
        if (Math.max.apply(null, zs) - Math.min.apply(null, zs) < 250) fit = null;
      }
      if (fit) res.layer = true;
    }
    if (!fit) fit = liveLine(st, st.map(function () { return 1; }));
    if (!fit) return res;
    // leave-one-out: how far the answer moves when any single station is dropped (a fragile fit is not to be trusted)
    var kerUsed = res.layer ? st.map(function (s) { return tricube((s.z - mid) / bw); }) : st.map(function () { return 1; }), loo = [];
    st.forEach(function (s, j) {
      if (kerUsed[j] <= 0.05) return;
      var keep = st.map(function (q, k) { return k !== j; }), sub = st.filter(function (q, k) { return keep[k]; }), sk = kerUsed.filter(function (q, k) { return keep[k]; });
      if (sk.filter(function (v) { return v > 0.05; }).length < 3) return;
      var f2 = liveLine(sub, sk);
      if (f2) loo.push(-f2.b * 1000);
    });
    res.jack = loo.length ? Math.max.apply(null, loo) - Math.min.apply(null, loo) : 0;
    var g = -fit.b * 1000, top = Math.max.apply(null, st.map(function (s) { return s.z; })), bot = Math.min.apply(null, st.map(function (s) { return s.z; }));
    res.ok = true; res.gamma = Math.max(LIVE_LAPSE_MIN, Math.min(LIVE_LAPSE_MAX, g)); res.raw = g; res.clamped = res.gamma !== g;
    res.se = fit.se; res.line = { zbar: fit.zbar, tbar: fit.tbar, b: fit.b }; res.resid = fit.resid; res.scale = fit.scale; res.neff = fit.neff;
    res.zTop = top; res.zBot = bot; res.holdOut = !!opts.holdOutTower;
    res.extrap = Math.max(0, hi - top) + Math.max(0, bot - lo);       // metres of the layer that lie outside the stations
    res.at = function (z) { return fit.tbar + fit.b * (z - fit.zbar); };
    return res;
  }

  // Layers between neighbouring stations, and the warm layers (temperature rising with height) among them.
  function liveLayers(profile) {
    var st = profile.stations.filter(function (s) { return s.ok; }).sort(function (a, b) { return a.z - b.z; }), out = [], inv = [], i, cur = null;
    for (i = 1; i < st.length; i++) {
      var a = st[i - 1], b = st[i], dz = b.z - a.z, dT = b.T - a.T, g = dz > 0 ? -dT / dz * 1000 : NaN;
      var cls = g < 0 ? 'inversion' : g < 2 ? 'very stable' : g < 5 ? 'stable' : g < 7.5 ? 'typical' : g <= 9.8 ? 'steep' : 'superadiabatic';
      var L = { lo: a, hi: b, dz: dz, dT: dT, gamma: g, cls: cls, thin: dz < 150, noisy: Math.max(a.sd, b.sd) > 0.8 };
      out.push(L);
      if (dT > 0.5 && dz > 0) { if (cur) { cur.top = b; cur.dT += dT; cur.dz += dz; } else { cur = { base: a, top: b, dT: dT, dz: dz }; inv.push(cur); } }
      else cur = null;
    }
    return { layers: out, inversions: inv };
  }

  // The whole-column lapse rate at earlier times: robust fit through the stations, every stepMin minutes for the last windowMin.
  function liveTrend(data, nowMs, opts) {
    opts = opts || {};
    var windowMin = opts.windowMin || 120, step = opts.stepMin || 5, prof0 = liveProfile(data, nowMs, opts), out = [];
    if (!prof0.ok) return out;
    var tEnd = prof0.newest, t, k;
    for (t = tEnd - windowMin * 60e3; t <= tEnd + 1; t += step * 60e3) {
      var stations = [];
      data.stations.forEach(function (st) {
        if (opts.holdOutTower && stationIsTower(st)) return;
        var v = [];
        st.sensors.forEach(function (s) {
          var w = s.pts.filter(function (p) { return Math.abs(p[0] - t) <= 4 * 60e3; }).map(function (p) { return p[1]; });
          if (w.length >= 2) v.push(median(w));
        });
        if (v.length) stations.push({ id: st.id, z: st.z, T: v.reduce(function (s, x) { return s + x; }, 0) / v.length, sd: 0.3, ok: true, tower: stationIsTower(st) });
      });
      if (stations.length < 4) continue;
      var f = liveLine(stations, stations.map(function () { return 1; }));
      if (f) out.push({ t: t, gamma: Math.max(LIVE_LAPSE_MIN, Math.min(LIVE_LAPSE_MAX, -f.b * 1000)), n: stations.length });
    }
    // steps where a station had not yet reported would change the mix of stations and make the line jump: keep the steps with the full set
    var nMax = out.reduce(function (m, p) { return Math.max(m, p.n); }, 0);
    return out.filter(function (p) { return p.n === nMax; });
  }

  // Distance between two points, km (equirectangular; fine at these scales).
  function distKm(lat1, lon1, lat2, lon2) {
    var kx = M_PER_DEG_LON * Math.cos((lat1 + lat2) / 2 * Math.PI / 180) / 1000, ky = M_PER_DEG_LAT / 1000;
    return Math.hypot((lon2 - lon1) * kx, (lat2 - lat1) * ky);
  }

  // How much to trust the live lapse rate for a summit, 0..1, and why. fit: liveLapse result.
  function liveConfidence(fit, ageMin, distKmToRoad) {
    var f = {};
    f.fit = 1 / (1 + Math.pow((fit.se || 0) / 2, 2));                       // slope uncertainty in K/km
    f.stations = fit.neff >= 5 ? 1 : fit.neff === 4 ? 0.85 : 0.6;
    f.age = ageMin <= 15 ? 1 : ageMin >= 45 ? 0 : 1 - (ageMin - 15) / 30;
    f.stable = 1 / (1 + Math.pow((fit.jack || 0) / 4, 2));                  // dropping one station moves the answer by this many K/km
    f.reach = fit.layer ? 1 : 0.85;                                         // the layer had too few stations, the whole column stands in
    f.extrap = 1 / (1 + Math.pow(fit.extrap / 600, 2));                     // part of the layer lies outside the stations
    f.distance = distKmToRoad == null ? 1 : 1 / (1 + Math.pow(distKmToRoad / LIVE_SCALE_KM, 2));
    var k = f.fit * f.stable * f.stations * f.age * f.reach * f.extrap * f.distance;
    return { k: Math.max(0, Math.min(1, k)), parts: f };
  }

  // Weight of the live look h hours after the observation: 1 at h = 0, 0.5 at half the horizon, 0 from the horizon on.
  // The hour before the observation ramps up so the hourly line meets the observed value.
  function liveWeight(hours, horizon) {
    if (hours >= horizon) return 0;
    if (hours >= 0) return 0.5 * (1 + Math.cos(Math.PI * hours / horizon));
    return hours > -1 ? 1 + hours : 0;
  }

  // Value of a series at an instant, by linear interpolation between hours. null outside the series.
  function interpAt(times, vals, t) {
    if (!times.length || t < times[0] - 1 || t > times[times.length - 1] + 1) return null;
    for (var i = 1; i < times.length; i++) if (t <= times[i]) { var f = times[i] > times[i - 1] ? (t - times[i - 1]) / (times[i] - times[i - 1]) : 0; return vals[i - 1] + f * (vals[i] - vals[i - 1]); }
    return vals[vals.length - 1];
  }

  // The live-look adjustment of a forecast. opts:
  //   times: forecast hours (wall-clock ms), base: baseline summit temperature per hour, cell: NWS cell temperature per hour,
  //   tNow: observation time (same clock as times), horizonH, dzKm: (summit - cell elevation)/1000,
  //   target: { kind: 'profile', gamma } the live lapse rate, K/km   or   { kind: 'tower', T } an observed summit temperature,
  //   k: confidence 0..1
  // The baseline's summit temperature at tNow is moved to the live value; that difference decays to zero over the horizon.
  // Returns { ok, delta0, w[], live[] (full-strength look, null after the horizon), shift[] (delta0 * k * w), tLive0, tBase0, gammaBase0 }.
  function liveAdjust(opts) {
    var times = opts.times, out = { ok: false, w: [], live: [], shift: [], delta0: 0 };
    var b0 = interpAt(times, opts.base, opts.tNow), c0 = interpAt(times, opts.cell, opts.tNow);
    if (b0 == null || c0 == null) { out.reason = 'The forecast does not cover the time of the observation.'; return out; }
    var t0 = opts.target.kind === 'tower' ? opts.target.T : c0 - opts.target.gamma * opts.dzKm;
    out.delta0 = t0 - b0; out.tLive0 = t0; out.tBase0 = b0; out.tCell0 = c0;
    out.gammaBase0 = Math.abs(opts.dzKm) > 1e-6 ? (c0 - b0) / opts.dzKm : null;
    var k = Math.max(0, Math.min(1, opts.k == null ? 1 : opts.k));
    for (var i = 0; i < times.length; i++) {
      var w = liveWeight((times[i] - opts.tNow) / 3600e3, opts.horizonH);
      out.w.push(w); out.live.push(w > 0 ? opts.base[i] + w * out.delta0 : null); out.shift.push(k * w * out.delta0);
    }
    out.ok = true; out.k = k;
    return out;
  }

  return {
    parseForecast: parseForecast, parseTime: parseTime, downscale: downscale, summarize: summarize,
    windChill: windChill, conditionLapse: conditionLapse,
    exampleForecastCsv: exampleForecastCsv, exampleStationsCsv: exampleStationsCsv, isoLocal: isoLocal,
    parseStations: parseStations, prepareBcdg: prepareBcdg, bcdgLapse: bcdgLapse, bcdgAnalyze: bcdgAnalyze,
    hypsoPressure: hypsoPressure, hypsoThickness: hypsoThickness, solveGamma: solveGamma, hypsoHour: hypsoHour, summitPressure: summitPressure,
    stdPressure: stdPressure, pressureFromMslp: pressureFromMslp, specHum: specHum, virtualK: virtualK, modelPressure: modelPressure,
    levelProfile: levelProfile, levelNear: levelNear, hypsoLevels: hypsoLevels, cleanLevels: cleanLevels, parseUpperAir: parseUpperAir, attachUpperAir: attachUpperAir,
    modelMslpAt: modelMslpAt, reduceToMsl: reduceToMsl, metarPressure: metarPressure, pressureAnchor: pressureAnchor, anchoredMslp: anchoredMslp,
    UA_FORMAT: UA_FORMAT, METAR_FORMAT: METAR_FORMAT, HYPSO_LV_M: HYPSO_LV_M, HYPSO_QC_K: HYPSO_QC_K, PRESSURE_TAU_H: PRESSURE_TAU_H,
    wallMs: wallMs, instantFromWall: instantFromWall, parseIsoDuration: parseIsoDuration, parseValidTime: parseValidTime,
    parseNwsGrid: parseNwsGrid, parseNwsBundle: parseNwsBundle, detectNwsInput: detectNwsInput, BUNDLE_FORMAT: BUNDLE_FORMAT,
    exampleNwsBundle: exampleNwsBundle,
    PRESCRIBED: PRESCRIBED, CLIM_DEFAULT: CLIM_DEFAULT, GAMMA_D: GAMMA_D, climLapse: climLapse,
    moistLapse: moistLapse, dewPointC: dewPointC, parcelLift: parcelLift,
    buildNwsNetwork: buildNwsNetwork, networkTarget: networkTarget, spatialAnalyze: spatialAnalyze, olsFit: olsFit, wlsLine: wlsLine,
    regionalWeather: regionalWeather, classifyRegime: classifyRegime, regionalLapse: regionalLapse, weightedQuantile: weightedQuantile, nistPercentile: nistPercentile, nistRanks: nistRanks, LEVELS: LEVELS, levelValues: levelValues, assignLevels: assignLevels, levelBetween: levelBetween, nistRankOf: nistRankOf,
    ensemble: ensemble, REGIMES: REGIMES, REGIME_ORDER: REGIME_ORDER, FAMILY: FAMILY,
    parseAutoRoad: parseAutoRoad, liveProfile: liveProfile, liveLapse: liveLapse, liveLayers: liveLayers, liveTrend: liveTrend, liveConfidence: liveConfidence,
    liveAdjust: liveAdjust, liveWeight: liveWeight, distKm: distKm, AR_FORMAT: AR_FORMAT, LIVE_SCALE_KM: LIVE_SCALE_KM
  };
});
