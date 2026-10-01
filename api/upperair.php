<?php
/*
 * Model pressure-level service.
 *
 * The NWS grids carry no upper-air data. The Hypsometric and Levels methods need the height and temperature of the model's
 * pressure surfaces (950, 925, 900, 850, 800 and 700 hPa), and the model's sea-level pressure. This asks Open-Meteo for them at
 * one summit, keeps the answer for `upperair_ttl` seconds, and serves a slim copy.
 *
 *   GET api/upperair.php?peak=mount-washington
 *
 * Output format "nh48-upperair-v1": { format, fetched, source, peak, lat, lon, elevation, levels:[hPa],
 *     times:[epoch s], mslp:[hPa], t:{"850":[degC]}, z:{"850":[m]}, rh:{"850":[%]} }
 * If the service cannot be reached the last saved copy is served (X-Cache: stale-error).
 *
 * The outgoing address is fixed in config.php. The only thing a visitor supplies is a summit id, and it is looked up in
 * peaks.json: an id that is not in that list is refused, so no user input reaches the outgoing request and at most 48 files are ever cached.
 */

$cfg = require __DIR__ . '/config.php';
const UA_FORMAT = 'nh48-upperair-v1';
const UA_LEVELS = [950, 925, 900, 850, 800, 700];
const UA_MAX_BYTES = 4 * 1024 * 1024;

function ua_fail(int $code, string $msg): void {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(['error' => $msg]);
    exit;
}

function ua_serve(string $file, string $state): void {
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-cache');
    header('X-Cache: ' . $state);
    readfile($file);
    exit;
}

/** The summit with this id from peaks.json, or null. */
function ua_peak(string $id): ?array {
    if (!preg_match('/^[a-z0-9-]{1,40}$/', $id)) return null;
    $list = json_decode((string)@file_get_contents(__DIR__ . '/../peaks.json'), true);
    foreach (is_array($list) ? $list : [] as $p) {
        if (($p['id'] ?? null) === $id && is_numeric($p['lat'] ?? null) && is_numeric($p['lon'] ?? null)) return ['id' => $id, 'lat' => (float)$p['lat'], 'lon' => (float)$p['lon']];
    }
    return null;
}

function ua_series($a, int $n, int $dec): array {
    $out = [];
    for ($i = 0; $i < $n; $i++) {
        $v = is_array($a) && isset($a[$i]) && is_numeric($a[$i]) ? round((float)$a[$i], $dec) : null;
        $out[] = $v;
    }
    return $out;
}

