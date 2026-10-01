<?php
/*
 * NH 48 forecast service.
 *
 * Pulls the NWS gridded forecast (api.weather.gov) for the 48 New Hampshire 4,000-footers listed in ../peaks.json,
 * keeps one JSON file in the cache directory, and serves it to the dashboard.
 *
 *   GET  api/nws.php            saved pull if it is fresh, otherwise pulls again first
 *   GET  api/nws.php?refresh=1  pulls again unless the saved pull is newer than min_refresh
 *   GET  api/nws.php?stream=1   as above, but when a pull is needed the answer arrives as newline-delimited JSON:
 *                               one {"type":"call",...} line per API call as it finishes, then {"type":"result","bundle":{...}}.
 *                               When no pull is needed it is the plain bundle, exactly as without stream=1.
 *   php  api/nws.php            (command line, e.g. from cron) pulls again, printing each API call, and a summary
 *
 * Output format "nh48-nws-v1": { format, generated, source, grids: { "GYX/12,34": {...gridpoint series, center: [lat, lon]...} },
 *                                peaks: { id: { name, lat, lon, grid | error } } }
 *
 * Needs PHP 7.4 or later with the curl extension. No user input reaches an outgoing URL.
 */

$cfg = require __DIR__ . '/config.php';
$cli = (PHP_SAPI === 'cli');

const FORMAT = 'nh48-nws-v1';
const KEEP = ['temperature', 'dewpoint', 'relativeHumidity', 'windSpeed', 'windGust', 'windDirection',
    'skyCover', 'quantitativePrecipitationAmount', 'snowfallAmount', 'probabilityOfPrecipitation'];
const RETRY_STATUS = [0, 429, 500, 502, 503, 504];

function fail(int $code, string $msg): void {
    global $cli, $streaming;
    if ($cli) { fwrite(STDERR, $msg . "\n"); exit(1); }
    if (!empty($streaming)) { echo json_encode(['type' => 'error', 'message' => $msg]) . "\n"; flush(); exit; }
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(['error' => $msg]);
    exit;
}

/**
 * Fetch many URLs in parallel. Returns [key => ['status' => int, 'body' => string|null, 'error' => string|null]].
 * Failed requests (network error, 429, 5xx) are retried in up to $rounds passes with a growing pause.
 */
function fetch_all(array $urls, array $cfg, array $meta, callable $sink, int $rounds = 4): array {
    $result = [];
    $pending = $urls;
    for ($round = 0; $round < $rounds && $pending; $round++) {
        if ($round > 0) {
            $secs = min(20, 2 ** $round);
            $sink(['type' => 'wait', 'seconds' => $secs, 'count' => count($pending)]);
            sleep($secs);
        }
        $onDone = function ($key, $status, $err, $ms) use ($meta, $sink, $round, $urls) {
            $m = $meta[$key];
            $sink(['type' => 'call', 'phase' => $m['phase'], 'label' => $m['label'], 'for' => $m['for'] ?? null, 'method' => 'GET',
                'path' => parse_url($urls[$key], PHP_URL_PATH), 'status' => $status, 'ms' => $ms, 'attempt' => $round + 1, 'error' => $err]);
        };
        $batch = fetch_round($pending, $cfg, $onDone);
        $pending = [];
        foreach ($batch as $key => $r) {
            $result[$key] = $r;
            if (in_array($r['status'], RETRY_STATUS, true)) $pending[$key] = $urls[$key];
        }
    }
    return $result;
}

function fetch_round(array $urls, array $cfg, callable $onDone): array {
    $ua = 'NH48SummitDashboard/1.0 (' . $cfg['contact'] . ')';
    $mh = curl_multi_init();
    $out = [];
    $queue = $urls;
    $active = [];
    $start = function () use (&$queue, &$active, $mh, $cfg, $ua) {
        while ($queue && count($active) < $cfg['concurrency']) {
            $key = array_key_first($queue);
            $url = $queue[$key];
            unset($queue[$key]);
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_MAXREDIRS => 3,
                CURLOPT_TIMEOUT => $cfg['timeout'],
                CURLOPT_CONNECTTIMEOUT => 10,
                CURLOPT_ENCODING => '',
                CURLOPT_USERAGENT => $ua,
                CURLOPT_HTTPHEADER => ['Accept: application/geo+json'],
            ]);
            curl_multi_add_handle($mh, $ch);
            $active[spl_object_id($ch)] = [$ch, $key];
        }
    };
    $start();
    while ($active) {
        curl_multi_exec($mh, $running);
        if (curl_multi_select($mh, 1.0) === -1) usleep(50000);
        while ($info = curl_multi_info_read($mh)) {
            $ch = $info['handle'];
            [, $key] = $active[spl_object_id($ch)];
            $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            $body = curl_multi_getcontent($ch);
            $err = $info['result'] !== CURLE_OK ? curl_error($ch) : null;
            $out[$key] = ['status' => $err ? 0 : $status, 'body' => ($status >= 200 && $status < 300 && !$err) ? $body : null,
                'error' => $err ?: ($status >= 200 && $status < 300 ? null : 'HTTP ' . $status)];
            $onDone($key, $out[$key]['status'], $out[$key]['error'], (int)round(curl_getinfo($ch, CURLINFO_TOTAL_TIME) * 1000));
            curl_multi_remove_handle($mh, $ch);
            curl_close($ch);
            unset($active[spl_object_id($ch)]);
            $start();
        }
    }
    curl_multi_close($mh);
    return $out;
}

