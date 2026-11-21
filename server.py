"""
Creta OBD dashboard server.

Talks to a Bluetooth ELM327 adapter (serial over Bluetooth / COMx) and serves
a local web dashboard on http://127.0.0.1:8765.

SAFETY MODEL
  * The server starts in READ-ONLY mode and every command sent to the adapter
    passes through `guard()`, which only allows read services
    (01, 02, 03, 07, 09, 0A) and a small set of adapter AT commands.
  * The ONLY write supported is OBD Mode 04 (clear trouble codes / reset MIL).
    It is never sent automatically. It requires the user to (1) arm write mode
    in the UI with a typed confirmation, (2) press "Clear codes" and type a
    second confirmation, while (3) the engine is not running. Write mode
    disarms itself after one action or 120 seconds.
  * Every write attempt is appended to write_log.txt.

Run:  python server.py [COM4]
"""
import json, os, re, sys, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

import serial  # pyserial

import secrets, socket
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
LAN = "--lan" in sys.argv        # also serve phones on the same Wi-Fi (private key required)
PORT_NAME = ARGS[0] if ARGS else "COM4"
HTTP_PORT = 8765
HERE = os.path.dirname(os.path.abspath(__file__))
WRITE_WINDOW_S = 120

# ---------------------------------------------------------------- decoders
def u16(d): return d[0] * 256 + d[1]
def trim(d): return (d[0] - 128) * 100 / 128
def pct(d): return d[0] * 100 / 255
def temp(d): return d[0] - 40

FUEL_SYS = {0: "Off", 1: "Open loop (cold)", 2: "Closed loop", 4: "Open loop (load/decel)",
            8: "Open loop (fault)", 16: "Closed loop (fault)"}
FUEL_TYPES = ["Not available", "Petrol", "Methanol", "Ethanol", "Diesel", "LPG", "CNG", "Propane",
              "Electric", "Bifuel petrol", "Bifuel methanol", "Bifuel ethanol", "Bifuel LPG",
              "Bifuel CNG", "Bifuel propane", "Bifuel electric", "Bifuel elec/combustion",
              "Hybrid petrol", "Hybrid ethanol", "Hybrid diesel", "Hybrid electric",
              "Hybrid elec/combustion", "Hybrid regenerative", "Bifuel diesel"]
OBD_STD = {1: "OBD-II (CARB)", 2: "OBD (EPA)", 3: "OBD and OBD-II", 4: "OBD-I", 5: "Not OBD compliant",
           6: "EOBD (Europe)", 7: "EOBD and OBD-II", 8: "EOBD and OBD", 9: "EOBD, OBD and OBD II",
           10: "JOBD (Japan)", 11: "JOBD and OBD II", 12: "JOBD and EOBD", 13: "JOBD, EOBD, OBD II",
           17: "EMD", 18: "EMD+", 19: "HD OBD-C", 20: "HD OBD", 21: "WWH OBD", 23: "HD EOBD-I",
           24: "HD EOBD-I N", 25: "HD EOBD-II", 26: "HD EOBD-II N", 28: "OBDBr-1", 29: "OBDBr-2",
           30: "KOBD (Korea)", 31: "IOBD I (India)", 32: "IOBD II (India)", 33: "HD EOBD-IV"}

def o2_names(): return [f"B{b}S{s}" for b in (1, 2) for s in (1, 2, 3, 4)]

def dec_o2present(d):
    names = [n for i, n in enumerate(o2_names()) if d[0] & (1 << i)]
    return ", ".join(names) or "none"

def dec_monitor_short(d):
    return f"MIL {'ON' if d[0] & 0x80 else 'OFF'}, {d[0] & 0x7F} code(s)"