function ua_fetch(array $cfg, array $peak): array {
    $vars = ['pressure_msl'];
    foreach (UA_LEVELS as $p) { $vars[] = "temperature_{$p}hPa"; $vars[] = "relative_humidity_{$p}hPa"; $vars[] = "geopotential_height_{$p}hPa"; }
    $q = ['latitude' => sprintf('%.4f', $peak['lat']), 'longitude' => sprintf('%.4f', $peak['lon']), 'hourly' => implode(',', $vars),
        'timeformat' => 'unixtime', 'timezone' => 'UTC', 'forecast_days' => 8, 'past_hours' => 6];
    if ($cfg['upperair_models'] !== '') $q['models'] = $cfg['upperair_models'];
    $url = $cfg['upperair_url'] . (strpos($cfg['upperair_url'], '?') === false ? '?' : '&') . http_build_query($q);
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 3, CURLOPT_TIMEOUT => 20, CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_ENCODING => '', CURLOPT_USERAGENT => 'NH48SummitDashboard/1.0 (' . $cfg['contact'] . ')', CURLOPT_HTTPHEADER => ['Accept: application/json'],
        CURLOPT_NOPROGRESS => false,
        CURLOPT_PROGRESSFUNCTION => function ($ch, $dlTotal, $dlNow) { return $dlNow > UA_MAX_BYTES ? 1 : 0; },
    ]);
    $body = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $err = curl_errno($ch) ? curl_error($ch) : null;
    curl_close($ch);
    if ($err) throw new RuntimeException($err);
    $raw = json_decode((string)$body, true);
    if ($status < 200 || $status >= 300) {
        $why = is_array($raw) && isset($raw['reason']) ? ': ' . mb_substr(preg_replace('/[^\x20-\x7e]/', '', (string)$raw['reason']), 0, 120) : '';
        throw new RuntimeException('HTTP ' . $status . $why);
    }
    if (!is_array($raw) || !isset($raw['hourly']['time']) || !is_array($raw['hourly']['time'])) throw new RuntimeException('the answer had no hourly data');
    $h = $raw['hourly'];
    $times = [];
    foreach ($h['time'] as $t) { if (!is_numeric($t)) throw new RuntimeException('the answer had a bad time'); $times[] = (int)$t; }
    $n = count($times);
    if ($n < 12) throw new RuntimeException('the answer held under 12 hours');
    $out = ['format' => UA_FORMAT, 'fetched' => gmdate('c'), 'source' => 'Open-Meteo model pressure levels' . ($cfg['upperair_models'] !== '' ? ' (' . $cfg['upperair_models'] . ')' : ''),
        'peak' => $peak['id'], 'lat' => $peak['lat'], 'lon' => $peak['lon'],
        'elevation' => isset($raw['elevation']) && is_numeric($raw['elevation']) ? (float)$raw['elevation'] : null,
        'levels' => UA_LEVELS, 'times' => $times, 'mslp' => ua_series($h['pressure_msl'] ?? null, $n, 1), 't' => [], 'z' => [], 'rh' => []];
    $usable = 0;
    foreach (UA_LEVELS as $p) {
        $k = (string)$p;
        $out['t'][$k] = ua_series($h["temperature_{$p}hPa"] ?? null, $n, 1);
        $out['z'][$k] = ua_series($h["geopotential_height_{$p}hPa"] ?? null, $n, 0);
        $out['rh'][$k] = ua_series($h["relative_humidity_{$p}hPa"] ?? null, $n, 0);
        if (count(array_filter($out['t'][$k], 'is_numeric')) >= 12 && count(array_filter($out['z'][$k], 'is_numeric')) >= 12) $usable++;
    }
    if ($usable < 3) throw new RuntimeException('the answer held fewer than three pressure levels');
    return $out;
}

try {
    if (!function_exists('curl_init')) ua_fail(500, 'The PHP curl extension is not installed.');
    $peak = ua_peak((string)($_GET['peak'] ?? ''));
    if (!$peak) ua_fail(400, 'Give ?peak= with one of the 48 summit ids.');
    $dir = $cfg['cache_dir'];
    if (!is_dir($dir) && !@mkdir($dir, 0775, true)) ua_fail(500, 'The cache directory does not exist and cannot be created.');
    if (!is_writable($dir)) ua_fail(500, 'The cache directory is not writable by the web server.');
    $file = $dir . '/nh48_upperair_' . $peak['id'] . '.json';
    $age = is_file($file) ? time() - filemtime($file) : PHP_INT_MAX;
    if ($age < $cfg['upperair_ttl']) ua_serve($file, 'hit');
    try {
        $out = ua_fetch($cfg, $peak);
    } catch (Throwable $e) {
        if (is_file($file)) ua_serve($file, 'stale-error');
        ua_fail(502, 'The model pressure-level service did not answer (' . $e->getMessage() . ').');
    }
    $tmp = $file . '.' . getmypid() . '.tmp';
    if (file_put_contents($tmp, json_encode($out, JSON_UNESCAPED_SLASHES)) === false) ua_fail(500, 'Cannot write to the cache directory.');
    rename($tmp, $file);
    ua_serve($file, 'miss');
} catch (Throwable $e) {
    ua_fail(500, 'Pressure-level service error: ' . $e->getMessage());
}
