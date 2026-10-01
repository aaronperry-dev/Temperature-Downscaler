# NH 48 Summit Forecasts

A dashboard that takes the NWS gridded forecast (api.weather.gov) for each of the 48 New Hampshire
4,000-footers and corrects it from the forecast grid cell's elevation to the summit's elevation. Twelve methods are
offered and compared side by side (see "Downscaling methods").

    index.html, app.js      the dashboard (plain HTML and JavaScript, no build step)
    core.js, peaks.js       downscaling code (methods, regional weather, ensemble) and the list of 48 summits
    vendor/                 Highcharts 13.1.1 and highcharts-more, used for the charts (see "Charts and licence")
    peaks.json              the same list for the PHP service
    api/nws.php             pulls api.weather.gov, saves one file, serves it to the dashboard
    api/autoroad.php        reads the Mount Washington Auto Road temperature stations, saves the last answer for a minute
    api/config.php          your contact address, cache lifetime, cache folder
    cache/                  the saved pull (must be writable by the web server)
    serve.py                run everything with Python alone, no PHP (for your own machine)
    tests/                  core.test.js (node tests/core.test.js), mock_nws.py (a stand-in for api.weather.gov and for the Auto Road
                            feed) and fixtures/autoroad_sample.json (a real answer from the feed)

## Set up

1. Needs PHP 7.4 or later with the curl extension, on any web host (Apache, nginx with PHP-FPM, or the built-in server).
2. Upload the folder. Make `cache/` writable by the web server.
3. Open `api/config.php` and put your e-mail address or a page URL in `contact`. NWS asks every API user to identify itself.
4. Open the site. The first visit after the saved copy is more than an hour old pulls a fresh forecast, which takes
   10 to 60 seconds; everyone else gets the saved copy instantly.

`api/upperair.php` and `api/metar.php` need nothing more than the same folder and `cache/` (see Hypsometric below); the two addresses are in `api/config.php`.

Try it locally with PHP: `php -S localhost:8080` in this folder, then open http://localhost:8080/

No PHP? Run `python3 serve.py --contact you@example.com` in this folder instead and open http://localhost:8080/.
It serves the dashboard and answers `/api/nws.php` itself, with the same saved-copy behavior.
Do not use `python3 -m http.server`: it cannot run PHP and sends back the source of `api/nws.php`.

### Keep it fresh without making a visitor wait (optional)

    */30 * * * * php /path/to/nh48-dashboard/api/nws.php

Run from the command line the script always pulls, writes the cache and prints a summary.

### Nginx

Nginx ignores `.htaccess`, so block the cache folder yourself:

    location /cache/ { deny all; }

## Downscaling methods

Pick one on the Setup tab; the Forecast tab compares every available method (with the mean lapse rate each implies) and adds
a Most likely combination (next section). "Most likely" is the default selection.

| Group | Method | Needs |
|---|---|---|
| The summit's own grid cell | Fixed lapse (presets: standard atmosphere 6.5, dry adiabatic 9.8 K/km) | nothing |
| | Conditions (rate from humidity, precipitation, cloud, wind, time of day) | nothing |
| | Adiabatic parcel (dry to the condensation level, then moist) | humidity, which NWS has |
| | Monthly climatology (12 editable monthly rates plus a daily swing) | nothing |
| Model pressure levels | Levels, **Hypsometric** | the model's 950-700 hPa levels, loaded automatically (see below); or a custom forecast with upper-level data |
| **All 48 summits' NWS forecasts as stations** | **BCDG**, Elevation regression, Local regression (PRISM-style), GIDS | the normal NWS pull |
| Your own stations | BCDG on pasted station CSV | station CSV |
| Combined | Most likely (regime-weighted median of the methods above) | nothing |

**The NWS network.** Each summit's `/points` call resolves to a forecast grid cell that carries its own elevation and hourly
temperature. Summits that share a cell count once, so about 44 cells become pseudo-stations (cell elevation, cell position,
forecast temperature). BCDG, the regressions and GIDS run on them for the selected summit. `api/nws.php` and `serve.py` now also
save each cell's centre (from the polygon `/gridpoints` returns) to place it; an older saved pull without it still works, using
the mean position of the summits in the cell. Because every cell comes from the same NWS forecast, the network reproduces the
lapse rate that forecast already has and cannot see what it misses. Observed data from real valley and summit stations, loaded
through "Your own stations", is the better input.

**Assumed, not fitted.** The monthly rates (4.6 to 6.5 K/km) are generic mid-latitude mountain values, not New Hampshire
values. The BCDG radii and weights, the local-regression weight functions and the limits on lapse rates (-5 to 11 K/km) and
horizontal gradients (0.1 K/km) are also assumptions. Compare a week of output with a summit station and use the bias control.