# pid: (name, unit, group, nbytes, decoder)
PIDS = {
    0x01: ("Monitor status since codes cleared", "", "Status", 4, dec_monitor_short),
    0x03: ("Fuel system status", "", "Fuel & Air", 2, lambda d: FUEL_SYS.get(d[0], f"0x{d[0]:02X}")),
    0x04: ("Calculated engine load", "%", "Engine", 1, pct),
    0x05: ("Coolant temperature", "°C", "Temperatures", 1, temp),
    0x06: ("Short-term fuel trim (Bank 1)", "%", "Fuel & Air", 1, trim),
    0x07: ("Long-term fuel trim (Bank 1)", "%", "Fuel & Air", 1, trim),
    0x08: ("Short-term fuel trim (Bank 2)", "%", "Fuel & Air", 1, trim),
    0x09: ("Long-term fuel trim (Bank 2)", "%", "Fuel & Air", 1, trim),
    0x0A: ("Fuel pressure", "kPa", "Fuel & Air", 1, lambda d: 3 * d[0]),
    0x0B: ("Intake manifold pressure (MAP)", "kPa", "Fuel & Air", 1, lambda d: d[0]),
    0x0C: ("Engine RPM", "rpm", "Engine", 2, lambda d: u16(d) / 4),
    0x0D: ("Vehicle speed", "km/h", "Engine", 1, lambda d: d[0]),
    0x0E: ("Ignition timing advance", "°", "Engine", 1, lambda d: d[0] / 2 - 64),
    0x0F: ("Intake air temperature", "°C", "Temperatures", 1, temp),
    0x10: ("Mass air flow (MAF)", "g/s", "Fuel & Air", 2, lambda d: u16(d) / 100),
    0x11: ("Throttle position", "%", "Engine", 1, pct),
    0x12: ("Secondary air status", "", "Emissions", 1, lambda d: f"0x{d[0]:02X}"),
    0x13: ("O2 sensors present", "", "Oxygen sensors", 1, dec_o2present),
    0x1C: ("OBD standard", "", "Status", 1, lambda d: OBD_STD.get(d[0], f"type {d[0]}")),
    0x1E: ("Auxiliary input (PTO)", "", "Status", 1, lambda d: "active" if d[0] & 1 else "inactive"),
    0x1F: ("Run time since engine start", "s", "Distance & Time", 2, u16),
    0x21: ("Distance with check-engine light on", "km", "Distance & Time", 2, u16),
    0x22: ("Fuel rail pressure (rel. manifold)", "kPa", "Fuel & Air", 2, lambda d: 0.079 * u16(d)),
    0x23: ("Fuel rail gauge pressure", "kPa", "Fuel & Air", 2, lambda d: 10 * u16(d)),
    0x2C: ("Commanded EGR", "%", "Emissions", 1, pct),
    0x2D: ("EGR error", "%", "Emissions", 1, trim),
    0x2E: ("Commanded evaporative purge", "%", "Emissions", 1, pct),
    0x2F: ("Fuel tank level", "%", "Fuel & Air", 1, pct),
    0x30: ("Warm-ups since codes cleared", "", "Distance & Time", 1, lambda d: d[0]),
    0x31: ("Distance since codes cleared (ECU counter, not odometer)", "km", "Distance & Time", 2, u16),
    0x32: ("Evap system vapour pressure", "Pa", "Emissions", 2,
           lambda d: (u16(d) - 65536 if u16(d) > 32767 else u16(d)) / 4),
    0x33: ("Barometric pressure", "kPa", "Fuel & Air", 1, lambda d: d[0]),
    0x3C: ("Catalyst temperature B1S1", "°C", "Temperatures", 2, lambda d: u16(d) / 10 - 40),
    0x3D: ("Catalyst temperature B2S1", "°C", "Temperatures", 2, lambda d: u16(d) / 10 - 40),
    0x3E: ("Catalyst temperature B1S2", "°C", "Temperatures", 2, lambda d: u16(d) / 10 - 40),
    0x3F: ("Catalyst temperature B2S2", "°C", "Temperatures", 2, lambda d: u16(d) / 10 - 40),
    0x41: ("Monitor status this drive cycle", "", "Status", 4, lambda d: "see Readiness"),
    0x42: ("ECU supply voltage", "V", "Electrical", 2, lambda d: u16(d) / 1000),
    0x43: ("Absolute engine load", "%", "Engine", 2, lambda d: u16(d) * 100 / 255),
    0x44: ("Commanded air-fuel ratio (λ)", "λ", "Fuel & Air", 2, lambda d: u16(d) * 2 / 65536),
    0x45: ("Relative throttle position", "%", "Engine", 1, pct),
    0x46: ("Ambient air temperature", "°C", "Temperatures", 1, temp),
    0x47: ("Absolute throttle position B", "%", "Engine", 1, pct),
    0x48: ("Absolute throttle position C", "%", "Engine", 1, pct),
    0x49: ("Accelerator pedal position D", "%", "Engine", 1, pct),
    0x4A: ("Accelerator pedal position E", "%", "Engine", 1, pct),
    0x4B: ("Accelerator pedal position F", "%", "Engine", 1, pct),
    0x4C: ("Commanded throttle actuator", "%", "Engine", 1, pct),
    0x4D: ("Time run with check-engine light on", "min", "Distance & Time", 2, u16),
    0x4E: ("Time since codes cleared", "min", "Distance & Time", 2, u16),
    0x51: ("Fuel type", "", "Status", 1, lambda d: FUEL_TYPES[d[0]] if d[0] < len(FUEL_TYPES) else d[0]),
    0x52: ("Ethanol fuel %", "%", "Fuel & Air", 1, pct),
    0x53: ("Absolute evap system pressure", "kPa", "Emissions", 2, lambda d: u16(d) / 200),
    0x55: ("Secondary O2 short-term trim (B1)", "%", "Oxygen sensors", 1, trim),
    0x56: ("Secondary O2 long-term trim (B1)", "%", "Oxygen sensors", 1, trim),
    0x57: ("Secondary O2 short-term trim (B2)", "%", "Oxygen sensors", 1, trim),
    0x58: ("Secondary O2 long-term trim (B2)", "%", "Oxygen sensors", 1, trim),
    0x59: ("Fuel rail absolute pressure", "kPa", "Fuel & Air", 2, lambda d: 10 * u16(d)),
    0x5A: ("Relative accelerator pedal position", "%", "Engine", 1, pct),
    0x5B: ("Hybrid battery remaining", "%", "Electrical", 1, pct),
    0x5C: ("Engine oil temperature", "°C", "Temperatures", 1, temp),
    0x5D: ("Fuel injection timing", "°", "Fuel & Air", 2, lambda d: u16(d) / 128 - 210),
    0x5E: ("Engine fuel rate", "L/h", "Fuel & Air", 2, lambda d: u16(d) / 20),
    0x61: ("Driver's demand torque", "%", "Engine", 1, lambda d: d[0] - 125),
    0x62: ("Actual engine torque", "%", "Engine", 1, lambda d: d[0] - 125),
    0x63: ("Engine reference torque", "Nm", "Engine", 2, u16),
    0x67: ("Coolant temperature", "°C", "Temperatures", 3,
           lambda d: d[1] - 40 if d[0] & 1 else (d[2] - 40 if d[0] & 2 else None)),
    0x68: ("Intake air temperature (sensor 1)", "°C", "Temperatures", 3,
           lambda d: d[1] - 40 if d[0] & 1 else None),
    0x5F: ("Emission requirements", "", "Status", 1, lambda d: f"type {d[0]}"),
    0xA6: ("Odometer", "km", "Distance & Time", 4,
           lambda d: (d[0] << 24 | d[1] << 16 | d[2] << 8 | d[3]) / 10),
}
for i, pid in enumerate(range(0x14, 0x1C)):
    PIDS[pid] = (f"O2 sensor {o2_names()[i]} voltage", "V", "Oxygen sensors", 2, lambda d: d[0] / 200)
