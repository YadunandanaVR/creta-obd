"""
OBD Dashboard MCP server: lets Claude (Claude Code / Claude Desktop) read your car's data.

It talks to the laptop dashboard server (server.py, http://127.0.0.1:8765), which owns the
Bluetooth COM port, so the dashboard and Claude can be used at the same time.

READ-ONLY: there is deliberately no tool that clears codes or writes anything to the car.
Clearing codes stays a user-only action in the dashboard's write mode.

Run:   python server.py COM4          (in obd_dashboard/)  then Claude starts this file over stdio.
Env:   OBD_URL  (default http://127.0.0.1:8765)
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

BASE = os.environ.get("OBD_URL", "http://127.0.0.1:8765").rstrip("/")
RO = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)

server = MCPServer(
    name="car-obd",
    title="Car OBD-II (read-only)",
    instructions=("Read live engine data, trouble codes, readiness, battery health and recorded trips from the user's car "
                  "through the OBD Dashboard server running on this laptop. All tools are read-only. If a tool says the "
                  "dashboard is offline, ask the user to run `python server.py COM4` in the obd_dashboard folder with the "
                  "car's ignition on. Never suggest clearing codes as a fix; explain causes instead."),
)

SYS = {"0": "fuel & air metering", "1": "fuel & air metering", "2": "injector circuit", "3": "ignition / misfire",
       "4": "auxiliary emissions", "5": "speed, idle & inputs", "6": "computer & outputs", "7": "transmission",
       "8": "transmission", "9": "transmission", "A": "hybrid propulsion", "B": "hybrid propulsion", "C": "hybrid propulsion"}


def _get(path: str, timeout: float = 4.0) -> dict:
    try:
        with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        raise RuntimeError(f"The OBD dashboard server isn't reachable at {BASE} ({e}). "
                           "Start it with `python server.py COM4` in the obd_dashboard folder.") from None


def _post(path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(BASE + path, data=json.dumps(body or {}).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "X-OBD-Client": "dashboard"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))


def _state() -> dict:
    s = _get("/api/state")
    if not s.get("connected"):
        raise RuntimeError(f"The dashboard is running but not connected to the car: {s.get('error') or 'unknown'}. "
                           "Check the ignition is ON and the adapter is plugged in.")
    return s


def _dtc_area(code: str) -> str:
    generic = code[1] in "02"
    area = SYS.get(code[2], "unknown") if code[0] == "P" else {"C": "chassis", "B": "body", "U": "network"}.get(code[0], "unknown")
    return f"{'generic' if generic else 'manufacturer-specific'} {area} code"


@server.tool(annotations=RO)
def car_status() -> dict:
    """Connection status and a one-glance health summary: adapter, protocol, VIN, battery voltage,
    check-engine light, number of trouble codes, engine running or not."""
    s = _get("/api/state")
    d, r, live = s.get("dtc") or {}, s.get("readiness") or {}, s.get("live") or {}
    rpm = (live.get("0C") or {}).get("value")
    return {"connected": s.get("connected"), "error": s.get("error") or None, "adapter": (s.get("info") or {}).get("adapter"),
            "protocol": (s.get("info") or {}).get("protocol"), "vin": (s.get("info") or {}).get("vin"),
            "battery_v": s.get("voltage"), "engine_running": bool(rpm and rpm > 300), "rpm": rpm,
            "check_engine_light": r.get("mil"), "stored_codes": d.get("stored", []), "pending_codes": d.get("pending", []),
            "permanent_codes": d.get("permanent", [])}


@server.tool(annotations=RO)
def live_data(group: str | None = None) -> list[dict]:
    """All live engine parameters the car reports (name, value, unit, group, PID).
    Optional group filter: Engine, Temperatures, Fuel & Air, Oxygen sensors, Emissions, Electrical, Distance & Time, Status."""
    rows = sorted(_state().get("live", {}).values(), key=lambda v: (v["group"], v["pid"]))
    if group:
        rows = [v for v in rows if v["group"].lower() == group.lower()]
    return [{"pid": v["pid"], "name": v["name"], "value": v["value"], "unit": v["unit"], "group": v["group"]} for v in rows]


@server.tool(annotations=RO)
def trouble_codes() -> dict:
    """Stored, pending and permanent diagnostic trouble codes (DTCs) with their category, plus the freeze frame."""
    s = _state()
    d = s.get("dtc") or {}
    out = {k: [{"code": c, "category": _dtc_area(c)} for c in d.get(k, [])] for k in ("stored", "pending", "permanent")}
    out["check_engine_light"] = (s.get("readiness") or {}).get("mil")
    out["freeze_frame"] = s.get("freeze")
    out["scanned_at"] = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(d["updated"])) if d.get("updated") else None
    return out


@server.tool(annotations=RO)
def readiness_monitors() -> dict:
    """Emissions self-test (readiness monitor) status: which tests are complete. All ready means PUC / emissions-test ready."""
    return _state().get("readiness") or {}


@server.tool(annotations=RO)
def vehicle_info() -> dict:
    """VIN, engine ECU name, calibration ID / CVN, protocol, responding ECUs and supported PIDs."""
    return _state().get("info") or {}


@server.tool(annotations=RO)
def battery_health() -> dict:
    """12 V battery: current voltage, recent voltage history (engine on/off) and past cranking-test results."""
    s = _get("/api/state")
    return {"voltage_now": s.get("voltage"), "recent_samples": [{"t": v[0], "volts": v[1], "engine_running": bool(v[2])} for v in (s.get("vhist") or [])[-60:]],
            "cranking_tests": s.get("bat_tests") or []}


@server.tool(annotations=RO)
def onboard_test_results() -> dict:
    """The ECU's own monitor test results (OBD Mode 06): each test's value, limits and pass/fail.
    Takes a few seconds because it reads them from the car."""
    _state()
    _post("/api/mode06")
    for _ in range(30):
        time.sleep(0.5)
        s = _get("/api/state")
        if not s.get("mode06_busy") and s.get("mode06"):
            m = s["mode06"]
            return {"tests": m.get("tests", []), "failing": [t for t in m.get("tests", []) if not t.get("pass")], "note": m.get("note")}
    return {"error": "Timed out waiting for the car"}


@server.tool(annotations=RO)
def trips(limit: int = 10) -> list[dict]:
    """Recent trips recorded by the dashboard on this laptop: date, distance, duration, fuel, mileage (km/L), cost, top speed, max engine temp."""
    ts = _get("/api/trips").get("trips", [])[-max(1, min(limit, 100)):]
    keep = ("id", "vehName", "start", "end", "distKm", "durS", "fuelL", "kmpl", "cost", "currency", "topSpeed", "avgSpeed", "maxRpm",
            "maxTemp", "idleS", "hardAccel", "hardBrake", "startLoc", "endLoc", "newCodes", "fuelSource")
    return [{k: t.get(k) for k in keep} for t in reversed(ts)]


@server.tool(annotations=RO)
def trip_details(trip_id: str) -> dict:
    """Full detail for one trip, including the speed / RPM / temperature series and GPS route."""
    for t in _get("/api/trips").get("trips", []):
        if t.get("id") == trip_id:
            return t
    return {"error": f"No trip with id {trip_id}"}


if __name__ == "__main__":
    server.run("stdio")