**Change to be aware of.** The "Diurnal swing removed" control now applies only to the methods with a prescribed rate (Fixed,
Conditions, Adiabatic, Climatology), as the notes on the Setup tab always said. Before, it also acted on Levels, Hypsometric and
BCDG. It starts at no change, so default output is the same.

Run the tests with `node tests/core.test.js` (no dependencies). To try the whole pipeline without the internet:
`python3 tests/mock_nws.py 9911`, then `NH48_NWS_BASE=http://127.0.0.1:9911 python3 serve.py`.

## Most likely, the bands and the regional weather

The Forecast tab draws every available method as a line, the raw NWS grid-cell value as a dashed line, and a heavy
"Most likely" line with two shaded bands: the middle 50% (P25 to P75) and the middle 80% (P10 to P90) of the methods. The
comparison table lists each method's difference from the raw NWS cell (mean and range) with its weight. Hovering the chart shows
the ten levels of the methods at that hour, in this order: MIN, P5, P10, P25, P50, MEAN, P75, P90, P95, MAX. Below them every line is
listed from warmest to coolest with its temperature and its difference from the NWS cell; each method also shows the one level it
holds. The key is ordered by each method's mean percentile over the hours shown, and the CSV carries the same ten levels.

**Levels and percentiles.** MIN and MAX are the coolest and warmest method and MEAN is the (weighted) mean. P5 to P95 use the
NIST/SEMATECH e-Handbook definition (section 7.2.6.2): with N values in ascending order the p-th percentile is at rank
r = p(N + 1), the value at rank floor(r) plus the fraction of r times the step to the next value, the smallest value below rank 1
and the largest from rank N. So with fewer than 19 methods P5 is the same as MIN and P95 the same as MAX; they separate once
there are more. With regime weights the plotting position is (weight below + w/2 + mean w/2) / (total weight + mean w), which is
symmetric and is exactly i / (N + 1) when the weights are equal.

**One method per level.** No two methods hold the same level. The coolest method is MIN and the warmest is MAX. The methods
between are matched, in order of temperature, to P5, P10, P25, P50, MEAN, P75, P90 and P95 (MEAN placed where the mean falls among
the methods), choosing the match that keeps each method nearest to its level's percentile (minimum total distance). With ten
methods every level is held once; with fewer, the levels that no method is near stay empty; with more than ten, the methods left
out show a dash, because there are only ten levels to give. Methods with equal temperatures still hold different levels. The raw
NWS cell, Most likely and MWARVTP are not methods: they take no level and do not move the levels. They show where they fall
against them instead, as `<MIN` or `>MAX` outside all the methods, `P25-P50` between two levels, or `=P50` on a level's
temperature. The levels describe where the methods agree or disagree; they are not probabilities.

**How Most likely is made.** For each hour the methods' summit temperatures are combined with weights, and the line is the
weighted median (the bands are weighted 10/25/75/90th percentiles, NIST definition). Methods that share an idea (BCDG, the regressions and
GIDS all fit the same NWS network; Fixed, Conditions and Climatology all prescribe a rate) share their weight so a crowd of
near-copies does not outvote the rest. The weights come from the regional weather: the NWS cells are averaged
(cloud, precipitation, humidity, wind, temperature trend) and each hour is put into a regime (wet or frontal, cold advection,
warm advection, windy and mixed, clear and calm by day or night, or mixed). Each regime has an expected cooling rate with an
uncertainty. That is combined, weighted by the inverse of the variances, with the rate the NWS network implies at that hour
(slope +/- standard error). A method whose implied rate is close to the result gets more weight, with a floor of 3%.
"Equal weights" turns the weighting off.

**Pressure.** NWS grids carry no pressure. The low and high pressure signatures (cloudy, wet, humid, rising temperature
tends to low; clear, drying, cooling tends to high) are inferred from the fields the grid does have. Add `mslp_hpa` or
`p_sfc_hpa` to a custom forecast and the real value is used.

**What it is not.** The regime rates, the uncertainties and the pressure rules are assumptions, not fitted to New Hampshire
observations. The bands show how far the methods disagree, not a calibrated probability that the summit will be inside them,
and Most likely is a consensus, not a validated forecast. Compare it with a summit station and use the bias control.

**Time axis.** Every hour has a tick mark. The labels are thinned automatically to the finest step that stays legible
(every hour, 2, 3, 4, 6, 12 or 24 h), and fill in when you drag across the chart to zoom. "Every hour" labels each hour and scrolls
sideways when the period is long. Times are the forecast's local wall-clock time. The vertical axes are padded so the data
never leaves the plot (this was the bug behind the temperature running off the top of the old chart).

