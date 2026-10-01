<?php
// Settings for api/nws.php. Edit the values below.
return [
    // NWS asks every API user to identify themselves. Put an e-mail address or a page URL here.
    'contact'      => 'you@example.com',

    // The forecast service. Leave as is (only tests point this elsewhere).
    'base'         => getenv('NH48_NWS_BASE') ?: 'https://api.weather.gov',

    // The Mount Washington Auto Road temperature stations (read by api/autoroad.php). Leave as is (only tests point this elsewhere).
    'autoroad_url' => getenv('NH48_AUTOROAD_URL') ?: 'https://xmountwashington.appspot.com/proxy.php?endpoint=autoroad',
    // Seconds a saved Auto Road answer is served before the next visitor triggers a new request. The stations report every minute.
    'autoroad_ttl' => 60,

    // Model pressure levels (height and temperature at 950, 925, 900, 850, 800 and 700 hPa, plus sea-level pressure), read by
    // api/upperair.php for the Hypsometric and Levels methods. NWS grids carry no upper-air data, so this comes from Open-Meteo, which
    // serves NOAA's GFS/HRRR (and others) for free for non-commercial use: https://open-meteo.com/en/terms . Leave the address as is (only tests point it elsewhere).
    'upperair_url'    => getenv('NH48_UPPERAIR_URL') ?: 'https://api.open-meteo.com/v1/forecast',
    // Which model to ask for, for example 'gfs_seamless'. Empty lets the service choose the best one for the area.
    'upperair_models' => getenv('NH48_UPPERAIR_MODELS') ?: '',
    'upperair_ttl'    => 3600,

    // Observed surface pressure (api/metar.php): NWS station observations from the two airports nearest the Presidentials, with each
    // one's elevation in metres (used only if the observation does not carry its own).
    'metar_stations' => ['KHIE' => 326, 'KIZG' => 138],
    'metar_ttl'      => 300,

    // How long a saved pull is served before the next visitor triggers a new one, in seconds.
    'ttl'          => 3600,

    // A visitor's "Refresh" is ignored when the saved pull is newer than this, in seconds.
    'min_refresh'  => 300,

    // Where the saved pull is kept. Must be writable by the web server.
    'cache_dir'    => __DIR__ . '/../cache',

    // Requests in flight at once, and per-request timeout in seconds.
    'concurrency'  => 6,
    'timeout'      => 25,
];