/** Middle of a grid cell, [lat, lon], from the GeoJSON polygon that comes with a /gridpoints answer. */
function cell_center(?array $geom): ?array {
    $ring = $geom['coordinates'][0] ?? null;
    if (!is_array($ring) || count($ring) < 4) return null;
    array_pop($ring);   // the ring repeats its first point at the end
    $lat = 0.0;
    $lon = 0.0;
    foreach ($ring as $c) {
        if (!is_array($c) || !isset($c[0], $c[1])) return null;
        $lon += $c[0];
        $lat += $c[1];
    }
    $n = count($ring);
    return [round($lat / $n, 5), round($lon / $n, 5)];
}

function slim(array $props, string $tz, ?array $geom = null): array {
    $out = ['elevation' => $props['elevation'] ?? null, 'updateTime' => $props['updateTime'] ?? null, 'timeZone' => $tz];
    $center = cell_center($geom);
    if ($center) $out['center'] = $center;   // lets the dashboard place each grid cell as a station for BCDG
    foreach (KEEP as $k) {
        if (!empty($props[$k]['values'])) {
            $vals = [];
            foreach ($props[$k]['values'] as $v) $vals[] = ['validTime' => $v['validTime'], 'value' => $v['value']];
            $out[$k] = ['uom' => $props[$k]['uom'] ?? null, 'values' => $vals];
        }
    }
    return $out;
}

function build_bundle(array $cfg, callable $sink): array {
    $peaks = json_decode((string)file_get_contents(__DIR__ . '/../peaks.json'), true);
    if (!is_array($peaks) || !$peaks) throw new RuntimeException('peaks.json is missing or empty.');
    $base = rtrim($cfg['base'], '/');
    $bundle = ['format' => FORMAT, 'generated' => gmdate('Y-m-d\TH:i:s\Z'), 'source' => $base, 'grids' => [], 'peaks' => []];

    // 1. which forecast-office grid cell holds each summit
    $urls = [];
    $meta = [];
    foreach ($peaks as $p) {
        $bundle['peaks'][$p['id']] = ['name' => $p['name'], 'lat' => $p['lat'], 'lon' => $p['lon']];
        $urls[$p['id']] = sprintf('%s/points/%.4f,%.4f', $base, $p['lat'], $p['lon']);
        $meta[$p['id']] = ['phase' => 'points', 'label' => $p['name']];
    }
    $sink(['type' => 'start', 'phase' => 'points', 'total' => count($urls)]);
    $points = fetch_all($urls, $cfg, $meta, $sink);
    $gridUrls = [];
    $tz = [];
    foreach ($points as $id => $r) {
        $j = $r['body'] !== null ? json_decode($r['body'], true) : null;
        $pt = $j['properties'] ?? null;
        if (!$pt || !isset($pt['gridId'], $pt['gridX'], $pt['gridY'])) {
            $bundle['peaks'][$id]['error'] = $r['error'] ?: 'The points lookup returned no grid cell.';
            continue;
        }
        $key = $pt['gridId'] . '/' . $pt['gridX'] . ',' . $pt['gridY'];
        $bundle['peaks'][$id]['grid'] = $key;
        $tz[$key] = $pt['timeZone'] ?? 'America/New_York';
        if (!isset($gridUrls[$key])) $gridUrls[$key] = $pt['forecastGridData'] ?? ($base . '/gridpoints/' . $key);
    }

    // 2. each distinct cell once
    $gridMeta = [];
    foreach ($gridUrls as $key => $_) {
        $names = [];
        foreach ($bundle['peaks'] as $e) if (($e['grid'] ?? null) === $key) $names[] = $e['name'];
        $gridMeta[$key] = ['phase' => 'grids', 'label' => 'Grid cell ' . $key, 'for' => $names];
    }
    $sink(['type' => 'phase', 'phase' => 'grids', 'total' => count($gridUrls)]);
    $grids = $gridUrls ? fetch_all($gridUrls, $cfg, $gridMeta, $sink) : [];
    $badCell = [];
    foreach ($grids as $key => $r) {
        $j = $r['body'] !== null ? json_decode($r['body'], true) : null;
        if (!isset($j['properties']['temperature'])) { $badCell[$key] = $r['error'] ?: 'The grid data had no temperature series.'; continue; }
        $bundle['grids'][$key] = slim($j['properties'], $tz[$key], $j['geometry'] ?? null);
    }
    foreach ($bundle['peaks'] as $id => &$e) {
        if (isset($e['grid']) && isset($badCell[$e['grid']])) { $e['error'] = $badCell[$e['grid']]; unset($e['grid']); }
    }
    unset($e);
    return $bundle;
}

