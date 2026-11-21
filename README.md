# Creta OBD

A read-only-by-default OBD-II dashboard for the Hyundai Creta (works with most petrol cars on CAN), using a cheap Bluetooth ELM327 adapter.

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
- Demo mode: open with `?demo=1` (or `?demo=dtc` for simulated fault codes)

## Safety
Only OBD read services (01 02 03 06 07 09 0A) and info AT commands can be sent. The single write, Mode 04 (clear codes), needs write mode armed by the user + typed confirmation + engine off, and disarms after one use. Everything else (UDS writes, resets, coding, flashing) is blocked.
