#!/usr/bin/env python3
"""Serve the NH 48 dashboard with Python only (no PHP needed).

    python3 serve.py --contact you@example.com            # then open http://localhost:8080/
    python3 serve.py --contact you@example.com --port 9000 --host 0.0.0.0

It also answers /api/autoroad.php (the Mount Washington Auto Road temperature stations, saved for a minute),
/api/upperair.php (model pressure levels for the Hypsometric method, saved for an hour) and /api/metar.php
(observed sea-level pressure at KHIE and KIZG, saved for five minutes).
It serves this folder and answers /api/nws.php the way api/nws.php does: it pulls the NWS gridded forecast for
the 48 summits from api.weather.gov, keeps one saved copy in cache/, and serves that copy for an hour.
A visitor's Refresh is ignored when the saved copy is under five minutes old. If NWS cannot be reached the
last saved copy is served. Python 3.8 or later, standard library only.

Use api/nws.php on a PHP host for a real deployment; this script is for running the dashboard on your own machine.
"""
import argparse
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs, urlencode

ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE_FILE = os.path.join(ROOT, "cache", "nh48_nws.json")
FORMAT = "nh48-nws-v1"
KEEP = ["temperature", "dewpoint", "relativeHumidity", "windSpeed", "windGust", "windDirection",
        "skyCover", "quantitativePrecipitationAmount", "snowfallAmount", "probabilityOfPrecipitation"]
RETRY = {0, 429, 500, 502, 503, 504}
AR_FILE = os.path.join(ROOT, "cache", "nh48_autoroad.json")
AR_FORMAT = "nh48-autoroad-v1"
AR_TTL, AR_MAX_BYTES = 60, 8 * 1024 * 1024
NOT_AIR = re.compile(r"road\s*(surface\s*)?temp|pavement|surface|soil|ground", re.I)   # labels of things that are not air temperature
UA_FORMAT, UA_LEVELS, UA_TTL, UA_MAX_BYTES = "nh48-upperair-v1", (950, 925, 900, 850, 800, 700), 3600, 4 * 1024 * 1024
MT_FORMAT, MT_TTL, MT_MAX_BYTES = "nh48-metar-v1", 300, 2 * 1024 * 1024
MT_STATIONS = {"KHIE": 326.0, "KIZG": 138.0}     # id: fallback elevation in metres
TTL, MIN_REFRESH, WORKERS, TIMEOUT = 3600, 300, 6, 25
LOCK = threading.Lock()


def fetch_one(url, ua):
    """Returns (status, body_or_None, error_or_None). Status 0 means the network failed."""
    req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept": "application/geo+json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.status, r.read().decode("utf-8"), None
    except urllib.error.HTTPError as e:
        return e.code, None, "HTTP %d" % e.code
    except Exception as e:  # network failure, timeout, bad TLS
        return 0, None, str(getattr(e, "reason", e))


def fetch_all(urls, ua, meta, sink, rounds=4):
    """Fetches every URL, retrying transient failures. `sink(event_dict)` is told about each call as it finishes
    (from worker threads; the sink must be thread-safe). `meta[key]` = {phase, label, for}."""
    result, pending = {}, dict(urls)

    def one(k, attempt):
        t0 = time.time()
        r = fetch_one(pending[k], ua)
        m = meta.get(k, {})
        sink({"type": "call", "phase": m.get("phase"), "label": m.get("label"), "for": m.get("for"), "method": "GET",
              "path": urlsplit(pending[k]).path, "status": r[0], "ms": int((time.time() - t0) * 1000),
              "attempt": attempt, "error": r[2]})
        return r

    for rnd in range(rounds):
        if not pending:
            break
        if rnd:
            wait = min(20, 2 ** rnd)
            sink({"type": "wait", "seconds": wait, "count": len(pending)})
            time.sleep(wait)
        with ThreadPoolExecutor(WORKERS) as pool:
            keys = list(pending)
            for k, r in zip(keys, pool.map(lambda k: one(k, rnd + 1), keys)):
                result[k] = r
        pending = {k: urls[k] for k in pending if result[k][0] in RETRY}
    return result


