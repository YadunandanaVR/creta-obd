/* Demo / test adapter: a simulated ELM327 + Creta engine ECU, answering in the exact formats
 * the real car uses (CAN 11-bit, headers off, multi-frame ISO-TP for Mode 09).
 * Only used when the page is opened with ?demo=1 (or ?demo=dtc to simulate fault codes).
 * All identifiers are fake. */
(function () {
"use strict";
const hx = (n, bytes = 1) => { n = Math.round(n); if (n < 0) n += 256 ** bytes; return n.toString(16).toUpperCase().padStart(bytes * 2, "0").slice(-bytes * 2); };
const asciiHex = s => [...s].map(c => hx(c.charCodeAt(0))).join("");

function isotp(hex) {
  if (hex.length <= 14) return [hex];
  const lines = [hx(hex.length / 2, 2).slice(1)];          // 3-digit length line
  lines.push("0:" + hex.slice(0, 12));
  for (let i = 12, n = 1; i < hex.length; i += 14, n++) lines.push((n % 16).toString(16).toUpperCase() + ":" + hex.slice(i, i + 14).padEnd(14, "0"));
  return lines;
}

class CarSim {
  constructor(withCodes) {
    this.t0 = Date.now(); this.headers = false;
    this.stored = withCodes ? ["0171", "0300"] : [];
    this.pending = withCodes ? ["0420"] : [];
  }
  get t() { return (Date.now() - this.t0) / 1000; }
  n(a) { return (Math.random() - 0.5) * 2 * a; }
  get rpm() { const s = this.t % 40; return s < 25 ? 780 + this.n(25) : s < 32 ? 780 + (s - 25) * 420 : Math.max(800, 3700 - (s - 32) * 360); }
  get speed() { const s = this.t % 40; return s < 25 ? 0 : s < 32 ? (s - 25) * 9 : Math.max(0, 63 - (s - 32) * 8); }
  get cool() { return Math.min(91, 62 + this.t * 0.6); }
  pid(p) {
    const r = this.rpm, load = 20 + (r - 780) / 60 + this.n(2), tps = 16 + (r - 780) / 70;
    switch (p) {
      case 0x00: return "B63FA813"; case 0x20: return "801DB011"; case 0x40: return "FED08C01"; case 0x60: return "02000000";
      case 0x01: return (this.stored.length ? hx(0x80 | this.stored.length) : "00") + "07E100";
      case 0x03: return "0200";
      case 0x04: return hx(load * 2.55);
      case 0x06: return hx(128 + this.n(6) * 1.28);
      case 0x07: return hx(128 + (this.stored.includes("0171") ? 14 : 1.6) * 1.28);
      case 0x0B: return hx(32 + (r - 780) / 50);
      case 0x0C: return hx(r * 4, 2);
      case 0x0D: return hx(this.speed);
      case 0x0E: return hx((10 + this.n(3) + 64) * 2);
      case 0x0F: return hx(28 + 40);
      case 0x10: return hx((3 + (r - 780) / 120) * 100, 2);
      case 0x11: return hx(tps * 2.55);
      case 0x13: return "03";
      case 0x15: return hx(0.68 * 200) + "FF";
      case 0x1C: return "2D";
      case 0x1F: return hx(this.t, 2);
      case 0x21: return "0000";
      case 0x2C: return "00"; case 0x2D: return "80";
      case 0x2E: return hx(30 * 2.55);
      case 0x30: return "4B"; case 0x31: return hx(5000, 2); case 0x33: return "5E";
      case 0x34: return hx((1 + this.n(0.02)) * 32768, 2) + "8000";
      case 0x3C: return hx((560 + 40) * 10, 2);
      case 0x41: return "00076500";
      case 0x42: return hx((14.3 + this.n(0.05)) * 1000, 2);
      case 0x43: return hx(load * 2.55, 2);
      case 0x44: return "8000";
      case 0x45: return hx((tps - 15) * 2.55); case 0x46: return hx(24 + 40); case 0x47: return hx(tps * 2.55);
      case 0x49: return hx((15 + (r - 780) / 80) * 2.55); case 0x4A: return hx((7.5 + (r - 780) / 160) * 2.55); case 0x4C: return hx(2 * 2.55);
      case 0x51: return "01"; case 0x55: return "80"; case 0x56: return "80";
      case 0x67: return "01" + hx(this.cool + 40) + "00";
    }
    return null;
  }
  mode06(mid) {
    const rec = (m, tid, uas, v, lo, hi) => hx(m) + hx(tid) + hx(uas) + hx(v, 2) + hx(lo, 2) + hx(hi, 2);
    switch (mid) {
      case 0x00: return "C0000001"; case 0x20: return "80000801"; case 0x40: return "C0000000";
      case 0x01: return rec(1, 0x86, 0x03, 95, 30, 1998) + rec(1, 0x9B, 0x0A, 25384, 0, 26624);
      case 0x02: return rec(2, 0x05, 0x10, 60, 0, 700);
      case 0x21: return rec(0x21, 0x8E, 0x20, 285, 256, 65535);
      case 0x35: return rec(0x35, 0x91, 0x9C, -483, -1356, 644) + rec(0x35, 0x93, 0x9C, 2701, 1609, 3609);
      case 0x41: return rec(0x41, 0x81, 0x16, 8397, 7599, 65535);
      case 0x42: return rec(0x42, 0x8C, 0x0E, 1704, 1250, 65535);
    }
    return null;
  }
  respond(cmd) {
    const c = cmd.toUpperCase().replace(/\s/g, "");
    if (c === "ATZ") { this.headers = false; return ["", "ELM327 v2.1 (DEMO)"]; }
    if (c === "ATI") return ["ELM327 v2.1 (DEMO)"];
    if (c === "AT@1") return ["OBDII to RS232 Interpreter"];
    if (c === "ATDP") return ["AUTO, ISO 15765-4 (CAN 11/500)"];
    if (c === "ATDPN") return ["A6"];
    if (c === "ATRV") return [(this.rpm > 300 ? 14.4 + this.n(0.1) : 12.5).toFixed(1) + "V"];
    if (c === "ATH1") { this.headers = true; return ["OK"]; }
    if (c === "ATH0") { this.headers = false; return ["OK"]; }
    if (c.startsWith("AT")) return ["OK"];
    const mode = c.slice(0, 2), p = parseInt(c.slice(2, 4) || "0", 16);
    const out = msg => this.headers ? ["7E8" + hx(msg.length / 2) + msg] : isotp(msg);
    const codes = list => hx(list.length) + list.join("");
    switch (mode) {
      case "01": { const d = this.pid(p); return d == null ? ["NO DATA"] : out("41" + hx(p) + d); }
      case "02": {
        if (p === 2) return out("420200" + (this.stored[0] || "0000"));
        const d = this.pid(p); return d == null || !this.stored.length ? ["NO DATA"] : out("42" + hx(p) + "00" + d);
      }
      case "03": return out("43" + codes(this.stored));
      case "07": return out("47" + codes(this.pending));
      case "0A": return out("4A00");
      case "04": this.stored = []; this.pending = []; return ["44"];
      case "06": { const d = this.mode06(p); return d == null ? ["NO DATA"] : out("46" + (p % 0x20 ? "" : hx(p)) + d); }
      case "09":
        if (p === 0x00) return out("490055400000");
        if (p === 0x02) return out("490201" + asciiHex("MALDEMOVIN0000001"));
        if (p === 0x04) return out("490401" + asciiHex("DEMO-CAL-000001"));
        if (p === 0x06) return out("49060100000000");
        if (p === 0x08) return out("490814" + [139, 542, 84, 139, 0, 0, 84, 139, 0, 0, 216, 139, 0, 0, 0, 0, 0, 0, 0, 0].map(v => hx(v, 2)).join(""));
        if (p === 0x0A) return out("490A01" + asciiHex("ECM-EngineControl") + "0000");
        return ["NO DATA"];
    }
    return ["?"];
  }
}

// Minimal stand-in for a Web Serial SerialPort
class MockPort {
  constructor(withCodes) { this.sim = new CarSim(withCodes); this.buf = ""; }
  async open() {
    let ctrl; const self = this, enc = new TextEncoder(), dec = new TextDecoder();
    this.readable = new ReadableStream({start(c) { ctrl = c; }});
    this.writable = new WritableStream({write(chunk) {
      self.buf += dec.decode(chunk);
      let i;
      while ((i = self.buf.indexOf("\r")) >= 0) {
        const cmd = self.buf.slice(0, i); self.buf = self.buf.slice(i + 1);
        const lines = self.sim.respond(cmd);
        // window.__demoLag (ms) and window.__demoDrop (0–1) simulate walking away from the car
        if (Math.random() < (window.__demoDrop || 0)) continue;
        setTimeout(() => { try { ctrl.enqueue(enc.encode(lines.join("\r") + "\r\r>")); } catch (e) {} }, 15 + Math.random() * 25 + (window.__demoLag || 0));
      }
    }});
  }
  async close() {}
  getInfo() { return {}; }
}
window.OBDDemo = {MockPort, CarSim};
})();