function count_ok(array $bundle): int {
    $n = 0;
    foreach ($bundle['peaks'] as $e) if (isset($e['grid'])) $n++;
    return $n;
}

function write_atomic(string $path, string $data): void {
    $tmp = $path . '.' . getmypid() . '.tmp';
    if (file_put_contents($tmp, $data) === false) throw new RuntimeException('Cannot write to the cache directory.');
    rename($tmp, $path);
}

function serve(string $file, string $state): void {
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-cache');
    header('X-Cache: ' . $state);
    header('Last-Modified: ' . gmdate('D, d M Y H:i:s', (int)filemtime($file)) . ' GMT');
    readfile($file);
    exit;
}

$streaming = false;
try {
    if (!function_exists('curl_init')) fail(500, 'The PHP curl extension is not installed.');
    $dir = $cfg['cache_dir'];
    if (!is_dir($dir) && !@mkdir($dir, 0775, true)) fail(500, 'The cache directory does not exist and cannot be created.');
    if (!is_writable($dir)) fail(500, 'The cache directory is not writable by the web server.');
    $file = $dir . '/nh48_nws.json';
    $age = is_file($file) ? time() - filemtime($file) : PHP_INT_MAX;
    $refresh = !$cli && isset($_GET['refresh']) && $_GET['refresh'] === '1';
    $wantStream = !$cli && isset($_GET['stream']) && $_GET['stream'] === '1';

    if (!$cli) {
        if ($age < $cfg['ttl'] && !$refresh) serve($file, 'hit');
        if ($refresh && $age < $cfg['min_refresh']) serve($file, 'hit-throttled');
    }

    $lock = fopen($dir . '/build.lock', 'c');
    if (!$lock) fail(500, 'Cannot open the lock file.');
    if (!flock($lock, LOCK_EX | LOCK_NB)) {
        // someone else is pulling right now: give them the old copy, or wait for the new one
        if (is_file($file) && !$cli) serve($file, 'stale');
        flock($lock, LOCK_EX);
        clearstatcache();
        if (is_file($file)) { if ($cli) { echo "Another pull just finished.\n"; exit(0); } serve($file, 'hit'); }
    } else {
        clearstatcache();
        $age = is_file($file) ? time() - filemtime($file) : PHP_INT_MAX;
        if (!$cli && $age < $cfg['min_refresh']) serve($file, 'hit');   // finished while we waited on the lock
    }

    @set_time_limit(180);
    ignore_user_abort(true);   // finish the pull and save it even if the visitor closes the page
    if ($wantStream) {
        $streaming = true;
        @ini_set('zlib.output_compression', '0');
        @ini_set('implicit_flush', '1');
        if (function_exists('apache_setenv')) @apache_setenv('no-gzip', '1');
        while (ob_get_level() > 0) @ob_end_flush();
        header('Content-Type: application/x-ndjson; charset=utf-8');
        header('Cache-Control: no-cache');
        header('X-Accel-Buffering: no');
        header('X-Cache: miss-stream');
    }
    $n = 0;
    $sink = function (array $ev) use ($cli, $streaming, &$n) {
        if ($streaming) { echo json_encode($ev, JSON_UNESCAPED_SLASHES) . "\n"; @ob_flush(); flush(); }
        if ($cli) {
            if ($ev['type'] === 'call') {
                printf("%3d  %-6s %-32s GET %s  %s  %d ms%s\n", ++$n, $ev['phase'], mb_strimwidth((string)$ev['label'], 0, 32, '…'), $ev['path'],
                    $ev['status'] ?: 'ERR', $ev['ms'], $ev['attempt'] > 1 ? '  (attempt ' . $ev['attempt'] . ')' : '');
            } elseif ($ev['type'] === 'wait') {
                printf("     waiting %d s before retrying %d request(s)\n", $ev['seconds'], $ev['count']);
            }
        }
    };
    $bundle = build_bundle($cfg, $sink);
    $ok = count_ok($bundle);
    if ($ok === 0) {
        if (is_file($file) && !$cli) {
            if ($streaming) { $sink(['type' => 'result', 'state' => 'stale-error', 'bundle' => json_decode((string)file_get_contents($file), true)]); exit; }
            serve($file, 'stale-error');
        }
        $first = reset($bundle['peaks']);
        fail(502, 'The NWS service returned no forecasts. First error: ' . ($first['error'] ?? 'unknown'));
    }
    write_atomic($file, json_encode($bundle, JSON_UNESCAPED_SLASHES));
    if ($cli) {
        printf("Wrote %s: %d of %d summits, %d grid cells.\n", $file, $ok, count($bundle['peaks']), count($bundle['grids']));
        exit(0);
    }
    if ($streaming) { $sink(['type' => 'result', 'state' => 'miss', 'ok' => $ok, 'total' => count($bundle['peaks']), 'cells' => count($bundle['grids']), 'bundle' => $bundle]); exit; }
    serve($file, 'miss');
} catch (Throwable $e) {
    fail(500, 'Forecast service error: ' . $e->getMessage());
}