def cell_center(geom):
    """Middle of a grid cell, [lat, lon], from the GeoJSON polygon that comes with a /gridpoints answer."""
    try:
        ring = geom["coordinates"][0][:-1]   # the ring repeats its first point at the end
        if len(ring) < 3:
            return None
        return [round(sum(c[1] for c in ring) / len(ring), 5), round(sum(c[0] for c in ring) / len(ring), 5)]
    except (TypeError, KeyError, IndexError):
        return None


def slim(props, tz, geom=None):
    out = {"elevation": props.get("elevation"), "updateTime": props.get("updateTime"), "timeZone": tz}
    center = cell_center(geom)
    if center:
        out["center"] = center   # lets the dashboard place each grid cell as a station for BCDG
    for k in KEEP:
        s = props.get(k)
        if s and s.get("values"):
            out[k] = {"uom": s.get("uom"), "values": [{"validTime": v["validTime"], "value": v["value"]} for v in s["values"]]}
    return out


def build_bundle(base, ua, sink=lambda e: None):
    with open(os.path.join(ROOT, "peaks.json")) as f:
        peaks = json.load(f)
    bundle = {"format": FORMAT, "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
              "source": base, "grids": {}, "peaks": {}}
    urls, meta = {}, {}
    for p in peaks:
        bundle["peaks"][p["id"]] = {"name": p["name"], "lat": p["lat"], "lon": p["lon"]}
        urls[p["id"]] = "%s/points/%.4f,%.4f" % (base, p["lat"], p["lon"])
        meta[p["id"]] = {"phase": "points", "label": p["name"], "for": None}
    sink({"type": "start", "phase": "points", "total": len(urls)})
    grid_urls, tz = {}, {}
    for pid, (status, body, err) in fetch_all(urls, ua, meta, sink).items():
        try:
            pt = json.loads(body)["properties"] if body else None
            key = "%s/%d,%d" % (pt["gridId"], pt["gridX"], pt["gridY"])
        except (TypeError, KeyError, ValueError):
            bundle["peaks"][pid]["error"] = err or "The points lookup returned no grid cell."
            continue
        bundle["peaks"][pid]["grid"] = key
        tz[key] = pt.get("timeZone") or "America/New_York"
        grid_urls.setdefault(key, pt.get("forecastGridData") or "%s/gridpoints/%s" % (base, key))
    bad = {}
    gmeta = {k: {"phase": "grids", "label": "Grid cell " + k,
                 "for": [bundle["peaks"][pid]["name"] for pid, e in bundle["peaks"].items() if e.get("grid") == k]}
             for k in grid_urls}
    if grid_urls:
        sink({"type": "phase", "phase": "grids", "total": len(grid_urls)})
    for key, (status, body, err) in (fetch_all(grid_urls, ua, gmeta, sink) if grid_urls else {}).items():
        try:
            doc = json.loads(body)
            props = doc["properties"]
            props["temperature"]
        except (TypeError, KeyError, ValueError):
            bad[key] = err or "The grid data had no temperature series."
            continue
        bundle["grids"][key] = slim(props, tz[key], doc.get("geometry"))
    for e in bundle["peaks"].values():
        if e.get("grid") in bad:
            e["error"] = bad[e.pop("grid")]
    return bundle