for i, pid in enumerate(range(0x24, 0x2C)):
    PIDS[pid] = (f"O2 sensor {o2_names()[i]} lambda", "λ", "Oxygen sensors", 4, lambda d: u16(d) * 2 / 65536)
for i, pid in enumerate(range(0x34, 0x3C)):
    PIDS[pid] = (f"O2 sensor {o2_names()[i]} wideband λ", "λ", "Oxygen sensors", 4,
                 lambda d: u16(d) * 2 / 65536)

FAST = [0x0C, 0x0D, 0x04, 0x11, 0x0B, 0x0E, 0x10, 0x06]

# ---------------------------------------------- Mode 06 (on-board monitor test results)
MID_NAMES = {0x01: "O2 sensor monitor B1S1", 0x02: "O2 sensor monitor B1S2", 0x03: "O2 sensor monitor B1S3",
             0x04: "O2 sensor monitor B1S4", 0x05: "O2 sensor monitor B2S1", 0x06: "O2 sensor monitor B2S2",
             0x21: "Catalyst monitor Bank 1", 0x22: "Catalyst monitor Bank 2",
             0x31: "EGR monitor Bank 1", 0x32: "EGR monitor Bank 2", 0x35: "VVT monitor Bank 1", 0x36: "VVT monitor Bank 2",
             0x39: "EVAP monitor (0.150\" leak)", 0x3A: "EVAP monitor (0.090\" leak)", 0x3B: "EVAP monitor (0.040\" leak)",
             0x3C: "EVAP monitor (0.020\" leak)", 0x3D: "Purge flow monitor",
             0x41: "O2 heater monitor B1S1", 0x42: "O2 heater monitor B1S2", 0x45: "O2 heater monitor B2S1",
             0x61: "Heated catalyst monitor B1", 0x71: "Secondary air monitor 1", 0x81: "Fuel system monitor Bank 1",
             0x82: "Fuel system monitor Bank 2", 0x85: "Boost pressure monitor B1", 0xA1: "Misfire monitor (general)",
             0xB0: "PM filter monitor B1"}
for _c in range(1, 13):
    MID_NAMES[0xA1 + _c] = f"Misfire cylinder {_c}"
TID_NAMES = {0x01: "Rich→lean threshold voltage", 0x02: "Lean→rich threshold voltage", 0x03: "Low voltage for switch time",
             0x04: "High voltage for switch time", 0x05: "Rich→lean switch time", 0x06: "Lean→rich switch time",
             0x07: "Minimum sensor voltage", 0x08: "Maximum sensor voltage", 0x09: "Time between transitions",
             0x0A: "Sensor period", 0x0B: "Misfire count (avg of last 10 cycles)", 0x0C: "Misfire count (last/current cycle)"}
UAS = {0x01: ("", 1), 0x02: ("", .1), 0x03: ("", .01), 0x04: ("", .001), 0x05: ("", 3.05e-5), 0x06: ("", 3.05e-4),
       0x07: ("rpm", .25), 0x08: ("km/h", .01), 0x09: ("km/h", 1), 0x0A: ("mV", .122), 0x0B: ("V", .001),
       0x0C: ("V", .01), 0x0D: ("mA", .00390625), 0x0E: ("A", .001), 0x0F: ("A", .01), 0x10: ("ms", 1),
       0x11: ("ms", 100), 0x12: ("s", 1), 0x13: ("mΩ", 1), 0x14: ("Ω", 1), 0x15: ("kΩ", 1), 0x16: ("°C", .1, -40),
       0x17: ("kPa", .01), 0x18: ("kPa", .0117), 0x19: ("kPa", .079), 0x1A: ("kPa", 1), 0x1B: ("kPa", 10),
       0x1C: ("°", .01), 0x1D: ("°", .5), 0x1E: ("λ", 3.05e-5), 0x1F: ("AFR", .05), 0x20: ("ratio", .0039062),
       0x21: ("mHz", 1), 0x22: ("Hz", 1), 0x23: ("kHz", 1), 0x24: ("counts", 1), 0x25: ("km", 1),
       0x26: ("mV/ms", .1), 0x27: ("g/s", .01), 0x28: ("g/s", 1), 0x29: ("Pa/s", .25), 0x2A: ("kg/h", .001),
       0x2B: ("switches", 1), 0x2C: ("g/cyl", .01), 0x2D: ("mg/stroke", .01), 0x2E: ("", 1), 0x2F: ("%", .01),
       0x30: ("%", .001526), 0x31: ("L", .001), 0x34: ("min", 1), 0x35: ("ms", 10), 0x36: ("g", .01),
       0x37: ("g", .1), 0x38: ("g", 1),
       0x81: ("", 1), 0x82: ("", .1), 0x83: ("", .01), 0x84: ("", .001), 0x85: ("", 3.05e-5), 0x86: ("", 3.05e-4),
       0x8A: ("mV", .122), 0x8B: ("V", .001), 0x8C: ("V", .01), 0x8D: ("mA", .00390625), 0x8E: ("A", .001),
       0x90: ("ms", 1), 0x96: ("°C", .1), 0x99: ("kPa", .1), 0x9C: ("°", .01), 0x9D: ("°", .5), 0xA8: ("g/s", 1),
       0xA9: ("Pa/s", .25), 0xAD: ("mg/stroke", .01), 0xAE: ("mg/stroke", .1), 0xAF: ("%", .01),
       0xB0: ("%", .003052), 0xB1: ("mV/s", 2), 0xFC: ("kPa", .01), 0xFD: ("kPa", .001), 0xFE: ("Pa", .25)}
