<?php
/*
 * Observed surface pressure service.
 *
 * Reads the last hours of NWS observations from the airports named in config.php (Mt Washington Regional KHIE and Eastern Slopes
 * Regional KIZG), keeps the answer for `metar_ttl` seconds, and serves a slim copy. The dashboard uses the sea-level pressure and its
 * tendency for the weather regime, and checks the model's pressure against it.
 *
 *   GET api/metar.php
 *
 * Output format "nh48-metar-v1": { format, fetched, source, stations: [ { id, name, z, obs: [ { t: epoch s, temp: degC, slp: hPa, stn: hPa } ] } ] }
 * (slp is the sea-level pressure the station reports, stn the pressure at the station; either may be null.)
 * If the service cannot be reached the last saved copy is served (X-Cache: stale-error); the dashboard ignores readings older than 3 hours.
 *
 * The outgoing addresses are built from config.php only. No user input reaches them.
 */

$cfg = require __DIR__ . '/config.php';
const MT_FORMAT = 'nh48-metar-v1';
const MT_MAX_BYTES = 2 * 1024 * 1024;

function mt_fail(int $code, string $msg): void {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(['error' => $msg]);
    exit;
}

function mt_serve(string $file, string $state): void {
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-cache');
    header('X-Cache: ' . $state);
    readfile($file);
    exit;
}

/** hPa from a value the API gives in Pa (or, defensively, already in hPa). */
function mt_hpa($v): ?float {
    if (!is_array($v) || !isset($v['value']) || !is_numeric($v['value'])) return null;
    if (in_array($v['qualityControl'] ?? '', ['X', 'B'], true)) return null;   // rejected or bad by the NWS quality control
    $p = (float)$v['value'];
    if ($p > 2000) $p /= 100;
    return $p > 500 && $p < 1200 ? round($p, 2) : null;
}

function mt_station(array $cfg, string $id, float $zFallback): array {
    $url = rtrim($cfg['base'], '/') . '/stations/' . rawurlencode($id) . '/observations?limit=14';
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 3, CURLOPT_TIMEOUT => 15, CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_ENCODING => '', CURLOPT_USERAGENT => 'NH48SummitDashboard/1.0 (' . $cfg['contact'] . ')', CURLOPT_HTTPHEADER => ['Accept: application/geo+json'],
        CURLOPT_NOPROGRESS => false,
        CURLOPT_PROGRESSFUNCTION => function ($ch, $dlTotal, $dlNow) { return $dlNow > MT_MAX_BYTES ? 1 : 0; },
    ]);
    $body = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $err = curl_errno($ch) ? curl_error($ch) : null;
    curl_close($ch);
    if ($err) throw new RuntimeException($id . ': ' . $err);
    if ($status < 200 || $status >= 300) throw new RuntimeException($id . ': HTTP ' . $status);
    $raw = json_decode((string)$body, true);
    if (!is_array($raw) || !isset($raw['features']) || !is_array($raw['features'])) throw new RuntimeException($id . ': the answer had no observations');
    $obs = [];
    $z = $zFallback;
    $name = $id;
    foreach ($raw['features'] as $f) {
        $p = $f['properties'] ?? null;
        if (!is_array($p)) continue;
        $ts = isset($p['timestamp']) ? strtotime((string)$p['timestamp']) : false;
        if ($ts === false || $ts < time() - 8 * 3600) continue;
        if (isset($p['elevation']['value']) && is_numeric($p['elevation']['value'])) $z = (float)$p['elevation']['value'];
        if (!empty($p['stationName'])) $name = mb_substr((string)$p['stationName'], 0, 60);
        $t = isset($p['temperature']['value']) && is_numeric($p['temperature']['value']) ? round((float)$p['temperature']['value'], 1) : null;
        $slp = mt_hpa($p['seaLevelPressure'] ?? null);
        $stn = mt_hpa($p['barometricPressure'] ?? null);
        if ($slp === null && $stn === null) continue;
        $obs[] = ['t' => $ts, 'temp' => $t, 'slp' => $slp, 'stn' => $stn];
    }
    usort($obs, function ($a, $b) { return $a['t'] <=> $b['t']; });
    return ['id' => $id, 'name' => $name, 'z' => $z, 'obs' => $obs];
}

function mt_fetch(array $cfg): array {
    $stations = [];
    $errs = [];
    foreach ($cfg['metar_stations'] as $id => $z) {
        try {
            $s = mt_station($cfg, (string)$id, (float)$z);
            if ($s['obs']) $stations[] = $s; else $errs[] = $id . ': no pressure readings in the last 8 hours';
        } catch (Throwable $e) { $errs[] = $e->getMessage(); }
    }
    if (!$stations) throw new RuntimeException(implode('; ', $errs) ?: 'no stations');
    return ['format' => MT_FORMAT, 'fetched' => gmdate('c'), 'source' => 'NWS station observations', 'stations' => $stations];
}

try {
    if (!function_exists('curl_init')) mt_fail(500, 'The PHP curl extension is not installed.');
    $dir = $cfg['cache_dir'];
    if (!is_dir($dir) && !@mkdir($dir, 0775, true)) mt_fail(500, 'The cache directory does not exist and cannot be created.');
    if (!is_writable($dir)) mt_fail(500, 'The cache directory is not writable by the web server.');
    $file = $dir . '/nh48_metar.json';
    $age = is_file($file) ? time() - filemtime($file) : PHP_INT_MAX;
    if ($age < $cfg['metar_ttl']) mt_serve($file, 'hit');
    try {
        $out = mt_fetch($cfg);
    } catch (Throwable $e) {
        if (is_file($file)) mt_serve($file, 'stale-error');
        mt_fail(502, 'The observation service did not answer (' . $e->getMessage() . ').');
    }
    $tmp = $file . '.' . getmypid() . '.tmp';
    if (file_put_contents($tmp, json_encode($out, JSON_UNESCAPED_SLASHES)) === false) mt_fail(500, 'Cannot write to the cache directory.');
    rename($tmp, $file);
    mt_serve($file, 'miss');
} catch (Throwable $e) {
    mt_fail(500, 'Observation service error: ' . $e->getMessage());
}