def autoroad_slim(raw):
    """Keeps only what the dashboard uses from the Auto Road feed: air temperature, good readings, numbers only."""
    stations = []
    for key, st in (raw.items() if isinstance(raw, dict) else []):
        if not isinstance(st, dict) or not isinstance(st.get("metadata"), dict) or not isinstance(st.get("measurements"), list):
            continue
        md = st["metadata"]
        dec = md.get("stationDecommissionDate")
        if dec:
            try:
                if datetime.fromisoformat(str(dec).replace("Z", "+00:00")).timestamp() < time.time():
                    continue
            except ValueError:
                pass
        z = md.get("elevationMasl")
        if not isinstance(z, (int, float)) or isinstance(z, bool):
            continue
        sensors = []
        for m in st["measurements"]:
            # air temperature only: never the road surface, pavement or ground temperature, and only in degrees C (or F, converted)
            if not isinstance(m, dict) or m.get("measurement_key") != "air_temperature" or NOT_AIR.search(str(m.get("measurement_name") or "")):
                continue
            unit = str(m.get("unitSymbol") or "degC").lower()
            if unit not in ("degc", "c", "degf", "f"):
                continue
            for q in m.get("sensors") or []:
                if NOT_AIR.search(str(q.get("instrument_notes") or "")):
                    continue
                t, v = [], []
                for p in q.get("series") or []:
                    try:
                        ts = datetime.fromisoformat(str(p["date"]).replace("Z", "+00:00")).timestamp()
                        val = float(p["value"])
                    except (KeyError, TypeError, ValueError):
                        continue
                    if unit in ("degf", "f"):
                        val = (val - 32) * 5 / 9
                    if int(p.get("qa_flag") or 0) > 0 or not -60 < val < 50:
                        continue
                    t.append(int(ts))
                    v.append(round(val, 2))
                if t:
                    sensors.append({"id": q.get("instrument_id"), "note": str(q.get("instrument_notes") or "")[:60], "t": t, "v": v})
        if sensors:
            stations.append({"id": str(md.get("stationName") or key)[:12], "name": str(md.get("stationLongName") or key)[:40], "z": float(z),
                             "lat": md.get("latitude") if isinstance(md.get("latitude"), (int, float)) else None,
                             "lon": md.get("longitude") if isinstance(md.get("longitude"), (int, float)) else None, "sensors": sensors})
    return stations