## Charts and licence

The charts use Highcharts (bundled in `vendor/`, no CDN). Highcharts is free for non-commercial use; a commercial site needs
a Highsoft licence (https://www.highcharts.com/license). If that does not suit you, the numbers are in the tables under each
chart and in the CSV, and the chart code is all in the "Highcharts" section of `app.js`.

## MWARVTP: the live look at the Mount Washington Auto Road

The Mount Washington Auto Road has temperature sensors at six heights (475 m to 1,616 m), and the feed also carries the Observatory tower on the summit (1,923 m). When the page
loads (and every 5 minutes while it is open, and on Refresh in the card) it asks `api/autoroad.php` for them, and the Forecast tab
uses the profile they draw right now as a "live look" at the cooling rate. It is meant for the next few hours only, for things the
forecast grids smooth over, such as inversions and a cold pool sitting in the valley.

    https://xmountwashington.appspot.com/proxy.php?endpoint=autoroad     (set in api/config.php, `autoroad_url`)

`api/autoroad.php` (and the same route in `serve.py`) fetches that address, keeps only air temperature (the `air_temperature` measurement; road-surface, pavement and ground temperatures are never read, and a sensor or measurement labelled that way is skipped) with good quality flags,
saves a slim copy in `cache/` for `autoroad_ttl` seconds (60), and serves it. The outgoing address is fixed; nothing from a visitor reaches
it. If the feed is down the last saved copy is served, and the page ignores any reading older than 45 minutes on its own.

**How it is used.** Each station's temperature is the median of its last 8 minutes (the tower is the mean of its two sensors).
Then:

1. *A lapse rate for this summit's layer.* A robust straight line (Tukey biweight, started from a Theil-Sen fit) is put through the
   stations, weighting each by 1 / (0.3 K squared + its own scatter squared) and by a tricube kernel around the layer between the NWS
   cell's elevation and the summit's, so a summit in the Presidentials gets the local shape of the profile, not a mountain-wide average.
   A station that disagrees with the line is marked and effectively dropped. With fewer than three stations near the layer the whole
   column is used.
2. *Where it starts.* The live temperature at the summit is the NWS cell temperature for the hour of the reading, moved up with the live
   lapse rate. The difference from the forecast's own most-likely value is the live adjustment.
3. *How it fades.* The adjustment is multiplied by a weight that is 1 at the reading, 0.5 at half the horizon and 0 at the horizon
   (raised cosine; 6 h by default, 3, 9 or 12 h on the card). After the horizon the forecast is exactly what it was.
4. *How much to trust it.* The adjustment is also multiplied by a confidence from 0 to 1: the uncertainty of the slope, how much the
   answer moves if any one station is dropped, how many stations are near the layer, the age of the readings, whether the layer is
   inside the stations' height range, and the distance from the Auto Road (half as representative at 50 km). A messy profile therefore
   moves the forecast only a little.

For Mount Washington itself the tower gives the temperature directly. By default the line starts from the tower reading and fades back
to the forecast over the horizon, and the road stations, fitted without the tower and carried up to it, are shown as a check of the
method ("Check: ... give 56.9, the tower reads 51.4"). Uncheck the box on the card to test the road stations alone.

The card shows the profile (stations, the fitted line, the forecast's own lapse and the live one, both from the NWS cell), the cooling rate
of the whole mountain over the last two hours, and every station with its reading, its cooling rate against the station below it and
a stability class (inversion, very stable, stable, typical, steep, superadiabatic). On the charts the pink line is the live look at full
strength inside a shaded window, and the heavy Most likely line follows it by the confidence. "Not applied" leaves Most likely alone and
keeps the pink line as a reference. The hourly table and the CSV get MWARVTP columns (`most_likely_before_live_c`, `mwarvtp_c`,
`live_weight`).

**What to keep in mind.** This is a nowcast heuristic. Its constants (the 8-minute median, the noise floor, the kernel width, the
50 km reach, the 6 h fade) are assumptions and are not fitted or verified against observations. The road runs up the east side of
the mountain, so cold-air pooling, sun on open ground and shelter from the wind there need not match what a summit on the other side of
the range sees; that is what the distance factor is a crude allowance for. Sensors in open sun and light wind can read several degrees
warm, and the fit cannot tell that from a real warm layer beyond marking the station that disagrees. A profile that is not a straight
line, like a warm layer in the middle, gives a low confidence on purpose. The live look cannot see the weather changing: a front arriving
inside the horizon defeats it, which is why it fades out. I could not reach the live feed from where this was built, so it was tested
against a real sample answer and a mock (`python3 tests/mock_nws.py 9911`, then run `serve.py` with `NH48_NWS_BASE=http://127.0.0.1:9911
NH48_AUTOROAD_URL="http://127.0.0.1:9911/proxy.php?endpoint=autoroad"`; `/__scenario?name=normal|inversion|stale|down|sample` switches what the mock
serves).

## Hypsometric: model pressure levels and observed pressure

The hypsometric equation, z2 - z1 = (Rd Tv / g) ln(p1 / p2), ties the thickness of a layer to its mean virtual temperature. To use it the
dashboard needs pressures and heights that NWS does not publish, so two small services fill the gap. Both keep a saved copy, serve the
last one if the source is down, and use a fixed outgoing address (nothing a visitor types reaches it; `api/upperair.php` takes only a
summit id, checked against `peaks.json`).

| Service | Source | Kept for | What it carries |
|---|---|---|---|
| `api/upperair.php?peak=mount-washington` | Open-Meteo (NOAA GFS/HRRR and others), one call per summit, `upperair_url` | 1 hour | model sea-level pressure and, at 950, 925, 900, 850, 800 and 700 hPa, the height, temperature and humidity, for 6 hours back and 8 days ahead |
| `api/metar.php` | NWS station observations, `api.weather.gov/stations/{id}/observations`, for Mt Washington Regional (KHIE) and Eastern Slopes Regional (KIZG) | 5 minutes | the last 8 hours of temperature, sea-level pressure (as reported) and station pressure |

**The Hypsometric method.** The two levels that bracket the summit give its free-air state: the equation, run upward from the lower
level through the layer's virtual temperatures, gives the pressure at the summit's height, and temperature and humidity are
interpolated in ln p between the levels. The NWS cell then pulls that toward its own forecast: the difference between the NWS
temperature and the model's free-air temperature at the cell's height (held to 6 K) is added at the summit, fading by 1/e over 700 m of
height difference. A cell near the summit counts almost fully, a valley cell hardly at all. Each layer is checked (thickness against its
two temperatures, 2.5 K); a level that fails skips the hour, and the method falls back to the Conditions rate for it and says so. **Levels**
uses the same data more simply: a straight line in height from the NWS cell to the level nearest the summit.

**Where observed pressure goes, and where it does not.** Observed pressure is not fed into the thickness. A thickness is a small
difference between large numbers, so 1 hPa of error in a surface pressure changes the lapse rate it implies by about 3 K/km for a base near
Mount Washington's height (2 at 1,400 m, 0.6 at 300 m). The tests show this. Instead the observation is used where it is robust:

- **Regime.** The model's sea-level pressure, moved by the observation's difference from the model at the same instant (fading with a 12 hour
  time constant), gives the 6 hour tendency that marks each hour low- or high-pressure. Within 3 hours of an observation the measured 3 hour
  tendency is used. This replaces the inference from clouds and wind whenever the feeds answer.
- **Model check.** The card shows how far the model is from the observation, and flags 2 hPa or more (and 4 or more as large). Two stations that
  differ by over 3 hPa are not averaged; the one nearer the model is kept.
- **Summit pressure.** It starts from the adjusted sea-level pressure instead of the standard atmosphere.

**What was checked, and what was not.** On synthetic atmospheres built by integrating the hydrostatic equation (dry, 80% humid, and with an
inversion aloft and a kink inside the layer) the method recovers the true summit temperature to about 0.05 K, 0.1 K and 0.35 K. The services and
the page were tested against mocks (`tests/mock_nws.py`, now also `/v1/forecast` for the model and `/stations/{id}/observations`; `/__ua?name=normal|front|down|thin|bad`
and `/__metar?name=normal|falling|down|stale|split` switch what they answer). I could not reach Open-Meteo or api.weather.gov from where this was built, so the exact
response fields (`pressure_msl`, `temperature_850hPa`, `geopotential_height_850hPa`, `relative_humidity_850hPa`, and `seaLevelPressure`,
`barometricPressure`, `temperature`, `elevation` in the observations) come from their documentation and have not been run against the live services. If a call
fails, the card shows the service's own message. Set `upperair_models` (or `NH48_UPPERAIR_MODELS`) to pin a model, for example `gfs_seamless`; left empty, Open-Meteo picks.
The Mount Washington summit's own pressure (station KMWN) is blank in the NWS observations, so a two-pressure valley-to-summit solve is not possible from these feeds, and it would
be too noisy to use anyway. Open-Meteo's free service is for non-commercial use; see https://open-meteo.com/en/terms.

## How the forecast is pulled

For each summit `api/nws.php` asks `/points/{lat},{lon}` for the summit's forecast-office grid cell, then downloads
`/gridpoints/{office}/{x},{y}` once per distinct cell (about 40 cells cover the 48 summits). It runs six requests at a time,
retries 429 and 5xx answers with a growing pause, sends the contact address in the User-Agent, and never puts visitor input
in an outgoing URL. If NWS cannot be reached it serves the last saved copy and the dashboard says so. A visitor's Refresh is
ignored when the saved copy is under five minutes old (`min_refresh`).

## The API call pop-up

Whenever the server really has to pull from NWS (the first visit after the saved copy expires, or Refresh once it is over five
minutes old) the dashboard opens a small panel that lists every call as it finishes: the summit name, the request path, the HTTP
status, the time it took, retries (with the pause before them), and which summits each downloaded grid cell serves. A bar
shows progress through the two steps: the 48 grid-cell lookups, then the grid-cell downloads. Close it with the x or Escape;
after a clean pull it tidies itself away after seven seconds unless the pointer is over it. "Show API calls" reopens the
last log. The 15-minute background refresh fills the log without opening it. When the dashboard is served from the saved
copy no calls happen, so nothing pops up.

The panel is fed by `api/nws.php?stream=1` (and the same in `serve.py`), which sends one JSON line per call while it works. Anything
between the browser and PHP that buffers responses will make the panel jump from empty to full. Nginx: add
`fastcgi_buffering off;` for that location (the script already sends `X-Accel-Buffering: no`). Apache with mod_deflate or
FastCGI may need `SetEnv no-gzip 1` for `/api/`.

## Light and dark mode

The Auto / Light / Dark control in the header follows the operating system by default. Light and Dark override it and are
remembered in the browser (`localStorage`, key `sd-theme`). The charts are redrawn in the new colors.

## Android app

The same dashboard builds into an installable Android app (a Capacitor wrapper), built for free by GitHub Actions. Step-by-step
instructions for a beginner are in `ANDROID.md`.

- `feeds.js` is the on-device replacement for `api/*.php`. `Feeds.fetch(url, init)` is a drop-in for `fetch`: in the app (or when
  `window.NH48_FEEDS.direct === true`) it answers `api/nws.php`, `api/autoroad.php`, `api/upperair.php` and `api/metar.php` requests
  itself, calling the services directly, with the same JSON, the same cache lifetimes (IndexedDB) and the same streamed progress
  log. On the website it falls through to plain `fetch`, so the PHP/`serve.py` path is unchanged. Native HTTP (CapacitorHttp) is used
  so the required User-Agent header can be sent and CORS does not apply.
- `npm run build:www` (`scripts/build-www.mjs`) assembles `www/`: the web files, local copies of the fonts, `capacitor.js`, and a
  `feeds-config.js` holding the contact string for the User-Agent (`NH48_CONTACT`, else the GitHub repo URL).
- `.github/workflows/build-apk.yml` runs `tests/core.test.js`, builds `www/`, runs `cap sync`, builds a debug APK with Gradle and
  publishes it as the `latest` release. `android/app/nh48-debug.keystore` is a fixed debug key so new builds install over old ones; the
  version code is the run number.
- `tests/feeds.test.js` starts `tests/mock_nws.py` and the PHP endpoints and checks that `feeds.js` returns the same JSON.
- Highcharts and Open-Meteo are free for non-commercial use only. The app is a personal sideload build, not a Play Store release.

## Notes

- The dashboard loads the Barlow and IBM Plex fonts from Google Fonts. Without them it falls back to system fonts.
- Summit elevations follow Wikipedia's list of the four-thousand footers and coordinates follow nh48.info. Sources differ by
  tens of feet in elevation and a few hundred metres in position.
- NWS grids hold no upper-air or pressure data (the `pressure` layer exists in the gridpoints schema but is empty for the Mount
  Washington cell, GYX 33,80; check yours by searching the `forecastGridData` answer for `"pressure"`). The Levels and Hypsometric
  methods therefore read the model's pressure levels from Open-Meteo (see below); without that feed they need a custom forecast.
  BCDG on your own stations needs a station CSV. BCDG on the NWS forecasts, the regressions and GIDS need nothing extra.
- The summit adjustments on the Setup tab (weaker daily swing, wind speed-up) start at no change and are heuristics, not
  fitted values. Compare a week of output with a summit station, such as the Mount Washington Observatory, and use the bias control.
