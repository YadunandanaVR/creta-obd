/* Creta OBD engine.
 *
 * Two ways for the dashboard to get data, with the same state shape:
 *   ServerEngine – talks to server.py on the laptop (/api/...)
 *   DirectEngine – talks straight to the ELM327 adapter from the browser using Web Serial
 *                  (Chrome on Android 137+ over Bluetooth SPP, or desktop Chrome on a COM port)
 *
 * SAFETY: every adapter command passes guard(). Only read services (01 02 03 06 07 09 0A)
 * and a short list of info AT commands are allowed. The single write, Mode 04 (clear codes),
 * needs write mode armed by the user + a typed confirmation + engine off, and disarms after use.
 */
(function () {
"use strict";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Date.now() / 1000;

// ------------------------------------------------------------------ decoders
const u16 = d => d[0] * 256 + d[1];
const trim = d => (d[0] - 128) * 100 / 128, pct = d => d[0] * 100 / 255, temp = d => d[0] - 40;
const FUEL_SYS = {0: "Off", 1: "Open loop (cold)", 2: "Closed loop", 4: "Open loop (load/decel)", 8: "Open loop (fault)", 16: "Closed loop (fault)"};
const FUEL_TYPES = ["Not available", "Petrol", "Methanol", "Ethanol", "Diesel", "LPG", "CNG", "Propane", "Electric",
  "Bifuel petrol", "Bifuel methanol", "Bifuel ethanol", "Bifuel LPG", "Bifuel CNG", "Bifuel propane", "Bifuel electric",
  "Bifuel elec/combustion", "Hybrid petrol", "Hybrid ethanol", "Hybrid diesel", "Hybrid electric", "Hybrid elec/combustion",
  "Hybrid regenerative", "Bifuel diesel"];
const OBD_STD = {1: "OBD-II (CARB)", 2: "OBD (EPA)", 3: "OBD and OBD-II", 4: "OBD-I", 5: "Not OBD compliant", 6: "EOBD (Europe)",
  7: "EOBD and OBD-II", 8: "EOBD and OBD", 9: "EOBD, OBD and OBD II", 10: "JOBD (Japan)", 11: "JOBD and OBD II", 12: "JOBD and EOBD",
  13: "JOBD, EOBD, OBD II", 17: "EMD", 18: "EMD+", 19: "HD OBD-C", 20: "HD OBD", 21: "WWH OBD", 23: "HD EOBD-I", 24: "HD EOBD-I N",
  25: "HD EOBD-II", 26: "HD EOBD-II N", 28: "OBDBr-1", 29: "OBDBr-2", 30: "KOBD (Korea)", 31: "IOBD I (India)", 32: "IOBD II (India)", 33: "HD EOBD-IV"};
const O2N = ["B1S1", "B1S2", "B1S3", "B1S4", "B2S1", "B2S2", "B2S3", "B2S4"];
const PIDS = {
  0x01: ["Monitor status since codes cleared", "", "Status", 4, d => `MIL ${d[0] & 0x80 ? "ON" : "OFF"}, ${d[0] & 0x7F} code(s)`],
  0x03: ["Fuel system status", "", "Fuel & Air", 2, d => FUEL_SYS[d[0]] ?? `0x${d[0].toString(16)}`],
  0x04: ["Calculated engine load", "%", "Engine", 1, pct],
  0x05: ["Coolant temperature", "°C", "Temperatures", 1, temp],
  0x06: ["Short-term fuel trim (Bank 1)", "%", "Fuel & Air", 1, trim],
  0x07: ["Long-term fuel trim (Bank 1)", "%", "Fuel & Air", 1, trim],
  0x08: ["Short-term fuel trim (Bank 2)", "%", "Fuel & Air", 1, trim],
  0x09: ["Long-term fuel trim (Bank 2)", "%", "Fuel & Air", 1, trim],
  0x0A: ["Fuel pressure", "kPa", "Fuel & Air", 1, d => 3 * d[0]],
  0x0B: ["Intake manifold pressure (MAP)", "kPa", "Fuel & Air", 1, d => d[0]],
  0x0C: ["Engine RPM", "rpm", "Engine", 2, d => u16(d) / 4],
  0x0D: ["Vehicle speed", "km/h", "Engine", 1, d => d[0]],
  0x0E: ["Ignition timing advance", "°", "Engine", 1, d => d[0] / 2 - 64],
  0x0F: ["Intake air temperature", "°C", "Temperatures", 1, temp],
  0x10: ["Mass air flow (MAF)", "g/s", "Fuel & Air", 2, d => u16(d) / 100],
  0x11: ["Throttle position", "%", "Engine", 1, pct],
  0x12: ["Secondary air status", "", "Emissions", 1, d => `0x${d[0].toString(16)}`],
  0x13: ["O2 sensors present", "", "Oxygen sensors", 1, d => O2N.filter((_, i) => d[0] & (1 << i)).join(", ") || "none"],
  0x1C: ["OBD standard", "", "Status", 1, d => OBD_STD[d[0]] ?? `type ${d[0]}`],
  0x1E: ["Auxiliary input (PTO)", "", "Status", 1, d => d[0] & 1 ? "active" : "inactive"],
  0x1F: ["Run time since engine start", "s", "Distance & Time", 2, u16],
  0x21: ["Distance with check-engine light on", "km", "Distance & Time", 2, u16],
  0x22: ["Fuel rail pressure (rel. manifold)", "kPa", "Fuel & Air", 2, d => 0.079 * u16(d)],
  0x23: ["Fuel rail gauge pressure", "kPa", "Fuel & Air", 2, d => 10 * u16(d)],
  0x2C: ["Commanded EGR", "%", "Emissions", 1, pct],
  0x2D: ["EGR error", "%", "Emissions", 1, trim],
  0x2E: ["Commanded evaporative purge", "%", "Emissions", 1, pct],
  0x2F: ["Fuel tank level", "%", "Fuel & Air", 1, pct],
  0x30: ["Warm-ups since codes cleared", "", "Distance & Time", 1, d => d[0]],
  0x31: ["Distance since codes cleared (ECU counter, not odometer)", "km", "Distance & Time", 2, u16],
  0x32: ["Evap system vapour pressure", "Pa", "Emissions", 2, d => { const v = u16(d); return (v > 32767 ? v - 65536 : v) / 4; }],
  0x33: ["Barometric pressure", "kPa", "Fuel & Air", 1, d => d[0]],
  0x3C: ["Catalyst temperature B1S1", "°C", "Temperatures", 2, d => u16(d) / 10 - 40],
  0x3D: ["Catalyst temperature B2S1", "°C", "Temperatures", 2, d => u16(d) / 10 - 40],
  0x3E: ["Catalyst temperature B1S2", "°C", "Temperatures", 2, d => u16(d) / 10 - 40],
  0x3F: ["Catalyst temperature B2S2", "°C", "Temperatures", 2, d => u16(d) / 10 - 40],
  0x41: ["Monitor status this drive cycle", "", "Status", 4, () => "see Readiness"],
  0x42: ["ECU supply voltage", "V", "Electrical", 2, d => u16(d) / 1000],
  0x43: ["Absolute engine load", "%", "Engine", 2, d => u16(d) * 100 / 255],
  0x44: ["Commanded air-fuel ratio (λ)", "λ", "Fuel & Air", 2, d => u16(d) * 2 / 65536],
  0x45: ["Relative throttle position", "%", "Engine", 1, pct],
  0x46: ["Ambient air temperature", "°C", "Temperatures", 1, temp],
  0x47: ["Absolute throttle position B", "%", "Engine", 1, pct],
  0x48: ["Absolute throttle position C", "%", "Engine", 1, pct],
  0x49: ["Accelerator pedal position D", "%", "Engine", 1, pct],
  0x4A: ["Accelerator pedal position E", "%", "Engine", 1, pct],
  0x4B: ["Accelerator pedal position F", "%", "Engine", 1, pct],
  0x4C: ["Commanded throttle actuator", "%", "Engine", 1, pct],
  0x4D: ["Time run with check-engine light on", "min", "Distance & Time", 2, u16],
  0x4E: ["Time since codes cleared", "min", "Distance & Time", 2, u16],
  0x51: ["Fuel type", "", "Status", 1, d => FUEL_TYPES[d[0]] ?? d[0]],
  0x52: ["Ethanol fuel %", "%", "Fuel & Air", 1, pct],
  0x53: ["Absolute evap system pressure", "kPa", "Emissions", 2, d => u16(d) / 200],
  0x55: ["Secondary O2 short-term trim (B1)", "%", "Oxygen sensors", 1, trim],
  0x56: ["Secondary O2 long-term trim (B1)", "%", "Oxygen sensors", 1, trim],
  0x57: ["Secondary O2 short-term trim (B2)", "%", "Oxygen sensors", 1, trim],
  0x58: ["Secondary O2 long-term trim (B2)", "%", "Oxygen sensors", 1, trim],
  0x59: ["Fuel rail absolute pressure", "kPa", "Fuel & Air", 2, d => 10 * u16(d)],
  0x5A: ["Relative accelerator pedal position", "%", "Engine", 1, pct],
  0x5B: ["Hybrid battery remaining", "%", "Electrical", 1, pct],
  0x5C: ["Engine oil temperature", "°C", "Temperatures", 1, temp],
  0x5D: ["Fuel injection timing", "°", "Fuel & Air", 2, d => u16(d) / 128 - 210],
  0x5E: ["Engine fuel rate", "L/h", "Fuel & Air", 2, d => u16(d) / 20],
  0x5F: ["Emission requirements", "", "Status", 1, d => `type ${d[0]}`],
  0x61: ["Driver's demand torque", "%", "Engine", 1, d => d[0] - 125],
  0x62: ["Actual engine torque", "%", "Engine", 1, d => d[0] - 125],
  0x63: ["Engine reference torque", "Nm", "Engine", 2, u16],
  0x67: ["Coolant temperature", "°C", "Temperatures", 3, d => d[0] & 1 ? d[1] - 40 : d[0] & 2 ? d[2] - 40 : null],
  0x68: ["Intake air temperature (sensor 1)", "°C", "Temperatures", 3, d => d[0] & 1 ? d[1] - 40 : null],
  0xA6: ["Odometer", "km", "Distance & Time", 4, d => ((d[0] << 24) + (d[1] << 16) + (d[2] << 8) + d[3]) / 10],
};
for (let i = 0; i < 8; i++) {
  PIDS[0x14 + i] = [`O2 sensor ${O2N[i]} voltage`, "V", "Oxygen sensors", 2, d => d[0] / 200];
  PIDS[0x24 + i] = [`O2 sensor ${O2N[i]} lambda`, "λ", "Oxygen sensors", 4, d => u16(d) * 2 / 65536];
  PIDS[0x34 + i] = [`O2 sensor ${O2N[i]} wideband λ`, "λ", "Oxygen sensors", 4, d => u16(d) * 2 / 65536];
}
const FAST = [0x0C, 0x0D, 0x04, 0x11, 0x0B, 0x0E, 0x10, 0x06];

// Mode 06 names / units
const MID_NAMES = {0x01: "O2 sensor monitor B1S1", 0x02: "O2 sensor monitor B1S2", 0x03: "O2 sensor monitor B1S3", 0x04: "O2 sensor monitor B1S4",
  0x05: "O2 sensor monitor B2S1", 0x06: "O2 sensor monitor B2S2", 0x21: "Catalyst monitor Bank 1", 0x22: "Catalyst monitor Bank 2",
  0x31: "EGR monitor Bank 1", 0x32: "EGR monitor Bank 2", 0x35: "VVT monitor Bank 1", 0x36: "VVT monitor Bank 2",
  0x39: "EVAP monitor (0.150\" leak)", 0x3A: "EVAP monitor (0.090\" leak)", 0x3B: "EVAP monitor (0.040\" leak)", 0x3C: "EVAP monitor (0.020\" leak)",
  0x3D: "Purge flow monitor", 0x41: "O2 heater monitor B1S1", 0x42: "O2 heater monitor B1S2", 0x45: "O2 heater monitor B2S1",
  0x61: "Heated catalyst monitor B1", 0x71: "Secondary air monitor 1", 0x81: "Fuel system monitor Bank 1", 0x82: "Fuel system monitor Bank 2",
  0x85: "Boost pressure monitor B1", 0xA1: "Misfire monitor (general)", 0xB0: "PM filter monitor B1"};
for (let c = 1; c <= 12; c++) MID_NAMES[0xA1 + c] = `Misfire cylinder ${c}`;
const TID_NAMES = {1: "Rich→lean threshold voltage", 2: "Lean→rich threshold voltage", 3: "Low voltage for switch time", 4: "High voltage for switch time",
  5: "Rich→lean switch time", 6: "Lean→rich switch time", 7: "Minimum sensor voltage", 8: "Maximum sensor voltage", 9: "Time between transitions",
  10: "Sensor period", 11: "Misfire count (avg of last 10 cycles)", 12: "Misfire count (last/current cycle)"};
const UAS = {0x01: ["", 1], 0x02: ["", .1], 0x03: ["", .01], 0x04: ["", .001], 0x05: ["", 3.05e-5], 0x06: ["", 3.05e-4], 0x07: ["rpm", .25],
  0x08: ["km/h", .01], 0x09: ["km/h", 1], 0x0A: ["mV", .122], 0x0B: ["V", .001], 0x0C: ["V", .01], 0x0D: ["mA", .00390625], 0x0E: ["A", .001],
  0x0F: ["A", .01], 0x10: ["ms", 1], 0x11: ["ms", 100], 0x12: ["s", 1], 0x13: ["mΩ", 1], 0x14: ["Ω", 1], 0x15: ["kΩ", 1], 0x16: ["°C", .1, -40],
  0x17: ["kPa", .01], 0x18: ["kPa", .0117], 0x19: ["kPa", .079], 0x1A: ["kPa", 1], 0x1B: ["kPa", 10], 0x1C: ["°", .01], 0x1D: ["°", .5],
  0x1E: ["λ", 3.05e-5], 0x1F: ["AFR", .05], 0x20: ["ratio", .0039062], 0x21: ["mHz", 1], 0x22: ["Hz", 1], 0x23: ["kHz", 1], 0x24: ["counts", 1],
  0x25: ["km", 1], 0x26: ["mV/ms", .1], 0x27: ["g/s", .01], 0x28: ["g/s", 1], 0x29: ["Pa/s", .25], 0x2A: ["kg/h", .001], 0x2B: ["switches", 1],
  0x2C: ["g/cyl", .01], 0x2D: ["mg/stroke", .01], 0x2E: ["", 1], 0x2F: ["%", .01], 0x30: ["%", .001526], 0x31: ["L", .001], 0x34: ["min", 1],
  0x35: ["ms", 10], 0x36: ["g", .01], 0x37: ["g", .1], 0x38: ["g", 1],
  0x81: ["", 1], 0x82: ["", .1], 0x83: ["", .01], 0x84: ["", .001], 0x85: ["", 3.05e-5], 0x86: ["", 3.05e-4], 0x8A: ["mV", .122], 0x8B: ["V", .001],
  0x8C: ["V", .01], 0x8D: ["mA", .00390625], 0x8E: ["A", .001], 0x90: ["ms", 1], 0x96: ["°C", .1], 0x99: ["kPa", .1], 0x9C: ["°", .01],
  0x9D: ["°", .5], 0xA8: ["g/s", 1], 0xA9: ["Pa/s", .25], 0xAD: ["mg/stroke", .01], 0xAE: ["mg/stroke", .1], 0xAF: ["%", .01], 0xB0: ["%", .003052],
  0xB1: ["mV/s", 2], 0xFC: ["kPa", .01], 0xFD: ["kPa", .001], 0xFE: ["Pa", .25]};
const IUPR_NAMES = ["OBD monitoring conditions met", "Ignition cycles", "Catalyst B1 completions", "Catalyst B1 conditions",
  "Catalyst B2 completions", "Catalyst B2 conditions", "O2 sensor B1 completions", "O2 sensor B1 conditions",
  "O2 sensor B2 completions", "O2 sensor B2 conditions", "EGR/VVT completions", "EGR/VVT conditions",
  "Secondary air completions", "Secondary air conditions", "EVAP completions", "EVAP conditions",
  "Rear O2 B1 completions", "Rear O2 B1 conditions", "Rear O2 B2 completions", "Rear O2 B2 conditions"];
const SOC_TABLE = [[11.30, 0], [11.51, 10], [11.66, 20], [11.81, 30], [11.96, 40], [12.10, 50], [12.24, 60], [12.37, 70], [12.50, 80], [12.62, 90], [12.73, 100]];
function socFromV(v) {
  v += 0.10;
  if (v <= SOC_TABLE[0][0]) return 0;
  if (v >= SOC_TABLE[SOC_TABLE.length - 1][0]) return 100;
  for (let i = 1; i < SOC_TABLE.length; i++) if (v <= SOC_TABLE[i][0]) {
    const [v0, p0] = SOC_TABLE[i - 1], [v1, p1] = SOC_TABLE[i]; return Math.round(p0 + (v - v0) / (v1 - v0) * (p1 - p0)); }
}

// ------------------------------------------------------------------ safety guard
const SAFE_AT = new Set(["ATZ", "ATWS", "ATE0", "ATL0", "ATS0", "ATS1", "ATH0", "ATH1", "ATSP0", "ATI", "AT@1", "ATRV", "ATDP", "ATDPN", "ATAT1", "ATAT2"]);
const READ_MODES = new Set(["01", "02", "03", "06", "07", "09", "0A"]);
class WriteBlocked extends Error {}
function guard(cmd, allowWrite = false) {
  const c = String(cmd).toUpperCase().replace(/\s+/g, "");
  if (c.startsWith("AT")) {
    if (SAFE_AT.has(c) || /^ATST[0-9A-F]{2}$/.test(c)) return c;
    throw new WriteBlocked(`Adapter command '${c}' is not on the read-only allow-list`);
  }
  if (!/^[0-9A-F]{2,14}$/.test(c)) throw new WriteBlocked("Only hex OBD requests are allowed");
  const mode = c.slice(0, 2);
  if (READ_MODES.has(mode)) return c;
  if (allowWrite && c === "04") return c;
  throw new WriteBlocked(`Service 0x${mode} is not a read service; blocked in read-only mode`);
}

const store = {
  get(k, d) { try { const v = localStorage.getItem("cretaobd:" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("cretaobd:" + k, JSON.stringify(v)); } catch (e) {} },
};
const hexToBytes = h => { const a = []; for (let i = 0; i + 1 < h.length; i += 2) a.push(parseInt(h.slice(i, i + 2), 16)); return a; };
const h2 = n => n.toString(16).toUpperCase().padStart(2, "0");

// ------------------------------------------------------------------ server engine (laptop)
class ServerEngine {
  constructor() { this.kind = "server"; }
  state() { return fetch("/api/state").then(r => r.json()); }
  post(path, body) {
    return fetch(path, {method: "POST", headers: {"Content-Type": "application/json", "X-OBD-Client": "dashboard"},
      body: JSON.stringify(body || {})}).then(r => r.json());
  }
  writelog() { return fetch("/api/writelog").then(r => r.json()).then(r => r.log); }
}

// ------------------------------------------------------------------ native Android bridge
// Inside the Creta OBD Android app, window.AndroidBT (Java) opens a classic Bluetooth RFCOMM socket
// the way native OBD apps do. NativePort wraps it in the same shape as a Web Serial port.
class NativePort {
  constructor(address, name) { this.address = address; this.name = name; this.onlog = null; }
  getInfo() { return {native: true, name: this.name, address: this.address}; }
  async open() {
    const bt = window.AndroidBT, enc = new TextEncoder(), dec = new TextDecoder();
    let ctrl;
    this.readable = new ReadableStream({start(c) { ctrl = c; }});
    this.writable = new WritableStream({write(chunk) { bt.write(dec.decode(chunk)); }});
    window.__btData = s => { try { ctrl.enqueue(enc.encode(s)); } catch (e) {} };
    window.__btClosed = why => { this.onlog?.("Native: " + why); try { ctrl.close(); } catch (e) {} };
    window.__btLog = m => this.onlog?.(m);
    await new Promise((res, rej) => {
      window.__btConnected = err => err ? rej(new Error("Bluetooth connect failed: " + err)) : res();
      bt.connect(this.address);
    });
  }
  async close() { try { window.AndroidBT.disconnect(); } catch (e) {} }
}
const isNativeApp = () => !!window.AndroidBT;

// ------------------------------------------------------------------ direct engine (Web Serial)
const SPP = "00001101-0000-1000-8000-00805f9b34fb";
class DirectEngine {
  constructor(port) {
    this.kind = "direct";
    this.port = port || null; this.opened = false; this.running = false;
    this.connected = false; this.error = "Not connected. Tap Connect.";
    this.info = {}; this.supported = new Set(); this.live = {}; this.voltage = null;
    this.dtc = {stored: [], pending: [], permanent: [], updated: null};
    this.readiness = null; this.freeze = null; this.writeUntil = 0;
    this.history = []; this.vhist = [];
    this.mode06 = null; this.mode06Req = false; this.iupr = null;
    this.batTests = store.get("batTests", []); this.batReq = false; this.batLive = null;
    this.settings = store.get("settings", {});
    this.rx = ""; this.waiter = null; this.chain = Promise.resolve();
    this.log = [];
  }
  static available() { return "serial" in navigator || isNativeApp(); }

  // Android app: list paired Bluetooth devices (asks for the Nearby-devices permission if needed)
  static async nativeDevices() {
    const bt = window.AndroidBT;
    let r = JSON.parse(bt.listPaired());
    if (r.error === "PERMISSION") {
      const ok = await new Promise(res => { window.__btPerm = res; });
      if (!ok) throw new Error("Bluetooth permission was denied. Allow \"Nearby devices\" for Creta OBD in Android Settings → Apps.");
      r = JSON.parse(bt.listPaired());
    }
    if (r.error === "BT_OFF") throw new Error("Bluetooth is off. Turn it on and try again.");
    if (r.error === "NO_BT") throw new Error("This phone has no Bluetooth.");
    if (r.error) throw new Error(r.error);
    return r.devices || [];
  }
  async useNative(dev) {
    store.set("nativeDevice", dev);
    this.log_(`Using paired device ${dev.name} (${dev.address})`);
    await this.setPort(new NativePort(dev.address, dev.name));
  }

  log_(msg) {
    this.log.push(`${new Date().toLocaleTimeString()}  ${msg}`);
    if (this.log.length > 80) this.log = this.log.slice(-80);
  }
  // user gesture required the first time.
  // Plain requestPort() is Chrome's documented way to list standard Bluetooth SPP adapters;
  // alt=true uses an explicit SPP service filter instead (some phones list the device only this way).
  async choose(alt = false) {
    const opts = alt ? {allowedBluetoothServiceClassIds: [SPP], filters: [{bluetoothServiceClassId: SPP}]} : undefined;
    this.log_(`Opening adapter picker (${alt ? "SPP filter" : "standard"})…`);
    let p;
    try { p = await navigator.serial.requestPort(opts); }
    catch (e) {
      this.log_(`Picker: ${e.name}: ${e.message}`);
      if (e.name === "NotFoundError") throw new Error("No adapter was selected.");
      throw e;
    }
    try { this.log_("Picked port: " + JSON.stringify(p.getInfo())); } catch (e) {}
    await this.setPort(p);
  }
  // reconnect to an adapter chosen earlier, no picker needed
  async reuse() {
    if (isNativeApp()) {
      const dev = store.get("nativeDevice", null);
      this.log_(dev ? `Reconnecting to ${dev.name}` : "Android app: no adapter chosen yet");
      if (dev) { await this.useNative(dev); return true; }
      return false;
    }
    if (!DirectEngine.available()) return false;
    const ps = await navigator.serial.getPorts();
    this.log_(`Previously allowed ports: ${ps.length}`);
    if (!ps.length) return false;
    await this.setPort(ps[ps.length - 1]); return true;
  }
  async setPort(p) {
    if (this.port && this.port !== p) await this._close();
    if (p instanceof NativePort) p.onlog = m => this.log_(m);
    this.port = p; this.connected = false; this.error = "Connecting…";
    if (!this.running) this.run();
  }

  async _open() {
    this.log_("Opening Bluetooth link…");
    await this.port.open({baudRate: 38400});
    this.log_("Link open");
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this.opened = true;
    (async () => {
      const dec = new TextDecoder();
      try {
        while (true) {
          const {value, done} = await this.reader.read();
          if (done) break;
          this.rx += dec.decode(value);
          if (this.waiter && this.rx.includes(">")) this.waiter();
        }
      } catch (e) { /* port lost */ }
      if (this.opened) this._drop("Adapter disconnected");
    })();
  }
  async _close() {
    this.opened = false;
    try { await this.reader?.cancel(); } catch (e) {}
    try { this.reader?.releaseLock(); } catch (e) {}
    try { this.writer?.releaseLock(); } catch (e) {}
    try { await this.port?.close(); } catch (e) {}
  }
  _drop(why) { this.connected = false; this.error = why; this._close(); }

  async _io(cmd, timeout) {
    this.rx = "";
    await this.writer.write(new TextEncoder().encode(cmd + "\r"));
    await new Promise(res => {
      const t = setTimeout(() => { this.waiter = null; res(); }, timeout * 1000);
      this.waiter = () => { clearTimeout(t); this.waiter = null; res(); };
      if (this.rx.includes(">")) this.waiter();
    });
    const txt = this.rx.replace(/>/g, ""); this.rx = "";
    return txt.split(/[\r\n]+/).map(l => l.trim()).filter(l => l && l.replace(/\s/g, "").toUpperCase() !== cmd && l !== "SEARCHING...");
  }
  send(cmd, timeout = 4, allowWrite = false) {
    const c = guard(cmd, allowWrite);
    if (!this.opened) return Promise.reject(new Error("adapter not connected"));
    const p = this.chain.then(() => this._io(c, timeout));
    this.chain = p.catch(() => {});
    return p;
  }

  static hexjoin(lines) {
    const msgs = []; let cur = "";
    for (let l of lines) {
      l = l.replace(/\s/g, "").toUpperCase();
      if (/^[0-9A-F]{3}$/.test(l)) { if (cur) msgs.push(cur); cur = ""; continue; }
      const m = l.match(/^([0-9A-F]):([0-9A-F]+)$/);
      if (m) { cur += m[2]; continue; }
      if (/^[0-9A-F]+$/.test(l)) { if (cur) { msgs.push(cur); cur = ""; } msgs.push(l); }
    }
    if (cur) msgs.push(cur);
    return msgs;
  }
  async queryPid(pid, mode = "01", frame = "") {
    const lines = await this.send(mode + h2(pid) + frame, 2.5);
    const want = h2(parseInt(mode, 16) + 0x40) + h2(pid) + frame;
    for (const m of DirectEngine.hexjoin(lines)) if (m.startsWith(want)) return hexToBytes(m.slice(want.length));
    return null;
  }

  async connectCar() {
    for (const c of ["ATZ", "ATE0", "ATL0", "ATS0", "ATH0", "ATAT1", "ATSP0"]) {
      const r = await this.send(c, 3);
      if (c === "ATZ") this.log_(`Adapter reply to ATZ: ${r.join(" | ") || "(nothing)"}`);
    }
    const r = await this.send("0100", 12);
    this.log_(`Car reply to 0100: ${r.join(" | ") || "(nothing)"}`);
    if (!r.some(l => l.replace(/\s/g, "").startsWith("4100")))
      throw new Error("Car not responding (" + r.join(" ") + "). Is the ignition ON?");
    this.connected = true; this.error = "";
    this.info.adapter = (await this.send("ATI")).join(" ");
    this.info.protocol = (await this.send("ATDP")).join(" ").replace("AUTO,", "").trim();
    await this.loadSupported();
    await this.loadVehicle();
  }
  async loadSupported() {
    const sup = new Set(); let base = 0;
    while (true) {
      const d = await this.queryPid(base);
      if (!d || d.length < 4) break;
      const mask = ((d[0] << 24) >>> 0) + (d[1] << 16) + (d[2] << 8) + d[3];
      for (let i = 0; i < 32; i++) if (mask & (2 ** (31 - i))) sup.add(base + i + 1);
      if (!(mask & 1) || base >= 0xC0) break;
      base += 0x20;
    }
    this.supported = new Set([...sup].filter(p => p % 0x20));
    this.info.supported_pids = [...this.supported].sort((a, b) => a - b);
  }
  async mode09(pid) {
    const lines = await this.send("09" + h2(pid), 4);
    for (const m of DirectEngine.hexjoin(lines)) if (m.startsWith("49" + h2(pid))) return hexToBytes(m.slice(6));
    return null;
  }
  async loadVehicle() {
    const ascii = b => b ? String.fromCharCode(...b).replace(/[^\x20-\x7E]/g, "").replace(/^[-\s]+|[-\s]+$/g, "") : null;
    this.info.vin = ascii(await this.mode09(0x02));
    this.info.ecu_name = ascii(await this.mode09(0x0A));
    this.info.calibration_id = ascii(await this.mode09(0x04));
    const cvn = await this.mode09(0x06); this.info.cvn = cvn ? cvn.map(h2).join("") : null;
    try {
      await this.send("ATH1");
      const r = await this.send("0100", 4);
      this.info.ecus = [...new Set(r.map(l => l.replace(/\s/g, "")).filter(l => /^7E[89A-F]/.test(l)).map(l => l.slice(0, 3)))].sort();
    } finally { await this.send("ATH0"); }
    const names = {"7E8": "Engine (ECM)", "7E9": "Transmission (TCM)", "7EA": "Hybrid/other", "7EB": "Other"};
    this.info.ecu_list = (this.info.ecus || []).map(e => `${e} – ${names[e] || "ECU"}`);
  }

  static decodeDtc(h) { const v = parseInt(h, 16); return "PCBU"[v >> 14] + ((v >> 12) & 3) + (v & 0xFFF).toString(16).toUpperCase().padStart(3, "0"); }
  async readDtcs(mode) {
    const lines = await this.send(mode, 5), rsp = h2(parseInt(mode, 16) + 0x40), codes = new Set();
    for (const m of DirectEngine.hexjoin(lines)) {
      if (!m.startsWith(rsp)) continue;
      const body = m.slice(4);
      for (let i = 0; i + 3 < body.length; i += 4) if (body.slice(i, i + 4) !== "0000") codes.add(DirectEngine.decodeDtc(body.slice(i, i + 4)));
    }
    return [...codes].sort();
  }
  async readReadiness() {
    const d = await this.queryPid(0x01); if (!d) return null;
    const [a, b, c, e] = d, diesel = !!(b & 8), mons = [];
    ["Misfire", "Fuel system", "Components"].forEach((n, i) => { if (b & (1 << i)) mons.push({name: n, ready: !(b & (1 << (i + 4)))}); });
    const names = diesel ? ["NMHC catalyst", "NOx/SCR", null, "Boost pressure", null, "Exhaust gas sensor", "PM filter", "EGR/VVT"]
      : ["Catalyst", "Heated catalyst", "Evaporative system", "Secondary air", null, "Oxygen sensor", "O2 sensor heater", "EGR/VVT"];
    names.forEach((n, i) => { if (n && c & (1 << i)) mons.push({name: n, ready: !(e & (1 << i))}); });
    return {mil: !!(a & 0x80), count: a & 0x7F, ignition: diesel ? "Compression (diesel)" : "Spark (petrol)", monitors: mons};
  }
  async readFreeze() {
    const d = await this.queryPid(0x02, "02", "00");
    if (!d || d.length < 2 || u16(d) === 0) return null;
    const out = {dtc: DirectEngine.decodeDtc(h2(d[0]) + h2(d[1])), values: []};
    for (const pid of [0x04, 0x05, 0x67, 0x06, 0x07, 0x0B, 0x0C, 0x0D, 0x0F, 0x11, 0x03]) {
      if (!this.supported.has(pid)) continue;
      const dd = await this.queryPid(pid, "02", "00");
      if (dd) out.values.push(this.fmt(pid, dd));
    }
    return out;
  }
  async refreshDiag() {
    this.readiness = await this.readReadiness();
    this.dtc = {stored: await this.readDtcs("03"), pending: await this.readDtcs("07"), permanent: await this.readDtcs("0A"), updated: now()};
    this.freeze = this.dtc.stored.length ? await this.readFreeze() : null;
  }
  fmt(pid, d) {
    const [name, unit, group, n, fn] = PIDS[pid];
    let v = null;
    try { v = d.length >= n ? fn(d.slice(0, n)) : null; } catch (e) {}
    if (typeof v === "number" && !Number.isInteger(v)) v = +v.toFixed(unit === "V" || unit === "λ" ? 3 : 1);
    return {pid: h2(pid), name, unit, group, value: v, t: now()};
  }
  async pollPid(pid) { const d = await this.queryPid(pid); if (d && PIDS[pid]) this.live[pid] = this.fmt(pid, d); }

  async readMode06() {
    const mids = []; let base = 0;
    while (base <= 0xE0) {
      const ms = DirectEngine.hexjoin(await this.send("06" + h2(base), 4));
      const m = ms.find(x => x.startsWith("46" + h2(base)));
      if (!m || m.length < 12) break;
      const mask = parseInt(m.slice(4, 12), 16);
      for (let i = 0; i < 32; i++) if (mask & (2 ** (31 - i)) && (base + i + 1) % 0x20) mids.push(base + i + 1);
      if (!(mask & 1)) break;
      base += 0x20;
    }
    const tests = [];
    for (const mid of mids) {
      for (const msg of DirectEngine.hexjoin(await this.send("06" + h2(mid), 4))) {
        if (!msg.startsWith("46")) continue;
        const body = hexToBytes(msg.slice(2));
        for (let i = 0; i + 8 < body.length; i += 9) {
          const r = body.slice(i, i + 9); if (r[0] !== mid) continue;
          const tid = r[1], uas = r[2];
          let raw = [(r[3] << 8) | r[4], (r[5] << 8) | r[6], (r[7] << 8) | r[8]];
          if (uas >= 0x80) raw = raw.map(x => x > 32767 ? x - 65536 : x);
          const [unit, k, off = 0] = UAS[uas] || ["raw", 1];
          const [val, lo, hi] = raw.map(x => +(x * k + off).toFixed(4));
          tests.push({mid: h2(mid), monitor: MID_NAMES[mid] || `Monitor 0x${h2(mid)}`, tid: h2(tid),
            test: TID_NAMES[tid] || `Manufacturer test 0x${h2(tid)}`, value: val, min: lo, max: hi, unit,
            pass: raw[1] <= raw[0] && raw[0] <= raw[2], lo_open: raw[1] === 0 || raw[1] <= -32000,
            hi_open: raw[2] >= (uas >= 0x80 ? 0x7F00 : 0xFF00)});
        }
      }
    }
    this.mode06 = {t: now(), mids: mids.map(h2), tests};
  }
  async readIupr() {
    const b = await this.mode09(0x08); if (!b) return;
    const vals = []; for (let i = 0; i + 1 < b.length; i += 2) vals.push((b[i] << 8) | b[i + 1]);
    this.iupr = vals.map((v, i) => ({name: IUPR_NAMES[i] || `Counter ${i}`, value: v}));
  }

  async volts() { const m = (await this.send("ATRV", 1)).join(" ").match(/([\d.]+)V/); return m ? parseFloat(m[1]) : null; }
  async batteryTest() {
    const rpm = await this.queryPid(0x0C);
    if (rpm && u16(rpm) / 4 > 300) { this.batLive = {phase: "error", msg: "Engine is already running. Switch it off, wait 1 minute, then run the test."}; return; }
    const t0 = Date.now(), samples = []; let crankT = null;
    const median = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    this.batLive = {phase: "rest", msg: "Measuring resting voltage… don't start yet", samples};
    while ((Date.now() - t0) / 1000 < 30) {
      const v = await this.volts(); if (v == null) continue;
      const t = +((Date.now() - t0) / 1000).toFixed(2); samples.push([t, v]);
      const rest = median(samples.slice(0, 12).map(x => x[1]));
      if (t > 3 && crankT == null) { this.batLive.phase = "crank"; this.batLive.msg = "START THE ENGINE NOW"; if (v < rest - 0.8) crankT = t; }
      if (crankT != null) { this.batLive.phase = "after"; this.batLive.msg = "Crank detected. Measuring recovery and charging…"; if (t - crankT > 8) break; }
    }
    const rest = samples.length ? median(samples.slice(0, 12).map(x => x[1])) : null;
    const vmin = samples.length ? Math.min(...samples.map(x => x[1])) : null;
    const tail = samples.slice(-8).map(x => x[1]);
    const charging = tail.length ? +(tail.reduce((a, b) => a + b, 0) / tail.length).toFixed(2) : null;
    const res = {t: now(), rest, rest_soc: rest ? socFromV(rest) : null, crank_min: vmin, crank_detected: crankT != null, charging, notes: []};
    if (crankT == null) { res.verdict = "No crank detected"; res.score = null; res.notes.push("The engine wasn't started during the 30 s window, so only resting voltage was measured."); }
    else {
      res.score = Math.max(0, Math.min(100, Math.round((vmin - 9.0) / (10.8 - 9.0) * 100)));
      res.verdict = vmin >= 10.5 ? "Good" : vmin >= 10.0 ? "Fair" : vmin >= 9.6 ? "Weak, test it soon" : "Replace soon";
      if (charging && charging < 13.0) res.notes.push(`Charging voltage ${charging} V is low. The alternator may not be charging (or the smart alternator is resting).`);
      if (rest && socFromV(rest) < 60) res.notes.push("Battery was under 60% charged, which makes the crank dip worse. Drive 30+ min or charge it, then re-test.");
    }
    this.batTests = [...this.batTests, res].slice(-20); store.set("batTests", this.batTests);
    this.batLive = {phase: "done", msg: res.verdict, samples};
  }

  writeArmed() { return now() < this.writeUntil; }
  async clearCodes() {
    if (!this.writeArmed()) throw new WriteBlocked("Write mode is not armed");
    const rpm = await this.queryPid(0x0C);
    if (rpm && u16(rpm) / 4 > 50) throw new WriteBlocked("Engine is running. Switch the engine OFF (ignition ON) before clearing codes.");
    const before = {stored: this.dtc.stored, pending: this.dtc.pending, permanent: this.dtc.permanent};
    let lines;
    try { lines = await this.send("04", 8, true); } finally { this.writeUntil = 0; }
    const ok = lines.some(l => l.replace(/\s/g, "").startsWith("44"));
    store.set("writeLog", store.get("writeLog", "") + `${new Date().toLocaleString()}  MODE 04 clear codes  before=${JSON.stringify(before)}  response=${JSON.stringify(lines)}  ok=${ok}\n`);
    await sleep(1000); await this.refreshDiag();
    return {ok, lines};
  }

  record() {
    const g = p => this.live[p]?.value;
    const cool = this.live[0x67] ? g(0x67) : g(0x05);
    this.history.push({t: +now().toFixed(1), rpm: g(0x0C), speed: g(0x0D), coolant: cool, load: g(0x04), throttle: g(0x11)});
    if (this.history.length > 600) this.history = this.history.slice(-600);
  }

  async run() {
    this.running = true;
    let slowIdx = 0, lastDiag = 0, lastV = 0;
    while (this.running) {
      if (!this.port) { await sleep(500); continue; }
      if (!this.connected) {
        try {
          if (!this.opened) await this._open();
          await this.connectCar(); await this.refreshDiag(); await this.readIupr(); lastDiag = Date.now();
        } catch (e) {
          const msg = String(e.message || e);
          this.log_(`Connect failed: ${e.name || "Error"}: ${msg}`);
          this.error = /Failed to open|NetworkError|in use|already open/i.test(msg)
            ? `Couldn't open the Bluetooth link (${msg}). Make sure the adapter is plugged in, the ignition is ON, and no other app or device is connected to it.` : msg;
          await this._close(); await sleep(5000); continue;
        }
      }
      try {
        if (this.batReq) { this.batReq = false; try { await this.batteryTest(); } catch (e) { this.batLive = {phase: "error", msg: String(e.message || e)}; } }
        if (this.mode06Req) { try { await this.readMode06(); await this.readIupr(); } finally { this.mode06Req = false; } }
        const fast = [...FAST, this.supported.has(0x67) ? 0x67 : 0x05].filter(p => this.supported.has(p));
        const slow = [...this.supported].sort((a, b) => a - b).filter(p => PIDS[p] && !fast.includes(p));
        for (const p of fast) await this.pollPid(p);
        for (let i = 0; i < 2 && slow.length; i++) await this.pollPid(slow[slowIdx++ % slow.length]);
        if (Date.now() - lastV > 3000) {
          this.voltage = await this.volts(); lastV = Date.now();
          if (this.voltage) { this.vhist.push([Math.round(now()), this.voltage, (this.live[0x0C]?.value || 0) > 300 ? 1 : 0]); if (this.vhist.length > 1200) this.vhist = this.vhist.slice(-1200); }
        }
        if (Date.now() - lastDiag > 20000) { await this.refreshDiag(); lastDiag = Date.now(); }
        this.record();
      } catch (e) {
        if (e instanceof WriteBlocked) continue;
        if (!this.opened) continue;
        this.error = String(e.message || e); await sleep(500);
      }
    }
  }

  // same shape as server.py /api/state
  async state() {
    const live = {}; for (const [k, v] of Object.entries(this.live)) live[h2(+k)] = v;
    return {connected: this.connected, error: this.error, port: isNativeApp() ? (this.port?.name || "Bluetooth") : "Bluetooth", info: this.info,
      native: isNativeApp(), voltage: this.voltage, live,
      dtc: this.dtc, readiness: this.readiness, freeze: this.freeze, write_armed: this.writeArmed(),
      write_remaining: Math.max(0, Math.round(this.writeUntil - now())), history: this.history.slice(-240), now: now(),
      vhist: this.vhist.slice(-400), mode06: this.mode06, mode06_busy: this.mode06Req, iupr: this.iupr, bat_live: this.batLive,
      bat_busy: this.batReq, bat_tests: this.batTests.map(({samples, ...t}) => t), settings: this.settings, remote: false, direct: true,
      has_port: !!this.port, log: this.log.slice(-40)};
  }
  async post(path, body = {}) {
    try {
      switch (path) {
        case "/api/refresh": await this.refreshDiag(); return {ok: true};
        case "/api/mode06": this.mode06Req = true; return {ok: true};
        case "/api/battery-test":
          if (this.batLive && ["rest", "crank", "after"].includes(this.batLive.phase)) return {ok: false, error: "A test is already running"};
          this.batLive = {phase: "queued", msg: "Starting…", samples: []}; this.batReq = true; return {ok: true};
        case "/api/settings":
          for (const k of ["odo_ref_km", "ecu_ref_km", "odo_set_at"]) if (k in body) this.settings[k] = body[k];
          store.set("settings", this.settings); return {ok: true};
        case "/api/console": return {ok: true, lines: await this.send(String(body.cmd || ""), 5)};
        case "/api/mode":
          if (body.mode === "write") {
            if (body.confirm !== "ENABLE WRITE") return {ok: false, error: "Confirmation text did not match"};
            this.writeUntil = now() + 120;
          } else this.writeUntil = 0;
          return {ok: true, write_armed: this.writeArmed()};
        case "/api/clear-dtc":
          if (body.confirm !== "CLEAR") return {ok: false, error: "Confirmation text did not match"};
          return await this.clearCodes();
      }
      return {ok: false, error: "unknown action"};
    } catch (e) { return {ok: false, error: String(e.message || e)}; }
  }
  async writelog() { return store.get("writeLog", ""); }
}

window.OBD = {ServerEngine, DirectEngine, NativePort, isNativeApp, guard, WriteBlocked, socFromV, SPP};
})();