def autoroad_fetch(url, ua):
    req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        body = r.read(AR_MAX_BYTES + 1)
    if len(body) > AR_MAX_BYTES:
        raise ValueError("the answer was too large")
    stations = autoroad_slim(json.loads(body.decode("utf-8")))
    if len(stations) < 2:
        raise ValueError("the answer held fewer than two stations with temperature")
    return {"format": AR_FORMAT, "fetched": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": "Mount Washington Auto Road feed", "stations": stations}


def _get_json(url, ua, accept, limit, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept": accept})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read(limit + 1)
    except urllib.error.HTTPError as e:
        why = ""
        try:
            why = ": " + re.sub(r"[^\x20-\x7e]", "", str(json.loads(e.read().decode("utf-8")).get("reason", "")))[:120]
        except Exception:
            pass
        raise ValueError("HTTP %d%s" % (e.code, why))
    if len(body) > limit:
        raise ValueError("the answer was too large")
    return json.loads(body.decode("utf-8"))


def peak_by_id(pid):
    """The summit with this id from peaks.json, or None. Only ids in that list are ever used to build a request."""
    if not isinstance(pid, str) or not re.fullmatch(r"[a-z0-9-]{1,40}", pid):
        return None
    try:
        with open(os.path.join(ROOT, "peaks.json"), encoding="utf-8") as f:
            for p in json.load(f):
                if p.get("id") == pid and isinstance(p.get("lat"), (int, float)) and isinstance(p.get("lon"), (int, float)):
                    return p
    except (OSError, ValueError):
        pass
    return None


def _series(a, n, dec):
    out = []
    for i in range(n):
        v = a[i] if isinstance(a, list) and i < len(a) else None
        out.append(round(float(v), dec) if isinstance(v, (int, float)) and not isinstance(v, bool) else None)
    return out


def upperair_fetch(base, models, peak, ua):
    """Model pressure levels at one summit, slimmed to nh48-upperair-v1."""
    hv = ["pressure_msl"]
    for p in UA_LEVELS:
        hv += ["temperature_%dhPa" % p, "relative_humidity_%dhPa" % p, "geopotential_height_%dhPa" % p]
    q = {"latitude": "%.4f" % peak["lat"], "longitude": "%.4f" % peak["lon"], "hourly": ",".join(hv), "timeformat": "unixtime",
         "timezone": "UTC", "forecast_days": 8, "past_hours": 6}
    if models:
        q["models"] = models
    raw = _get_json(base + ("&" if "?" in base else "?") + urlencode(q), ua, "application/json", UA_MAX_BYTES)
    h = raw.get("hourly") if isinstance(raw, dict) else None
    if not isinstance(h, dict) or not isinstance(h.get("time"), list):
        raise ValueError("the answer had no hourly data")
    if not all(isinstance(t, (int, float)) and not isinstance(t, bool) for t in h["time"]):
        raise ValueError("the answer had a bad time")
    times = [int(t) for t in h["time"]]
    n = len(times)
    if n < 12:
        raise ValueError("the answer held under 12 hours")
    out = {"format": UA_FORMAT, "fetched": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "source": "Open-Meteo model pressure levels" + (" (%s)" % models if models else ""), "peak": peak["id"], "lat": peak["lat"], "lon": peak["lon"],
           "elevation": raw.get("elevation") if isinstance(raw.get("elevation"), (int, float)) else None,
           "levels": list(UA_LEVELS), "times": times, "mslp": _series(h.get("pressure_msl"), n, 1), "t": {}, "z": {}, "rh": {}}
    usable = 0
    for p in UA_LEVELS:
        k = str(p)
        out["t"][k] = _series(h.get("temperature_%dhPa" % p), n, 1)
        out["z"][k] = _series(h.get("geopotential_height_%dhPa" % p), n, 0)
        out["rh"][k] = _series(h.get("relative_humidity_%dhPa" % p), n, 0)
        if sum(v is not None for v in out["t"][k]) >= 12 and sum(v is not None for v in out["z"][k]) >= 12:
            usable += 1
    if usable < 3:
        raise ValueError("the answer held fewer than three pressure levels")
    return out


def _hpa(v):
    if not isinstance(v, dict) or not isinstance(v.get("value"), (int, float)) or isinstance(v.get("value"), bool):
        return None
    if v.get("qualityControl") in ("X", "B"):
        return None
    p = float(v["value"])
    if p > 2000:
        p /= 100.0
    return round(p, 2) if 500 < p < 1200 else None


def metar_fetch(base, ua):
    """Recent pressure observations at the configured airports, slimmed to nh48-metar-v1."""
    stations, errs = [], []
    for sid, zf in MT_STATIONS.items():
        try:
            raw = _get_json("%s/stations/%s/observations?limit=14" % (base.rstrip("/"), sid), ua, "application/geo+json", MT_MAX_BYTES, 15)
            feats = raw.get("features") if isinstance(raw, dict) else None
            if not isinstance(feats, list):
                raise ValueError("the answer had no observations")
            obs, z, name = [], zf, sid
            for f in feats:
                p = f.get("properties") if isinstance(f, dict) else None
                if not isinstance(p, dict) or not p.get("timestamp"):
                    continue
                try:
                    ts = int(datetime.fromisoformat(str(p["timestamp"]).replace("Z", "+00:00")).timestamp())
                except ValueError:
                    continue
                if ts < time.time() - 8 * 3600:
                    continue
                ev = (p.get("elevation") or {}).get("value")
                if isinstance(ev, (int, float)) and not isinstance(ev, bool):
                    z = float(ev)
                if p.get("stationName"):
                    name = str(p["stationName"])[:60]
                tv = (p.get("temperature") or {}).get("value")
                slp, stn = _hpa(p.get("seaLevelPressure")), _hpa(p.get("barometricPressure"))
                if slp is None and stn is None:
                    continue
                obs.append({"t": ts, "temp": round(float(tv), 1) if isinstance(tv, (int, float)) and not isinstance(tv, bool) else None, "slp": slp, "stn": stn})
            obs.sort(key=lambda o: o["t"])
            if obs:
                stations.append({"id": sid, "name": name, "z": z, "obs": obs})
            else:
                errs.append("%s: no pressure readings in the last 8 hours" % sid)
        except Exception as e:
            errs.append("%s: %s" % (sid, getattr(e, "reason", e)))
    if not stations:
        raise ValueError("; ".join(errs) or "no stations")
    return {"format": MT_FORMAT, "fetched": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "source": "NWS station observations", "stations": stations}


class Handler(SimpleHTTPRequestHandler):
    base = "https://api.weather.gov"
    autoroad_url = "https://xmountwashington.appspot.com/proxy.php?endpoint=autoroad"
    upperair_url = "https://api.open-meteo.com/v1/forecast"
    upperair_models = ""
    ua = "NH48SummitDashboard/1.0 (no contact given)"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def send_json(self, code, obj=None, raw=None, cache_state=None):
        body = raw if raw is not None else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        if cache_state:
            self.send_header("X-Cache", cache_state)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_cache(self, state):
        with open(CACHE_FILE, "rb") as f:
            self.send_json(200, raw=f.read(), cache_state=state)

    def do_GET(self):
        parts = urlsplit(self.path)
        path = parts.path
        if path in ("/api/autoroad.php", "/api/autoroad"):
            return self.autoroad()
        if path in ("/api/upperair.php", "/api/upperair"):
            return self.upperair(parse_qs(parts.query).get("peak", [""])[0])
        if path in ("/api/metar.php", "/api/metar"):
            return self.metar()
        if path in ("/api/nws.php", "/api/nws"):
            q = parse_qs(parts.query)
            return self.forecast(q.get("refresh") == ["1"], q.get("stream") == ["1"])
        # keep the PHP sources, the cache and hidden files out of reach
        if path.endswith(".php") or path.startswith("/cache") or path.startswith("/api/") or "/." in path:
            return self.send_error(HTTPStatus.NOT_FOUND)
        return super().do_GET()

    def _cached(self, file, ttl, make, what):
        """Serve the saved copy while it is fresh; else ask again; else the saved copy (stale-error) or a 502."""
        def serve(state):
            with open(file, "rb") as f:
                self.send_json(200, raw=f.read(), cache_state=state)
        age = time.time() - os.path.getmtime(file) if os.path.isfile(file) else float("inf")
        if age < ttl:
            return serve("hit")
        try:
            out = make()
        except Exception as e:  # network failure, bad answer
            sys.stderr.write("  %s: %s\n" % (what, e))
            if os.path.isfile(file):
                return serve("stale-error")
            return self.send_json(502, {"error": "The %s did not answer (%s)." % (what, getattr(e, "reason", e))})
        os.makedirs(os.path.dirname(file), exist_ok=True)
        tmp = file + ".%d.tmp" % os.getpid()
        with open(tmp, "w") as f:
            json.dump(out, f, separators=(",", ":"))
        os.replace(tmp, file)
        return serve("miss")

    def upperair(self, pid):
        peak = peak_by_id(pid)
        if not peak:
            return self.send_json(400, {"error": "Give ?peak= with one of the 48 summit ids."})
        return self._cached(os.path.join(ROOT, "cache", "nh48_upperair_%s.json" % peak["id"]), UA_TTL,
                            lambda: upperair_fetch(self.upperair_url, self.upperair_models, peak, self.ua), "model pressure-level service")

    def metar(self):
        return self._cached(os.path.join(ROOT, "cache", "nh48_metar.json"), MT_TTL, lambda: metar_fetch(self.base, self.ua), "observation service")

    def autoroad(self):
        """The Auto Road stations: the saved copy for a minute, else a fresh request; the saved copy again if the feed is down."""
        def serve(state):
            with open(AR_FILE, "rb") as f:
                self.send_json(200, raw=f.read(), cache_state=state)
        age = time.time() - os.path.getmtime(AR_FILE) if os.path.isfile(AR_FILE) else float("inf")
        if age < AR_TTL:
            return serve("hit")
        try:
            out = autoroad_fetch(self.autoroad_url, self.ua)
        except Exception as e:  # network failure, bad answer
            sys.stderr.write("  Auto Road feed: %s\n" % e)
            if os.path.isfile(AR_FILE):
                return serve("stale-error")
            return self.send_json(502, {"error": "The Auto Road feed did not answer (%s)." % getattr(e, "reason", e)})
        os.makedirs(os.path.dirname(AR_FILE), exist_ok=True)
        tmp = AR_FILE + ".%d.tmp" % os.getpid()
        with open(tmp, "w") as f:
            json.dump(out, f, separators=(",", ":"))
        os.replace(tmp, AR_FILE)
        return serve("miss")

    def forecast(self, refresh, stream=False):
        """Serves the saved copy, or pulls from NWS when it is old. With stream=True and a pull actually needed, the
        response is NDJSON: start/call/wait/phase events as they happen, then one result (or error) line."""
        age = time.time() - os.path.getmtime(CACHE_FILE) if os.path.isfile(CACHE_FILE) else float("inf")
        if age < TTL and not refresh:
            return self.serve_cache("hit")
        if refresh and age < MIN_REFRESH:
            return self.serve_cache("hit-throttled")
        if not LOCK.acquire(blocking=False):
            if os.path.isfile(CACHE_FILE):
                return self.serve_cache("stale")
            LOCK.acquire()   # first ever pull is running: wait for it
            LOCK.release()
            if os.path.isfile(CACHE_FILE):
                return self.serve_cache("hit")
            return self.send_json(502, {"error": "The forecast pull did not finish."})
        try:
            if os.path.isfile(CACHE_FILE) and time.time() - os.path.getmtime(CACHE_FILE) < MIN_REFRESH:
                return self.serve_cache("hit")
            out_lock, alive = threading.Lock(), [True]

            def sink(ev):
                sys.stderr.write("  NWS %s\n" % (
                    "%s %s -> %s (%d ms)%s" % (ev["method"], ev["path"], ev["status"] or "no response", ev["ms"],
                                             " retry %d" % ev["attempt"] if ev["attempt"] > 1 else "")
                    if ev["type"] == "call" else "retry in %ss (%d calls)" % (ev["seconds"], ev["count"])
                    if ev["type"] == "wait" else ev["type"]))
                if not stream:
                    return
                with out_lock:
                    if alive[0]:
                        try:
                            self.wfile.write(json.dumps(ev, separators=(",", ":")).encode() + b"\n")
                            self.wfile.flush()
                        except OSError:   # the browser went away: finish the pull and save it anyway
                            alive[0] = False

            if stream:
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("X-Accel-Buffering", "no")
                self.send_header("X-Cache", "miss-stream")
                self.end_headers()      # HTTP/1.0: the body ends when the connection closes
                self.close_connection = True

            def finish(code, obj=None, state=None, ev=None):
                if stream:
                    sink(ev)
                elif state:
                    self.serve_cache(state)
                else:
                    self.send_json(code, obj)

            bundle = build_bundle(self.base, self.ua, sink)
            ok = [e for e in bundle["peaks"].values() if "grid" in e]
            total = len(bundle["peaks"])
            if not ok:
                if os.path.isfile(CACHE_FILE):
                    with open(CACHE_FILE) as f:
                        old = json.load(f)
                    return finish(200, state="stale-error", ev={"type": "result", "state": "stale-error", "ok": 0,
                                                                 "total": total, "cells": 0, "bundle": old})
                first = next(iter(bundle["peaks"].values()))
                msg = "The NWS service returned no forecasts. First error: %s" % first.get("error", "unknown")
                return finish(502, {"error": msg}, ev={"type": "error", "message": msg})
            os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
            tmp = CACHE_FILE + ".%d.tmp" % os.getpid()
            with open(tmp, "w") as f:
                json.dump(bundle, f, separators=(",", ":"))
            os.replace(tmp, CACHE_FILE)
            return finish(200, state="miss", ev={"type": "result", "state": "miss", "ok": len(ok), "total": total,
                                                  "cells": len(bundle["grids"]), "bundle": bundle})
        finally:
            LOCK.release()


def main():
    ap = argparse.ArgumentParser(description="Serve the NH 48 dashboard and its forecast service with Python only.")
    ap.add_argument("--contact", default=os.environ.get("NH48_CONTACT", ""), help="e-mail or URL for the NWS User-Agent")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8080)
    a = ap.parse_args()
    if not a.contact:
        print("Tip: add --contact you@example.com so NWS can reach you if your traffic causes trouble.")
    Handler.base = os.environ.get("NH48_NWS_BASE", Handler.base).rstrip("/")
    Handler.autoroad_url = os.environ.get("NH48_AUTOROAD_URL", Handler.autoroad_url)
    Handler.upperair_url = os.environ.get("NH48_UPPERAIR_URL", Handler.upperair_url)
    Handler.upperair_models = os.environ.get("NH48_UPPERAIR_MODELS", Handler.upperair_models)
    Handler.ua = "NH48SummitDashboard/1.0 (%s)" % (a.contact or "no contact given")
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print("Serving %s at http://%s:%d/  (Ctrl+C to stop)" % (ROOT, a.host if a.host != "0.0.0.0" else "localhost", a.port))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
