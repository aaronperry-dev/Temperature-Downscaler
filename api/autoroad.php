<?php
/*
 * Mount Washington Auto Road service.
 *
 * Reads the temperature stations along the Mount Washington Auto Road and on the summit tower from the public feed, keeps the last answer in the cache directory for `autoroad_ttl` seconds, and serves a slim copy to the
 * dashboard, which uses it as a "live look" at the temperature profile up the mountain.
 *
 *   GET api/autoroad.php      the saved copy if it is fresh, otherwise asks the feed again
 *
 * Output format "nh48-autoroad-v1": { format, fetched, source, stations: [ { id, name, z, lat, lon,
 *                                     sensors: [ { id, note, t: [epoch seconds], v: [degC] } ] } ] }
 * If the feed cannot be reached the last saved copy is served (X-Cache: stale-error); the dashboard judges its age
 * from the readings themselves and stops using anything older than 45 minutes.
 *
 * The outgoing address is fixed in config.php. No user input reaches it.
 */

$cfg = require __DIR__ . '/config.php';
const AR_FORMAT = 'nh48-autoroad-v1';
const AR_MAX_BYTES = 8 * 1024 * 1024;
const AR_NOT_AIR = '/road\s*(surface\s*)?temp|pavement|surface|soil|ground/i';   // labels of things that are not air temperature

function ar_fail(int $code, string $msg): void {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(['error' => $msg]);
    exit;
}

function ar_serve(string $file, string $state): void {
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-cache');
    header('X-Cache: ' . $state);
    readfile($file);
    exit;
}

/** Keep only what the dashboard uses: air temperature, good readings, numbers only. */
function ar_slim(array $raw): array {
    $stations = [];
    foreach ($raw as $key => $st) {
        if (!is_array($st) || !isset($st['metadata'], $st['measurements']) || !is_array($st['measurements'])) continue;
        $md = $st['metadata'];
        if (!empty($md['stationDecommissionDate']) && strtotime((string)$md['stationDecommissionDate']) < time()) continue;
        $z = $md['elevationMasl'] ?? null;
        if (!is_numeric($z)) continue;
        $sensors = [];
        foreach ($st['measurements'] as $m) {
            // air temperature only: never the road surface, pavement or ground temperature, and only in degrees C (or F, converted)
            if (($m['measurement_key'] ?? '') !== 'air_temperature' || preg_match(AR_NOT_AIR, (string)($m['measurement_name'] ?? ''))) continue;
            $unit = strtolower((string)($m['unitSymbol'] ?? 'degC'));
            if (in_array($unit, ['degc', 'c'], true)) $toC = 0;
            elseif (in_array($unit, ['degf', 'f'], true)) $toC = 1;
            else continue;
            foreach (($m['sensors'] ?? []) as $q) {
                if (preg_match(AR_NOT_AIR, (string)($q['instrument_notes'] ?? ''))) continue;
                $t = [];
                $v = [];
                foreach (($q['series'] ?? []) as $p) {
                    $ts = isset($p['date']) ? strtotime((string)$p['date']) : false;
                    $val = $p['value'] ?? null;
                    if ($ts === false || !is_numeric($val) || (int)($p['qa_flag'] ?? 0) > 0) continue;
                    $val = $toC ? ((float)$val - 32) * 5 / 9 : (float)$val;
                    if ($val <= -60 || $val >= 50) continue;
                    $t[] = $ts;
                    $v[] = round($val, 2);
                }
                if ($t) $sensors[] = ['id' => $q['instrument_id'] ?? null, 'note' => mb_substr((string)($q['instrument_notes'] ?? ''), 0, 60), 't' => $t, 'v' => $v];
            }
        }
        if (!$sensors) continue;
        $stations[] = ['id' => mb_substr((string)($md['stationName'] ?? $key), 0, 12), 'name' => mb_substr((string)($md['stationLongName'] ?? $key), 0, 40),
            'z' => (float)$z, 'lat' => isset($md['latitude']) ? (float)$md['latitude'] : null, 'lon' => isset($md['longitude']) ? (float)$md['longitude'] : null,
            'sensors' => $sensors];
    }
    return $stations;
}

function ar_fetch(array $cfg): array {
    $ch = curl_init($cfg['autoroad_url']);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 3, CURLOPT_TIMEOUT => 15, CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_ENCODING => '', CURLOPT_USERAGENT => 'NH48SummitDashboard/1.0 (' . $cfg['contact'] . ')', CURLOPT_HTTPHEADER => ['Accept: application/json'],
        CURLOPT_NOPROGRESS => false,
        CURLOPT_PROGRESSFUNCTION => function ($ch, $dlTotal, $dlNow) { return $dlNow > AR_MAX_BYTES ? 1 : 0; },   // stop an oversized answer
    ]);
    $body = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $err = curl_errno($ch) ? curl_error($ch) : null;
    curl_close($ch);
    if ($err) throw new RuntimeException($err);
    if ($status < 200 || $status >= 300) throw new RuntimeException('HTTP ' . $status);
    $raw = json_decode((string)$body, true);
    if (!is_array($raw)) throw new RuntimeException('the answer was not JSON');
    $stations = ar_slim($raw);
    if (count($stations) < 2) throw new RuntimeException('the answer held fewer than two stations with temperature');
    return ['format' => AR_FORMAT, 'fetched' => gmdate('c'), 'source' => 'Mount Washington Auto Road feed', 'stations' => $stations];
}

try {
    if (!function_exists('curl_init')) ar_fail(500, 'The PHP curl extension is not installed.');
    $dir = $cfg['cache_dir'];
    if (!is_dir($dir) && !@mkdir($dir, 0775, true)) ar_fail(500, 'The cache directory does not exist and cannot be created.');
    if (!is_writable($dir)) ar_fail(500, 'The cache directory is not writable by the web server.');
    $file = $dir . '/nh48_autoroad.json';
    $age = is_file($file) ? time() - filemtime($file) : PHP_INT_MAX;
    if ($age < $cfg['autoroad_ttl']) ar_serve($file, 'hit');
    try {
        $out = ar_fetch($cfg);
    } catch (Throwable $e) {
        if (is_file($file)) ar_serve($file, 'stale-error');
        ar_fail(502, 'The Auto Road feed did not answer (' . $e->getMessage() . ').');
    }
    $tmp = $file . '.' . getmypid() . '.tmp';
    if (file_put_contents($tmp, json_encode($out, JSON_UNESCAPED_SLASHES)) === false) ar_fail(500, 'Cannot write to the cache directory.');
    rename($tmp, $file);
    ar_serve($file, 'miss');
} catch (Throwable $e) {
    ar_fail(500, 'Auto Road service error: ' . $e->getMessage());
}
