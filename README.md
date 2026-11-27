# OBD Dashboard

A free, **read-only-by-default** car and bike diagnostics app for a cheap Bluetooth **ELM327 OBD-II adapter**.
It runs as an **Android app**, as a **website in Chrome**, or on a **Windows laptop**, and you can ask **Claude** about your car through the included MCP server.

It started as a dashboard for a 2024 Hyundai Creta and now works with most cars, motorcycles and scooters that speak standard OBD-II.

| | Link |
|---|---|
| 📲 Android app (APK) | https://github.com/YadunandanaVR/creta-obd/releases/latest/download/creta-obd.apk |
| 🌐 Web app (Chrome) | https://yadunandanavr.github.io/creta-obd/ |
| 🧪 Demo, no car needed | https://yadunandanavr.github.io/creta-obd/?demo=1 |

---

## Contents
1. [What it can do](#what-it-can-do)
2. [What you need](#what-you-need)
3. [Install & connect: Android app](#install--connect-android-app-recommended)
4. [Use it in Chrome (web app)](#use-it-in-chrome-web-app)
5. [Use it on a Windows laptop](#use-it-on-a-windows-laptop)
6. [Tour of the tabs](#tour-of-the-tabs)
7. [Trips, mileage & cost](#trips-mileage--cost)
8. [Driving coach](#driving-coach)
9. [Hidden manufacturer data](#hidden-manufacturer-data)
10. [Saving your data: device, backup & Google Sheets](#saving-your-data-device-backup--google-sheets)
11. [Ask Claude about your car (MCP server)](#ask-claude-about-your-car-mcp-server)
12. [Safety: read-only by design](#safety-read-only-by-design)
13. [Cars, bikes & protocols](#cars-bikes--protocols)
14. [Troubleshooting](#troubleshooting)
15. [Updating the app](#updating-the-app)
16. [Demo modes](#demo-modes)
17. [Project layout (for developers)](#project-layout-for-developers)
18. [Limitations](#limitations)

---

## What it can do

- **Live dashboard:** rev counter, speedometer, coolant (or oil / intake on air-cooled engines) and 12 V battery gauges with 3D tilt. Every supported sensor is grouped, and you can tap any value for *what it is, what's normal, and what's wrong if it isn't*.
- **Trouble codes:** stored, pending and permanent codes, each with a plain-English meaning, likely causes and fixes. Also freeze frame, readiness monitors (PUC/emissions-test ready), and the ECU's own pass/fail test results (Mode 06).
- **Battery health:** charge %, charging-system check, and a cranking test that measures the voltage dip on start-up.
- **Trips:** an automatic logbook with GPS start/end and route, distance, duration, fuel used, **mileage (km/L)**, **cost**, average and top speed, max engine temperature, idle time and harsh driving.
- **Driving coach:** clutch, gear-shift, acceleration and braking technique, with a score and tips for every trip.
- **Under the hood (3D):** a sculpted Creta-style SUV (Robust Emerald Pearl by default, plus the other Creta colours) that you can spin 360°. Views:
  - **Interior:** the driver's seat, with live panoramic screens, ambient lighting and pedals that move with throttle and braking.
  - **Engine:** the bonnet opens on the engine bay, with a coolant tank whose level follows temperature, brake fluid, washer fluid and drive shafts.
  - **Body style:** when the vehicle profile is a Creta (or a Hyundai with no model set), the car uses real Creta dimensions (4330 × 1790 × 1635 mm, 2610 mm wheelbase, 18" wheels) and its design cues: L-shaped LED DRLs, a wide parametric grille, squared wheel arches, connected tail lamps, a shark-fin antenna, a 4-spoke steering wheel and Bose speaker grilles. Other vehicles get a generic SUV. The 🚙 button switches between Auto, Creta and Generic.
  - **📦 3D model:** load your own `.glb`/`.gltf` (e.g. a Creta model you bought or downloaded under a licence that allows personal use). It's scaled to 4.33 m, kept on the device, and replaces the built-in body; ↻ turns it if it faces backwards.
  - **Cutaway / X-ray:** a mechanically animated engine (crankshaft, rods, pistons, spark plugs firing in order), plus cooling, exhaust heat, airflow, fuel flow and live labels.
- **Cylinder health,** **alerts** (overheating, low battery, not charging, red zone, speed limit, new codes) and **0–60 / 0–100 / 40–80 timers**.
- **Hidden data:** discover the modules in your car, read their part and software numbers, find hidden values, and make your own custom PIDs. All read-only.
- **Reports & export:** a printable / PDF health report for your mechanic, trips as CSV, everything as JSON, and **Google Sheets** backup.
- **Multiple vehicles:** cars, diesels, motorcycles and scooters, recognised automatically from the VIN.
- **Bluetooth signal meter** so you know you're in range, plus **7 themes** (Midnight, Knight Rider, Dark Knight, Neon Grid, Retro Amber, Racing Red, Daylight).

## What you need

- A **Bluetooth ELM327 OBD-II adapter.** Cheap "ELM327 mini" clones work with the Android app. Branded adapters (Vgate iCar Pro, Veepeak, OBDLink) are more reliable.
- **Android phone** (Android 8+) for the app, **or** Chrome 137+ on Android or a computer for the web app.
  *iPhones can't use classic-Bluetooth ELM327 adapters.*
- A vehicle with an **OBD-II port**. In cars it's under the dashboard on the driver's side. Bikes usually need an adapter cable (see [Cars, bikes & protocols](#cars-bikes--protocols)).

## Install & connect: Android app (recommended)

The Android app connects the way native OBD apps do, so it also works with cheap adapters that Chrome can't see.

1. **Download** the APK on your phone: [creta-obd.apk](https://github.com/YadunandanaVR/creta-obd/releases/latest/download/creta-obd.apk).
2. **Install** it. Android will ask you to allow installs from your browser or file manager, because the app isn't from the Play Store. A Play Protect warning is expected for a personal app.
3. **Pair the adapter once:** Android **Settings → Bluetooth → Pair new device → OBDII**, PIN **`1234`** (or `0000`).
   > It's normal for the adapter to show as *paired* but never *connected* in Android settings. It only connects while an app uses it.
4. Plug the adapter into the car and switch the **ignition ON**. The engine can be off.
5. Open **OBD Dashboard** → tap **🔗 Connect** → allow **Nearby devices** → pick **OBDII**.
6. Next time it reconnects by itself. The screen stays on while the app is open.

The adapter talks to **one app at a time**. Close other OBD apps (Car Scanner, Torque…) first, using **Force stop** if needed.

## Use it in Chrome (web app)

1. Open https://yadunandanavr.github.io/creta-obd/ in **Chrome 137+**.
2. Tap **🔗 Connect** and pick your adapter. If it's not in the list, try **"OBDII not in the list? Try alternative"**, or use the Android app.
3. Optional: Chrome menu ⋮ → **Install app**. It then works offline.

## Use it on a Windows laptop

The laptop version uses a small Python server that owns the Bluetooth COM port.

```bash
pip install pyserial
cd obd_dashboard
python server.py COM4
```
Open **http://127.0.0.1:8765**. Find your COM port in *Device Manager → Ports (COM & LPT) → Standard Serial over Bluetooth link* (use the **outgoing** one).

- Only one device can use the adapter. Stop the server (Ctrl+C) before connecting from your phone.
- Trips you record in the laptop dashboard are also saved by the server (`trips.json`) so the MCP server can read them.

## Tour of the tabs

| Tab | What's there |
|---|---|
| **Dashboard** | Gauges, key readings and a 2-minute trend chart. Tap ⓘ on anything for an explanation. |
| **Diagnostics & codes** | Trouble codes with fixes, readiness, battery health + cranking test, live health checks, on-board test results, usage counters, symptom checker. |
| **All live data** | Every sensor the ECU reports, grouped. |
| **Vehicle & features** | VIN, ECU, calibration IDs, what your car exposes, odometer calibration. |
| **Console** | Send raw *read-only* OBD requests. Anything that could change the car is blocked, with an explanation. |
| **Trips** | Current trip, totals, past trips, driving coach, performance timers, alerts. |
| **Under the hood** | The 3D car (exterior, interior and engine bay views), readings by system, cylinder health. |
| **Hidden data** | Module scan, ECU identification, ID scanner + live byte watch, custom PIDs. |
| **Export & sync** | Health report (PDF/print), CSV/JSON export, restore from backup, Google Sheets. |
| **Features & write mode** | Every feature with its risk level, and the guarded "clear codes" action. |

**Header:** tap the vehicle name to switch or edit vehicles. 📶 shows Bluetooth link quality, **?** opens help, and 🎨 changes the theme.

## Trips, mileage & cost

- A trip **starts automatically** when the engine runs and **ends** 30 s after it stops (or 2 min after losing the connection).
- **Fuel** comes from the fuel-rate sensor if your vehicle has one; otherwise from the airflow sensor (MAF), with fuel cut-off while coasting detected; otherwise it's estimated from manifold pressure and engine size. Diesels need a fuel-rate sensor.
- **Calibrate mileage to your pump:** in Trips, tap **⛽ Calibrate with a fill-up** at a full tank, drive, and at the next full tank tap it again and enter the litres the pump showed.
- **Cost** uses the fuel price in your vehicle profile (tap *change* in Trips).
- **GPS route:** allow location the first time. Each trip has *Start / End on map* links that open Google Maps. You can turn GPS off per vehicle.

## Driving coach

OBD has no clutch-pedal, brake-pedal or gear sensor, so the app infers them.
In gear, **RPM ÷ speed** is a fixed ratio for each gear. The app **learns your gear ratios** as you drive (Trips → Driving coach shows them). When the ratio matches no gear, the clutch is down or slipping.

It flags: **riding the clutch, slow gear changes, rev flare** (accelerator pressed with the clutch down), **harsh downshifts, stalls, lugging, over-revving, high-rev launches, coasting with the clutch down, harsh acceleration and braking, jerky throttle**, and **accelerator pressed while braking hard**.

- Every trip gets a **score out of 100** with tips and a timeline. Open a trip to see it.
- **Live coaching pop-ups** are optional (Trips → Driving coach).
- Set your **gearbox type** (Manual, AMT, Automatic, CVT/IVT, DCT) in the coach card or the vehicle editor. Clutch checks only run for manual.
- Results are estimates, so look at the trend over several trips.

## Hidden manufacturer data

Every module in the car answers manufacturer **read** requests (UDS, ISO 14229). This tab only uses read services (`22`, `21`, `1A`) and adapter addressing. It never opens sessions, unlocks security, runs routines or writes anything.

1. **Scan modules** shows which computers answer (engine, gearbox, ABS, body…) with their part numbers. **Details** shows the standard identification (software version, serial…).
2. **Find hidden values:** pick a module and an ID range → **Scan IDs** → **Watch** the ones that answer, with the engine running. Changing bytes light up, and the app tells you which byte follows RPM, speed or temperature.
3. **Custom PIDs:** turn a byte into a live tile with a formula such as `A-40`, `(A*256+B)/4` or `A*0.5-64`. Export and import them as JSON.

Works in the Android app (or direct-Bluetooth mode) on CAN vehicles. No published IDs exist for most Indian models, so the app doesn't guess. You discover them with the scanner.

## Saving your data: device, backup & Google Sheets

- **Everything is saved on your phone first** and works offline: trips, vehicles, battery tests, custom PIDs and settings.
- **Uninstalling the app erases this data.** Before reinstalling:
  1. **Export & sync → Everything (JSON)** → save to Drive / Files.
  2. Uninstall the old app and install the new one.
  3. **Export & sync → ♻ Restore from backup** → pick the file. Duplicates are skipped.
- **Google Sheets backup** is optional, and the data goes to your own sheet only:
  1. Create a Google Sheet → **Extensions → Apps Script**.
  2. In the app, **Export & sync → Copy script**, paste it, and change `SECRET`.
  3. **Deploy → New deployment → Web app** (Execute as: *Me*, Access: *Anyone*) → copy the URL.
  4. Paste the URL and the same secret in the app → **Save** → **☁ Sync now**.
  - Trips that aren't uploaded yet **stay queued** and upload automatically: after each trip, when the app opens, when the internet returns, and every 15 minutes. The tab shows how many are waiting.
  - The sheet gets a **Trips** tab (distance, fuel, km/L, cost, speeds, GPS map links, driving score…) and a **Health** tab (codes, battery, coolant).

## Ask Claude about your car (MCP server)

`mcp_server/obd_mcp.py` lets Claude (Claude Code / Claude Desktop) read your car's data through the laptop server. It's **read-only**: there's no tool to clear codes or write anything.

```bash
pip install mcp pyserial
cd obd_dashboard
python server.py COM4          # keep this running, ignition ON
```
The `.mcp.json` in the parent *My Car* folder registers it for Claude Code. Approve it the first time Claude Code asks. For other clients, run `python obd_dashboard/mcp_server/obd_mcp.py` over stdio (set `OBD_URL` if the server isn't on `http://127.0.0.1:8765`).

Tools: `car_status`, `live_data`, `trouble_codes`, `readiness_monitors`, `vehicle_info`, `battery_health`, `onboard_test_results`, `trips`, `trip_details`.
Try asking: *"Any fault codes?"*, *"How's my battery?"*, *"Summarise my last 5 trips and my mileage."*

## Safety: read-only by design

- The app **only sends read requests**: OBD services `01 02 03 06 07 09 0A`, information AT commands, and (in Hidden data) UDS reads `22 / 21 / 1A`.
- The **only write is clearing trouble codes (OBD Mode 04).** It needs all of these:
  - you arm write mode with a typed confirmation;
  - you confirm again by typing `CLEAR`;
  - the **engine is off** (the app checks RPM);
  - and it disarms after one use or 2 minutes.

  The dialog explains exactly what will be erased. Every write is logged.
- Everything else is **blocked**: writing data, I/O control, routines, resets, security access, sessions, coding, flashing, and adapter EEPROM changes. The console explains why.
- The app never controls the car remotely. Body functions such as locks, windows, AC and remote start aren't reachable safely through OBD; use the manufacturer's connected-car app (for example Hyundai Bluelink) for those.

## Cars, bikes & protocols

- **Cars:** any OBD-II / EOBD vehicle (in India roughly BS-IV, 2010+). The protocol is auto-detected; you can force one per vehicle (CAN 11/29-bit, KWP2000 fast/slow, ISO 9141-2, J1850).
- **Motorcycles & scooters:** most BS6 / Euro 5 models (especially 2023+ BS6 phase 2) expose standard OBD, but usually through a small 4/6-pin plug. You'll need the **bike-to-OBD adapter cable** for your brand. If auto-detect fails, choose *KWP2000 fast init*. A few makers only allow their own tools.
- **Vehicle profiles:** tap the vehicle name → **My vehicles**. Each profile has its own rev limit, idle range, gauge scales, cylinders, engine size, fuel price, gearbox, protocol and odometer calibration. The VIN switches profiles automatically.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Incorrect PIN" when pairing | Unplug the adapter for 10 s, plug it in, and pair within 10 s with `1234`. Forget any failed entry and toggle Bluetooth. |
| Paired but not "connected" in Android settings | Normal. It connects only while the app uses it. |
| Chrome's list doesn't show OBDII | Use the **Android app**. Some clones are invisible to Chrome. |
| Connect does nothing / fails | Force-stop other OBD apps, ignition ON, then **Connection log → Copy log** to see where it stops. |
| "Car not responding" | Ignition ON, adapter fully seated. Try a specific protocol in the vehicle profile. |
| Mileage looks off | Do a **fill-up calibration** (Trips). |
| 3D view looks plain / slow | It needs internet once to fetch the 3D library. Tap ✨ to switch to *Balanced* on slower phones. |
| Battery drains when parked | Cheap adapters draw power. Unplug when the car is parked for days. |

## Updating the app

Each new APK currently has a different signing key, so Android won't install it over the old one:
1. **Export & sync → Everything (JSON)** (backup).
2. Uninstall the old app → install the new APK → **♻ Restore from backup**.

Every push to `main` builds a new APK automatically (GitHub Actions) and publishes it as the latest release. The web app updates through GitHub Pages.

## Demo modes

Add a parameter to the web-app URL to try it without a car (simulated adapter, fake identifiers):

| URL | Simulates |
|---|---|
| `?demo=1` | Petrol car, healthy |
| `?demo=dtc` | Car with fault codes (P0171, P0300, pending P0420) and freeze frame |
| `?demo=drive` | Manual gearbox drive (gear learning, riding the clutch, rev flare) |
| `?demo=bike` | Air-cooled motorcycle on K-line |
| `?demo=kline` | Older car on K-line |

## Project layout (for developers)

```
index.html        Dashboard UI (tabs, gauges, diagnostics, vehicles, themes, write mode)
obd-engine.js     OBD engine: ELM327 protocol, PID decoding, DTCs, Mode 06/09, battery test,
                  read-only guard, Web Serial + Android-bridge transports, link quality, UDS reads
obd-demo.js       Simulated ELM327 + ECUs for ?demo= modes and testing
trips.js          Trip logbook, fuel model, GPS, fill-up calibration
driving.js        Driving coach (gear learning, clutch/shift/brake analysis, scores)
hood.js           Systems panel, cylinder health, CSS-3D fallback engine, gauge tilt
hood3d.js         WebGL 3D view (Three.js r160 via CDN import map)
hidden.js         Manufacturer-data explorer and custom PIDs
extras.js         Alerts, timers, report, CSV/JSON export, restore, Google Sheets sync
sw.js, manifest.json, icon*.png   Installable web app / offline cache
server.py         Laptop server (pyserial, COM port) + REST API used by the page and MCP
mcp_server/       Read-only MCP server for Claude
android/          Android app (WebView + native Bluetooth/print/share bridge, Java)
.github/workflows/android.yml   Builds and publishes the APK on every push
```
Run locally without a car: `python -m http.server 8766` in this folder, then open `http://localhost:8766/?demo=1`.

## Limitations

- Standard OBD covers the **engine and emissions** systems. ABS, airbag, body, cluster, TPMS and ADAS data and codes need the manufacturer's dealer tool. The Hidden data tab can read identification data and whatever you discover yourself.
- Fuel use, mileage, gear and clutch analysis, battery % and health are **estimates** derived from engine data.
- Bluetooth range is roughly 5–10 m, and only one app or device can use the adapter at a time.
- Not affiliated with Hyundai or any vehicle maker. Use at your own risk, and don't operate the app while driving.