IUPR_NAMES = ["OBD monitoring conditions met", "Ignition cycles", "Catalyst B1 completions", "Catalyst B1 conditions",
              "Catalyst B2 completions", "Catalyst B2 conditions", "O2 sensor B1 completions", "O2 sensor B1 conditions",
              "O2 sensor B2 completions", "O2 sensor B2 conditions", "EGR/VVT completions", "EGR/VVT conditions",
              "Secondary air completions", "Secondary air conditions", "EVAP completions", "EVAP conditions",
              "Rear O2 B1 completions", "Rear O2 B1 conditions", "Rear O2 B2 completions", "Rear O2 B2 conditions"]

# 12 V lead-acid state of charge from open-circuit voltage
SOC_TABLE = [(11.30, 0), (11.51, 10), (11.66, 20), (11.81, 30), (11.96, 40), (12.10, 50), (12.24, 60),
             (12.37, 70), (12.50, 80), (12.62, 90), (12.73, 100)]

def soc_from_v(v):
    v += 0.10   # ignition-on load correction
    if v <= SOC_TABLE[0][0]: return 0
    if v >= SOC_TABLE[-1][0]: return 100
    for (v0, p0), (v1, p1) in zip(SOC_TABLE, SOC_TABLE[1:]):
        if v <= v1:
            return round(p0 + (v - v0) / (v1 - v0) * (p1 - p0))

