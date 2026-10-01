# Put the dashboard on your Pixel (no Android experience needed)

You will end up with an app called **NH48 Summit Forecast** on your phone. Nothing is installed on your computer, and you
never open Android Studio. GitHub builds the app for you, for free, and hands you a file to tap on your phone.

The steps, in short: **get these files into a GitHub repository → wait ~8 minutes while GitHub builds → download the .apk on your phone → tap it.**

> **Honest status.** The forecast code, the on-device data layer and the build recipe are tested. What could **not** be
> tested where this was written: the actual APK build (it needs Google's Android tools, which were unreachable) and the
> live National Weather Service / Mount Washington Auto Road / Open-Meteo feeds. So the **first build and first launch are
> the real test**. If anything goes red or looks wrong, copy the message and send it back; see "If something goes wrong".

---

## 1. Get the files into a GitHub repository

You need a free GitHub account (https://github.com/signup).

**Easiest: GitHub Desktop** (a free app, no command line)

1. Install GitHub Desktop from https://desktop.github.com and sign in.
2. Unzip `nh48-dashboard.zip` somewhere (for example `Documents/nh48-dashboard`).
3. In GitHub Desktop: *File → Add local repository…* → choose the unzipped folder. If it says "not a git repository",
   click **create a repository** there.
4. Click **Commit to main**, then **Publish repository**. Keep it **private** if you want (builds still work).

**Alternative: the GitHub website.** *New repository → uploading an existing file*. The website accepts at most 100
files at a time and often skips hidden folders such as `.github`, which is the folder that holds the build recipe. If you
use this route, upload in several batches, then in the repo click *Add file → Create new file*, type
`.github/workflows/build-apk.yml` as the name, and paste in the contents of `docs/build-apk.yml`.

**Alternative: let Claude push it.** Create an empty repository on GitHub and tell Claude its name
(`your-username/your-repo`). Claude can try to attach it to this session and push the files. That has not been confirmed
to work in every setup.

## 2. Let GitHub build the app

1. Open your repository on github.com and click the **Actions** tab.
2. The build starts by itself when files are pushed. If you don't see a run, click *Build Android APK* (left) →
   **Run workflow**.
3. Wait about **5–8 minutes**. A **green ✓** means it worked. A **red ✗** means it failed (see the last section).

## 3. Install it on your Pixel

1. On the **phone**, open your repository in Chrome and tap **Releases** (right-hand side; or add `/releases/latest` to the repo address).
2. Under **latest**, tap **NH48-Summit-Forecast.apk** to download it. (Log in to GitHub on the phone if the repo is private.)
3. Tap the downloaded file. Android will say it needs permission: tap **Settings** and switch on **Allow from this source**
   for Chrome, go back, then **Install**.
4. If Google Play Protect warns about an unknown developer, tap **More details → Install anyway**. That is normal for an
   app that does not come from the Play Store.
5. Open **NH48 Summit Forecast** from your app drawer.

**Updating later:** every time you change the files and push, GitHub rebuilds and replaces the *latest* release.
Download and tap the new file; it installs over the old one and keeps working, because every build is signed with the same key.

## 4. First-run checklist

- The first forecast load can take **up to a minute**: the app pulls the forecast for all 48 summits from the National
  Weather Service itself, one grid cell at a time, and shows a progress panel. After that it is saved on the phone and
  shows instantly. It refreshes when the saved copy is older than an hour.
- Open the **MWARVTP** card: that is the live Mount Washington Auto Road air temperature. If it shows an error, note the
  exact words and send them back.
- Levels/Hypsometric methods use pressure-level data from Open-Meteo and airport pressure (KHIE, KIZG). If these are missing you
  will see a message on the method instead of a number.
- Dark or light mode follows the phone. The Auto / Light / Dark switch at the top overrides it.
- Offline: the last saved forecast still opens; new data needs a connection.

## 5. What this is and isn't

- There is **no server**. The phone calls the weather services directly (the job the PHP files did). The National Weather
  Service asks callers to identify themselves; the app does that with the address of your GitHub repository
  (for a private repo nobody can open it). Your email address is never sent anywhere.
- It is a **personal build**, signed with a debug key so you can install it without the Play Store. It is not set up for
  publishing on Google Play.
- **Licences.** Highcharts (the charting library) and Open-Meteo are free for **non-commercial** use only. Fine for a
  personal hiking tool; check their terms before sharing it widely or charging for it.
- Forecasts are model output and heuristics, not a safety service. Check the Mount Washington Observatory and the
  official forecasts before going above treeline.

## If something goes wrong

- **Red ✗ in the Actions tab:** click the failed run, click the red step, and copy the last 30 or so lines of red text.
  Send them to Claude. The first real build often needs one small fix.
- **"App not installed":** an old copy signed with a different key is on the phone. Uninstall it and install again.
- **Forecast never loads:** note the message shown (and the lines in the progress panel) and send them back.
- **Play Protect blocks it entirely:** *Play Store → profile icon → Play Protect → settings* and turn off
  "Scan apps with Play Protect" for the install, then switch it back on.

## For the curious: how it fits together

| Piece | What it does |
|---|---|
| `index.html`, `app.js`, `core.js`, `peaks.js`, `vendor/` | The dashboard itself (same code as the website version). |
| `feeds.js` | Replaces the PHP: the same four feeds (NWS, Auto Road, upper air, METAR) fetched on the phone, cached in IndexedDB with the same lifetimes. |
| `scripts/build-www.mjs` | Collects the web files into `www/`, bundles the fonts so the app works offline. |
| `capacitor.config.json`, `android/` | Capacitor wraps `www/` in a small Android app; native HTTP is used so the required User-Agent can be sent. |
| `.github/workflows/build-apk.yml` | Runs the tests, builds the APK, publishes it as the `latest` release. |
