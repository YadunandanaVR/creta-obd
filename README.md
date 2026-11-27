# OBD Dashboard (creta-obd)

A read-only-by-default OBD-II dashboard for **cars, motorcycles and scooters**, using a cheap Bluetooth ELM327 adapter. It started as a Hyundai Creta dashboard.

- **Cars:** any OBD-II / EOBD / BS-IV+ vehicle (petrol about 2001+, diesel about 2004+). CAN, KWP2000, ISO 9141 and J1850 protocols, auto-detected or chosen per vehicle.
- **Bikes & scooters:** most BS6 / Euro 5 two-wheelers expose standard OBD, usually through a small adapter cable from the bike's own diagnostic plug to a 16-pin OBD socket. Some makers only allow their own tools.
- **My vehicles:** save several profiles (rev limit, idle range, gauge scales, protocol, odometer calibration). The app recognises a vehicle from its VIN and switches automatically.

## Use it on an Android phone (no laptop)
1. Pair the adapter: **Settings → Bluetooth → Pair new device → OBDII** (PIN `1234` or `0000`).
2. Plug it into the OBD port, ignition **ON**.
3. Open the app link in **Chrome (version 137+)**, tap **Connect**, pick **OBDII**.
4. Chrome menu ⋮ → **Add to Home screen / Install app**. It opens full-screen and works offline.

Chrome talks to the adapter directly with the Web Serial API over Bluetooth RFCOMM. iPhones can't use classic-Bluetooth ELM327 adapters.

## Use it on a Windows laptop
```
pip install pyserial
python server.py COM4
```
Then open http://127.0.0.1:8765.

## Features
- Gauges: RPM, speed, coolant, battery %; every supported live parameter, grouped, with "what is this / normal range" on hover or tap
- Trouble codes (stored / pending / permanent) with causes and fixes, freeze frame, readiness monitors
- On-board monitor test results (Mode 06), in-use performance counters
- Battery health: charge %, charging check, cranking test
- Symptom checker, live health checks, ECU distance → odometer calibration
- Demo mode: open with `?demo=1` (or `?demo=dtc` for simulated fault codes, `?demo=bike` for an air-cooled K-line motorcycle)

- Trips: automatic logbook (GPS start/end and route, distance, duration, fuel used, km/L, cost, top/avg speed, max temps, harsh driving), fill-up calibration
- Under the hood: live CSS-3D engine (pistons follow RPM, parts colour with temperature) + readings by system, cylinder health
- Hidden data: module scan + ISO 14229 ECU identification, data-ID scanner with live byte watch (finds bytes that follow RPM/speed/temp), custom PIDs
- Alerts (overheat, battery, charging, red zone, speed, new codes), 0–60 / 0–100 / 40–80 timers
- Export: printable / PDF health report, trips CSV, full JSON; optional Google Sheets backup through your own Apps Script

## Claude (MCP server)
`mcp_server/obd_mcp.py` exposes read-only tools (status, live data, codes, readiness, vehicle info, battery, on-board tests, trips) by talking to `server.py`.
Install `pip install mcp`, run `python server.py COM4`, and the `.mcp.json` in the parent folder registers it for Claude Code. There is intentionally no write tool.

## Safety
Only OBD read services (01 02 03 06 07 09 0A) and info AT commands can be sent. The single write, Mode 04 (clear codes), needs write mode armed by the user + typed confirmation + engine off, and disarms after one use. Everything else (UDS writes, resets, coding, flashing) is blocked.