def load_json(name, default):
    try:
        with open(os.path.join(HERE, name), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default

def save_json(name, obj):
    with open(os.path.join(HERE, name), "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=1)

# ------------------------------------------------------------- safety guard
SAFE_AT = {"ATZ", "ATWS", "ATE0", "ATL0", "ATS0", "ATS1", "ATH0", "ATH1", "ATSP0", "ATI", "AT@1",
           "ATRV", "ATDP", "ATDPN", "ATAT1", "ATAT2"}
READ_MODES = {"01", "02", "03", "06", "07", "09", "0A"}

class WriteBlocked(Exception):
    pass

def guard(cmd, allow_write=False):
    c = cmd.upper().replace(" ", "")
    if c.startswith("AT"):
        if c in SAFE_AT or re.fullmatch(r"ATST[0-9A-F]{2}", c):
            return c
        raise WriteBlocked(f"Adapter command '{c}' is not on the read-only allow-list")
    if not re.fullmatch(r"[0-9A-F]{2,14}", c):
        raise WriteBlocked("Only hex OBD requests are allowed")
    mode = c[:2]
    if mode in READ_MODES:
        return c
    if allow_write and c == "04":
        return c
    raise WriteBlocked(f"Service 0x{mode} is not a read service; blocked in read-only mode")

# ------------------------------------------------------------- ELM327 link
class ELM:
    def __init__(self, port):
        self.port = port
        self.ser = None
        self.lock = threading.RLock()
        self.connected = False
        self.error = "starting"
        self.info = {}
        self.supported = set()
        self.live = {}           # pid -> dict
        self.voltage = None
        self.dtc = {"stored": [], "pending": [], "permanent": [], "updated": None}
        self.readiness = None
        self.freeze = None
        self.last_ok = 0
        self.write_until = 0
        self.history = []
        self.vhist = []                       # (t, volts) every ~3 s
        self.mode06 = None; self.mode06_req = False
        self.iupr = None
        self.bat_tests = load_json("battery_tests.json", [])
        self.bat_req = False; self.bat_live = None
        self.settings = load_json("settings.json", {})

    # low level -----------------------------------------------------------
    def _io(self, cmd, timeout=4.0):
        s = self.ser
        s.reset_input_buffer()
        s.write((cmd + "\r").encode())
        buf, t0 = b"", time.time()
        while time.time() - t0 < timeout:
            d = s.read(s.in_waiting or 1)
            if d:
                buf += d
                if b">" in buf:
                    break
        txt = buf.decode(errors="ignore").replace(">", "")
        lines = [l.strip() for l in re.split(r"[\r\n]+", txt) if l.strip()]
        lines = [l for l in lines if l.replace(" ", "").upper() != cmd and l != "SEARCHING..."]
        return lines

    def send(self, cmd, timeout=4.0, allow_write=False):
        c = guard(cmd, allow_write)
        with self.lock:
            if not self.ser:
                raise IOError("adapter not connected")
            try:
                lines = self._io(c, timeout)
            except (serial.SerialException, OSError) as e:
                self._drop(str(e))
                raise
        self.last_ok = time.time()
        return lines

    def _drop(self, why):
        self.connected = False
        self.error = why
        try:
            self.ser and self.ser.close()
        except Exception:
            pass
        self.ser = None

    def connect(self):
        self.error = f"opening {self.port}"
        self.ser = serial.Serial(self.port, 38400, timeout=0.5)
        for c in ["ATZ", "ATE0", "ATL0", "ATS0", "ATH0", "ATAT1", "ATSP0"]:
            self.send(c, 3)
        r = self.send("0100", 12)
        if not any(l.replace(" ", "").startswith("4100") for l in r):
            raise IOError("car not responding (" + " ".join(r) + ") - is ignition ON?")
        self.connected, self.error = True, ""
        self.info["adapter"] = " ".join(self.send("ATI"))
        self.info["protocol"] = " ".join(self.send("ATDP")).replace("AUTO,", "")
        self._load_supported()
        self._load_vehicle()

    # parsing ---------------------------------------------------------------
    @staticmethod
    def hexjoin(lines):
        """Join a (possibly multi-frame CAN) response into one hex string per message."""
        msgs, cur = [], ""
        for l in lines:
            l = l.replace(" ", "").upper()
            if re.fullmatch(r"[0-9A-F]{3}", l):        # ISO-TP length line
                if cur: msgs.append(cur)
                cur = ""
                continue
            m = re.fullmatch(r"([0-9A-F]):([0-9A-F]+)", l)
            if m:
                cur += m.group(2)
                continue
            if re.fullmatch(r"[0-9A-F]+", l):
                if cur: msgs.append(cur); cur = ""
                msgs.append(l)
        if cur: msgs.append(cur)
        return msgs

    def query_pid(self, pid, mode="01", frame=""):
        lines = self.send(f"{mode}{pid:02X}{frame}", 2.5)
        want = f"{int(mode, 16) + 0x40:02X}{pid:02X}" + frame
        for m in self.hexjoin(lines):
            if m.startswith(want):
                return [int(m[i:i + 2], 16) for i in range(len(want), len(m), 2)]
        return None

    def _load_supported(self):
        sup, base = set(), 0
        while True:
            d = self.query_pid(base)
            if not d or len(d) < 4:
                break
            mask = (d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]
            for i in range(32):
                if mask & (1 << (31 - i)):
                    sup.add(base + i + 1)
            if not (mask & 1) or base >= 0xC0:
                break
            base += 0x20
        self.supported = {p for p in sup if p % 0x20 != 0}
        self.info["supported_pids"] = sorted(self.supported)

    def _mode09(self, pid):
        lines = self.send(f"09{pid:02X}", 4)
        for m in self.hexjoin(lines):
            if m.startswith(f"49{pid:02X}"):
                return bytes.fromhex(m[6:]) if len(m) > 6 else b""   # skip count byte
        return None

    def _load_vehicle(self):
        def ascii(b): return re.sub(r"[^\x20-\x7E]", "", b.decode("latin1")).strip("- ") if b else None
        v = self._mode09(0x02); self.info["vin"] = ascii(v)
        v = self._mode09(0x0A); self.info["ecu_name"] = ascii(v)
        v = self._mode09(0x04); self.info["calibration_id"] = ascii(v)
        v = self._mode09(0x06); self.info["cvn"] = v.hex().upper() if v else None
        # Which ECUs answer generic OBD requests?
        try:
            self.send("ATH1")
            r = self.send("0100", 4)
            self.info["ecus"] = sorted({l.replace(" ", "")[:3] for l in r if re.match(r"^7E[89A-F]", l.replace(" ", ""))})
        finally:
            self.send("ATH0")
        names = {"7E8": "Engine (ECM)", "7E9": "Transmission (TCM)", "7EA": "Hybrid/other", "7EB": "Other"}
        self.info["ecu_list"] = [f"{e} – {names.get(e, 'ECU')}" for e in self.info.get("ecus", [])]

    # dtcs ------------------------------------------------------------------
    @staticmethod
    def decode_dtc(h):
        v = int(h, 16)
        return "PCBU"[v >> 14] + str((v >> 12) & 3) + f"{v & 0xFFF:03X}"

    def read_dtcs(self, mode):
        lines = self.send(mode, 5)
        rsp = f"{int(mode, 16) + 0x40:02X}"
        codes = []
        for m in self.hexjoin(lines):
            if not m.startswith(rsp):
                continue
            body = m[4:]                     # CAN: byte after service id is the count
            for i in range(0, len(body) - 3, 4):
                if body[i:i + 4] != "0000":
                    codes.append(self.decode_dtc(body[i:i + 4]))
        return sorted(set(codes))

    def read_readiness(self):
        d = self.query_pid(0x01)
        if not d:
            return None
        a, b, c, e = d
        diesel = bool(b & 0x08)
        mons = []
        for i, n in enumerate(["Misfire", "Fuel system", "Components"]):
            if b & (1 << i):
                mons.append({"name": n, "ready": not (b & (1 << (i + 4)))})
        names = (["NMHC catalyst", "NOx/SCR", None, "Boost pressure", None, "Exhaust gas sensor", "PM filter", "EGR/VVT"]
                 if diesel else
                 ["Catalyst", "Heated catalyst", "Evaporative system", "Secondary air", None, "Oxygen sensor", "O2 sensor heater", "EGR/VVT"])
        for i, n in enumerate(names):
            if n and c & (1 << i):
                mons.append({"name": n, "ready": not (e & (1 << i))})
        return {"mil": bool(a & 0x80), "count": a & 0x7F, "ignition": "Compression (diesel)" if diesel else "Spark (petrol)",
                "monitors": mons}

    def read_freeze(self):
        d = self.query_pid(0x02, "02", "00")
        if not d or u16(d[:2]) == 0:
            return None
        out = {"dtc": self.decode_dtc(f"{u16(d[:2]):04X}"), "values": []}
        for pid in [0x04, 0x05, 0x67, 0x06, 0x07, 0x0B, 0x0C, 0x0D, 0x0F, 0x11, 0x03]:
            if pid in self.supported:
                try:
                    dd = self.query_pid(pid, "02", "00")
                    if dd:
                        out["values"].append(self.fmt(pid, dd))
                except WriteBlocked:
                    pass
        return out

    def refresh_diag(self):
        self.readiness = self.read_readiness()
        self.dtc = {"stored": self.read_dtcs("03"), "pending": self.read_dtcs("07"),
                    "permanent": self.read_dtcs("0A"), "updated": time.time()}
        self.freeze = self.read_freeze() if self.dtc["stored"] else None

    # Mode 06 on-board test results (read-only) ---------------------------------
    def read_mode06(self):
        mids, base = [], 0
        while base <= 0xE0:
            ms = self.hexjoin(self.send(f"06{base:02X}", 4))
            m = next((x for x in ms if x.startswith(f"46{base:02X}")), None)
            if not m or len(m) < 12:
                break
            mask = int(m[4:12], 16)
            mids += [base + i + 1 for i in range(32) if mask & (1 << (31 - i)) and (base + i + 1) % 0x20]
            if not mask & 1:
                break
            base += 0x20
        tests = []
        for mid in mids:
            for msg in self.hexjoin(self.send(f"06{mid:02X}", 4)):
                if not msg.startswith("46"):
                    continue
                body = bytes.fromhex(msg[2:])
                for i in range(0, len(body) - 8, 9):
                    r = body[i:i + 9]
                    if r[0] != mid:
                        continue
                    tid, uas = r[1], r[2]
                    raw = [r[3] << 8 | r[4], r[5] << 8 | r[6], r[7] << 8 | r[8]]
                    if uas >= 0x80:
                        raw = [x - 65536 if x > 32767 else x for x in raw]
                    unit, k, *off = UAS.get(uas, ("raw", 1))
                    o = off[0] if off else 0
                    val, lo, hi = [round(x * k + o, 4) for x in raw]
                    tests.append({"mid": f"{mid:02X}", "monitor": MID_NAMES.get(mid, f"Monitor 0x{mid:02X}"),
                                  "tid": f"{tid:02X}", "test": TID_NAMES.get(tid, f"Manufacturer test 0x{tid:02X}"),
                                  "value": val, "min": lo, "max": hi, "unit": unit,
                                  "pass": raw[1] <= raw[0] <= raw[2],
                                  # a limit at zero or at the data type's max is "open" (no real threshold)
                                  "lo_open": raw[1] == 0 or raw[1] <= -32000,
                                  "hi_open": raw[2] >= (0x7F00 if uas >= 0x80 else 0xFF00)})
        self.mode06 = {"t": time.time(), "mids": [f"{m:02X}" for m in mids], "tests": tests}

    def read_iupr(self):
        b = self._mode09(0x08)
        if not b:
            return
        vals = [b[i] << 8 | b[i + 1] for i in range(0, len(b) - 1, 2)]
        self.iupr = [{"name": IUPR_NAMES[i] if i < len(IUPR_NAMES) else f"Counter {i}", "value": v}
                     for i, v in enumerate(vals)]

    # Battery cranking test (read-only: it only samples ATRV fast) -------------
    def _volts(self):
        m = re.search(r"([\d.]+)V", " ".join(self.send("ATRV", 1)))
        return float(m.group(1)) if m else None

    def battery_test(self):
        rpm = self.query_pid(0x0C)
        if rpm and u16(rpm) / 4 > 300:
            self.bat_live = {"phase": "error", "msg": "Engine is already running. Switch it off, wait 1 minute, then run the test."}
            return
        t0, samples, crank_t = time.time(), [], None
        self.bat_live = {"phase": "rest", "msg": "Measuring resting voltage… don't start yet", "samples": samples}
        while time.time() - t0 < 30:
            v = self._volts()
            if v is None:
                continue
            t = round(time.time() - t0, 2)
            samples.append([t, v])
            rest = sorted(x[1] for x in samples[:12])[len(samples[:12]) // 2]
            if t > 3 and crank_t is None:
                self.bat_live["phase"] = "crank"; self.bat_live["msg"] = "START THE ENGINE NOW"
                if v < rest - 0.8:
                    crank_t = t
            if crank_t is not None:
                self.bat_live["phase"] = "after"; self.bat_live["msg"] = "Crank detected. Measuring recovery and charging…"
                if t - crank_t > 8:
                    break
        rest = sorted(x[1] for x in samples[:12])[len(samples[:12]) // 2] if samples else None
        vmin = min((x[1] for x in samples), default=None)
        tail = [x[1] for x in samples[-8:]]
        charging = round(sum(tail) / len(tail), 2) if tail else None
        res = {"t": time.time(), "rest": rest, "rest_soc": soc_from_v(rest) if rest else None,
               "crank_min": vmin, "crank_detected": crank_t is not None, "charging": charging, "notes": []}
        if crank_t is None:
            res["verdict"], res["score"] = "No crank detected", None
            res["notes"].append("The engine wasn't started during the 30 s window, so only resting voltage was measured.")
        else:
            res["score"] = max(0, min(100, round((vmin - 9.0) / (10.8 - 9.0) * 100)))
            res["verdict"] = ("Good" if vmin >= 10.5 else "Fair" if vmin >= 10.0 else
                              "Weak, test it soon" if vmin >= 9.6 else "Replace soon")
            if charging and charging < 13.0:
                res["notes"].append(f"Charging voltage {charging} V is low. The alternator may not be charging (or the smart alternator is resting).")
            if rest and soc_from_v(rest) < 60:
                res["notes"].append("Battery was under 60% charged, which makes the crank dip worse. Drive 30+ min or charge it, then re-test.")
        res["samples"] = samples
        self.bat_tests = (self.bat_tests + [res])[-20:]
        save_json("battery_tests.json", self.bat_tests)
        self.bat_live = {"phase": "done", "msg": res["verdict"], "samples": samples}

    # formatting --------------------------------------------------------------
    def fmt(self, pid, d):
        name, unit, group, n, fn = PIDS[pid]
        try:
            v = fn(d[:n]) if len(d) >= n else None
        except Exception:
            v = None
        if isinstance(v, float):
            v = round(v, 3 if unit in ("V", "λ") else 1)
        return {"pid": f"{pid:02X}", "name": name, "unit": unit, "group": group, "value": v, "t": time.time()}

    def poll_pid(self, pid):
        d = self.query_pid(pid)
        if d is not None and pid in PIDS:
            self.live[pid] = self.fmt(pid, d)

    # main loop ---------------------------------------------------------------
    def run(self):
        slow_idx, last_diag, last_v = 0, 0, 0
        while True:
            if not self.connected:
                try:
                    self.connect()
                    self.refresh_diag()
                    self.read_iupr()
                    last_diag = time.time()
                except Exception as e:
                    self._drop(str(e))
                    time.sleep(5)
                    continue
            try:
                if self.bat_req:
                    self.bat_req = False
                    try:
                        self.battery_test()
                    except Exception as e:
                        self.bat_live = {"phase": "error", "msg": str(e)}
                if self.mode06_req:
                    self.mode06_req = False
                    self.read_mode06(); self.read_iupr()
                fast = [p for p in FAST + [0x67 if 0x67 in self.supported else 0x05] if p in self.supported]
                slow = [p for p in sorted(self.supported) if p in PIDS and p not in fast]
                for p in fast:
                    self.poll_pid(p)
                for _ in range(2):
                    if slow:
                        self.poll_pid(slow[slow_idx % len(slow)]); slow_idx += 1
                if time.time() - last_v > 3:
                    r = self.send("ATRV", 2)
                    m = re.search(r"([\d.]+)V", " ".join(r))
                    self.voltage = float(m.group(1)) if m else None
                    last_v = time.time()
                    if self.voltage:
                        rp = self.live.get(0x0C, {}).get("value") or 0
                        self.vhist = (self.vhist + [[round(last_v), self.voltage, 1 if rp > 300 else 0]])[-1200:]
                if time.time() - last_diag > 20:
                    self.refresh_diag(); last_diag = time.time()
                self._record()
            except WriteBlocked:
                pass
            except Exception as e:
                if self.ser is None:
                    continue
                self.error = str(e)
                time.sleep(0.5)

    def _record(self):
        g = lambda p: self.live.get(p, {}).get("value")
        cool = g(0x67) if 0x67 in self.live else g(0x05)
        self.history.append({"t": round(time.time(), 1), "rpm": g(0x0C), "speed": g(0x0D),
                             "coolant": cool, "load": g(0x04), "throttle": g(0x11)})
        self.history = self.history[-600:]

    # write (user-initiated only) ---------------------------------------------
    def write_armed(self):
        return time.time() < self.write_until

    def clear_codes(self):
        if not self.write_armed():
            raise WriteBlocked("Write mode is not armed")
        rpm = self.query_pid(0x0C)
        if rpm and u16(rpm) / 4 > 50:
            raise WriteBlocked("Engine is running. Switch the engine OFF (ignition ON) before clearing codes.")
        before = {k: self.dtc.get(k) for k in ("stored", "pending", "permanent")}
        try:
            lines = self.send("04", 8, allow_write=True)
        finally:
            self.write_until = 0          # one action per arming
        ok = any(l.replace(" ", "").startswith("44") for l in lines)
        with open(os.path.join(HERE, "write_log.txt"), "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')}  MODE 04 clear codes  before={before}  "
                    f"response={lines}  ok={ok}\n")
        time.sleep(1)
        self.refresh_diag()
        return ok, lines


elm = ELM(PORT_NAME)
if not elm.settings.get("access_key"):
    elm.settings["access_key"] = secrets.token_urlsafe(12)
    save_json("settings.json", elm.settings)
KEY = elm.settings["access_key"]

def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))    # no packet is sent; just picks the Wi-Fi interface
        return s.getsockname()[0]
    except Exception:
        return None
    finally:
        s.close()

STATIC = {"obd-engine.js": "text/javascript", "obd-demo.js": "text/javascript", "sw.js": "text/javascript",
          "manifest.json": "application/manifest+json", "icon.svg": "image/svg+xml",
          "icon-192.png": "image/png", "icon-512.png": "image/png"}

# ------------------------------------------------------------------ HTTP API
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def _json(self, obj, code=200):
        b = json.dumps(obj, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)

    def _local(self):
        """Request from this laptop's own browser."""
        h = (self.headers.get("Host") or "").split(":")[0]
        return self.client_address[0] in ("127.0.0.1", "::1") and h in ("127.0.0.1", "localhost")

    def _cookie_key(self):
        m = re.search(r"(?:^|;\s*)obdkey=([\w-]+)", self.headers.get("Cookie") or "")
        return m.group(1) if m else None

    def _host_ok(self):
        """Laptop: always. Phone/other device: only with the private key."""
        if self._local():
            return True
        return LAN and secrets.compare_digest(self._cookie_key() or "", KEY)

    def _raw(self, body, ctype, extra=None):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        p, _, q = self.path.partition("?")
        qkey = re.search(r"(?:^|&)key=([\w-]+)", q)
        if LAN and not self._local() and qkey and secrets.compare_digest(qkey.group(1), KEY) and p in ("/", "/index.html"):
            # first visit from the phone's QR link: remember the key in a cookie and drop it from the URL
            self.send_response(302)
            self.send_header("Set-Cookie", f"obdkey={KEY}; Path=/; Max-Age=31536000; SameSite=Strict; HttpOnly")
            self.send_header("Location", "/"); self.end_headers(); return
        if p.lstrip("/") in STATIC:
            name = p.lstrip("/")
            return self._raw(open(os.path.join(HERE, name), "rb").read(), STATIC[name])
        if not self._host_ok():
            b = b"<h2 style='font-family:sans-serif'>Locked. Scan the QR code from the dashboard on the laptop (Phone button).</h2>"
            self.send_response(403); self.send_header("Content-Type", "text/html"); self.end_headers(); self.wfile.write(b); return
        if p in ("/", "/index.html"):
            return self._raw(open(os.path.join(HERE, "index.html"), "rb").read(), "text/html; charset=utf-8")
        if p == "/api/state":
            return self._json({
                "connected": elm.connected, "error": elm.error, "port": elm.port,
                "info": elm.info, "voltage": elm.voltage,
                "live": {f"{k:02X}": v for k, v in elm.live.items()},
                "dtc": elm.dtc, "readiness": elm.readiness, "freeze": elm.freeze,
                "write_armed": elm.write_armed(),
                "write_remaining": max(0, int(elm.write_until - time.time())),
                "history": elm.history[-240:], "now": time.time(),
                "vhist": elm.vhist[-400:], "mode06": elm.mode06, "mode06_busy": elm.mode06_req,
                "iupr": elm.iupr, "bat_live": elm.bat_live, "bat_busy": elm.bat_req,
                "bat_tests": [{k: v for k, v in t.items() if k != "samples"} for t in elm.bat_tests],
                "settings": {k: v for k, v in elm.settings.items() if k != "access_key"},
                "remote": not self._local(),
                "phone": ({"enabled": LAN, "url": f"http://{lan_ip()}:{HTTP_PORT}/?key={KEY}" if LAN and lan_ip() else None}
                          if self._local() else None)})
        if p == "/api/writelog":
            fp = os.path.join(HERE, "write_log.txt")
            return self._json({"log": open(fp, encoding="utf-8").read() if os.path.exists(fp) else ""})
        self._json({"error": "not found"}, 404)

    def do_POST(self):
        # Must come from our own page: custom header forces a CORS preflight,
        # which this server never approves, so other websites can't call it.
        if not self._host_ok() or self.headers.get("X-OBD-Client") != "dashboard":
            return self._json({"error": "forbidden"}, 403)
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            body = {}
        p = self.path
        if p in ("/api/mode", "/api/clear-dtc") and not self._local():
            return self._json({"ok": False, "error": "Write actions can only be done from the laptop, not from a phone."}, 403)
        try:
            if p == "/api/refresh":
                elm.refresh_diag(); return self._json({"ok": True})
            if p == "/api/mode06":
                elm.mode06_req = True; return self._json({"ok": True})
            if p == "/api/battery-test":
                if elm.bat_live and elm.bat_live.get("phase") in ("rest", "crank", "after"):
                    return self._json({"ok": False, "error": "A test is already running"}, 409)
                elm.bat_live = {"phase": "queued", "msg": "Starting…", "samples": []}
                elm.bat_req = True; return self._json({"ok": True})
            if p == "/api/settings":
                allowed = {"odo_ref_km", "ecu_ref_km", "odo_set_at"}
                elm.settings.update({k: v for k, v in body.items() if k in allowed})
                save_json("settings.json", elm.settings)
                return self._json({"ok": True})
            if p == "/api/console":
                lines = elm.send(str(body.get("cmd", "")), 5)
                return self._json({"ok": True, "lines": lines})
            if p == "/api/mode":
                if body.get("mode") == "write":
                    if body.get("confirm") != "ENABLE WRITE":
                        return self._json({"ok": False, "error": "Confirmation text did not match"}, 400)
                    elm.write_until = time.time() + WRITE_WINDOW_S
                else:
                    elm.write_until = 0
                return self._json({"ok": True, "write_armed": elm.write_armed()})
            if p == "/api/clear-dtc":
                if body.get("confirm") != "CLEAR":
                    return self._json({"ok": False, "error": "Confirmation text did not match"}, 400)
                ok, lines = elm.clear_codes()
                return self._json({"ok": ok, "lines": lines})
        except WriteBlocked as e:
            return self._json({"ok": False, "error": str(e)}, 403)
        except Exception as e:
            return self._json({"ok": False, "error": str(e)}, 500)
        self._json({"error": "not found"}, 404)


if __name__ == "__main__":
    threading.Thread(target=elm.run, daemon=True).start()
    print(f"OBD dashboard on http://127.0.0.1:{HTTP_PORT}  (adapter {PORT_NAME}, READ-ONLY by default)")
    if LAN:
        print(f"Phone access ON: open the dashboard on this laptop and press 'Phone' for the QR code ({lan_ip()})")
    ThreadingHTTPServer(("0.0.0.0" if LAN else "127.0.0.1", HTTP_PORT), H).serve_forever()
