/* Hidden data: read-only manufacturer data over UDS (ISO 14229).
 * Only READ services are allowed by the engine's guard in this mode: 0x22 ReadDataByIdentifier, 0x21 ReadDataByLocalIdentifier,
 * 0x1A ReadEcuIdentification, plus adapter addressing (ATSH/ATCRA). No sessions, security access, routines, I/O control or writes.
 * Nothing here is model-specific guesswork: module identification uses the standard F1xx IDs; everything else is found by the user's own scan. */
"use strict";
window.RENDER_HOOKS = window.RENDER_HOOKS || [];

const MODULES = [   // common request addresses (11-bit CAN). Unlisted modules can be found with "Deep scan".
  ["7E0", "Engine (ECM)"], ["7E1", "Transmission (TCM)"], ["7E2", "Hybrid / motor control"], ["7D1", "ABS / ESC"], ["7D2", "Airbag (SRS)"],
  ["7D4", "Power steering"], ["7A0", "Body control (BCM)"], ["7C6", "Instrument cluster"], ["7B3", "Climate control"], ["7C4", "Front camera"],
  ["7D0", "Front radar"], ["7A5", "Smart key"], ["770", "Gateway"]];
const ID_DIDS = [["F187", "Spare part number"], ["F189", "Software version"], ["F188", "Software number"], ["F18C", "Serial number"],
  ["F191", "Hardware number"], ["F18A", "Supplier ID"], ["F192", "Supplier hardware no."], ["F193", "Supplier hardware ver."],
  ["F194", "Supplier software no."], ["F195", "Supplier software ver."], ["F18B", "Manufacture date"], ["F197", "System name"],
  ["F180", "Boot software ID"], ["F181", "Application software ID"], ["F190", "VIN"]];
const NRC = {"10": "rejected", "11": "service not supported", "12": "not supported", "13": "bad length", "22": "conditions not correct",
  "31": "ID not supported", "33": "security access needed", "7F": "service not supported in this session", "78": "busy"};

const hstore = {
  get(k, d) { try { const v = localStorage.getItem("obdhid:" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("obdhid:" + k, JSON.stringify(v)); } catch (e) {} },
};
let found = hstore.get("modules", {});           // header -> {name, part, sw}
let scan = null, scanResults = hstore.get("scan", []), watches = [], watchTimer = 0, customVals = {}, lastCustomPoll = 0;

const hx2 = b => b.map(x => x.toString(16).toUpperCase().padStart(2, "0")).join(" ");
const asText = b => { const s = String.fromCharCode(...b).replace(/\0+$/, ""); return /^[\x20-\x7E]+$/.test(s) && s.trim().length ? s.trim() : null; };
const canExplore = () => ENGINE?.kind === "direct" && typeof ENGINE.explore === "function";
const modName = h => found[h]?.name || MODULES.find(m => m[0] === h)?.[1] || "Module 0x" + h;

function needDirect() {
  if (!canExplore()) return "Hidden data works in the Android app or direct-Bluetooth mode. The laptop server only reads standard OBD.";
  if (!S?.connected) return "Connect to the car first (ignition ON).";
  if (S?.info?.can === false) return "This vehicle uses K-line / J1850. Manufacturer data here needs a CAN vehicle.";
  return null;
}
async function scanModules(deep = false) {
  const why = needDirect(); if (why) return toast(why, false, 6000);
  const list = deep ? Array.from({length: 0x7F8 - 0x700}, (_, i) => (0x700 + i).toString(16).toUpperCase()).filter(h => h !== "7DF" && !/^7E[89A-F]$/.test(h)) : MODULES.map(m => m[0]);
  scan = {kind: "modules", done: 0, total: list.length, stop: false};
  for (let i = 0; i < list.length && !scan.stop; i += 6) {
    const chunk = list.slice(i, i + 6);
    const res = await ENGINE.exploreMany(chunk.map(h => [h, "22F187"])).catch(e => (toast(esc(e.message), false), []));
    for (const r of res) {
      if (r.res && (r.res.bytes || r.res.neg)) {
        found[r.header] = {name: modName(r.header), part: r.res.bytes ? asText(r.res.bytes) || hx2(r.res.bytes) : null, neg: r.res.neg || null};
      }
    }
    scan.done = Math.min(list.length, i + chunk.length); renderHidden();
  }
  hstore.set("modules", found); scan = null; renderHidden(true);
  toast(`🔎 ${Object.keys(found).length} module(s) answered`, true, 4000);
}
async function identify(header) {
  const why = needDirect(); if (why) return toast(why, false, 6000);
  const res = await ENGINE.exploreMany(ID_DIDS.map(([d]) => [header, "22" + d])).catch(e => (toast(esc(e.message), false), []));
  const rows = res.map((r, i) => {
    const [d, n] = ID_DIDS[i], b = r.res?.bytes;
    const val = b ? asText(b) || hx2(b) : r.res?.neg ? `– (${NRC[r.res.neg] || "NRC " + r.res.neg})` : "no answer";
    return `<tr><td class="muted">${n} <span class="pid">${d}</span></td><td style="word-break:break-all">${esc(val)}</td></tr>`;
  }).join("");
  found[header] = {...(found[header] || {name: modName(header)}), ident: Date.now()}; hstore.set("modules", found);
  warnBox(`${esc(modName(header))} · 0x${header}`, `<p class="muted" style="margin-top:0">Standard identification data (ISO 14229). Read-only.</p><table>${rows}</table>`);
}
async function scanIds() {
  const why = needDirect(); if (why) return toast(why, false, 6000);
  const header = $("#hsMod").value.trim().toUpperCase(), svc = $("#hsSvc").value;
  const from = parseInt($("#hsFrom").value, 16), to = parseInt($("#hsTo").value, 16);
  if (!/^[0-7][0-9A-F]{2}$/.test(header)) return toast("Enter a module address like 7E0", false);
  const max = svc === "22" ? 0xFFFF : 0xFF;
  if (!(from >= 0 && to >= from && to <= max)) return toast(`Enter a hex range (${svc === "22" ? "0000–FFFF" : "00–FF"})`, false);
  if (to - from > 1023) return toast("Scan at most 1024 IDs at a time (each takes about 0.1 s).", false);
  scan = {kind: "ids", done: 0, total: to - from + 1, stop: false}; let hits = 0;
  const pad = svc === "22" ? 4 : 2;
  for (let id = from; id <= to && !scan.stop; id += 8) {
    const reqs = []; for (let k = id; k <= Math.min(to, id + 7); k++) reqs.push([header, svc + k.toString(16).toUpperCase().padStart(pad, "0")]);
    const res = await ENGINE.exploreMany(reqs).catch(() => []);
    for (const r of res) if (r.res?.bytes?.length) {
      scanResults = scanResults.filter(x => !(x.header === r.header && x.req === r.req));
      scanResults.unshift({header: r.header, req: r.req, len: r.res.bytes.length, hex: hx2(r.res.bytes).slice(0, 120), t: Date.now()}); hits++;
    }
    scan.done = Math.min(scan.total, id - from + 8); renderHidden();
  }
  scanResults = scanResults.slice(0, 200); hstore.set("scan", scanResults); scan = null; renderHidden(true);
  toast(`🔎 Scan finished: ${hits} ID(s) answered`, true, 4000);
}

// ---------------------------------------------------------- live watch (find which byte is what)
function toggleWatch(header, req) {
  const i = watches.findIndex(w => w.header === header && w.req === req);
  if (i >= 0) watches.splice(i, 1);
  else { if (watches.length >= 4) return toast("Watch up to 4 IDs at a time", false); watches.push({header, req, last: null, min: [], max: [], changed: [], samples: []}); }
  renderHidden(true);
}
let watchBusy = false, customBusy = false;
async function pollWatches() {
  if (watchBusy || !watches.length || !canExplore() || !S?.connected || Date.now() - watchTimer < 1500) return;
  watchTimer = Date.now(); watchBusy = true;
  const res = await ENGINE.exploreMany(watches.map(w => [w.header, w.req])).catch(() => []).finally(() => { watchBusy = false; });
  res.forEach((r, i) => {
    const w = watches[i], b = r.res?.bytes; if (!w || !b) return;
    b.forEach((x, j) => { w.min[j] = Math.min(w.min[j] ?? x, x); w.max[j] = Math.max(w.max[j] ?? x, x); w.changed[j] = w.last ? w.last[j] !== x : false; });
    w.last = b; w.samples.push({rpm: L("0C") || 0, spd: L("0D") || 0, temp: L(tempPid()), b}); if (w.samples.length > 120) w.samples.shift();
  });
  renderWatches();
}
function corr(xs, ys) {
  const n = xs.length; if (n < 8) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}
function renderWatches() {
  const el = $("#hWatch"); if (!el) return;
  if (!watches.length) { el.innerHTML = `<p class="muted" style="margin:0">Tick "Watch" on a scan result to see its bytes live. Changing bytes light up, and the app tells you which byte moves with RPM, speed or temperature.</p>`; return; }
  el.innerHTML = watches.map(w => {
    const b = w.last || [];
    const hints = [];
    if (w.samples.length >= 8) b.forEach((_, j) => {
      const ys = w.samples.map(s => s.b[j] ?? 0);
      for (const [k, name] of [["rpm", "RPM"], ["spd", "speed"], ["temp", "engine temp"]]) {
        const xs = w.samples.map(s => s[k] ?? 0), r = corr(xs, ys);
        if (Math.abs(r) > 0.85 && new Set(ys).size > 2) hints.push(`byte ${String.fromCharCode(65 + j)} (#${j}) follows ${name} (r=${r.toFixed(2)})`);
      }
    });
    return `<div class="dtc"><div class="row"><b>${esc(modName(w.header))}</b><span class="pid">${w.header} · ${w.req}</span><span style="flex:1"></span>
      <button class="btn" type="button" data-mkpid="${w.header}|${w.req}">＋ Custom PID</button><button class="btn" type="button" data-watch="${w.header}|${w.req}">Stop</button></div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:8px;font-family:ui-monospace,Consolas,monospace;font-size:12px">
      ${b.map((x, j) => `<span title="byte ${String.fromCharCode(65 + j)}: ${x} (min ${w.min[j]}, max ${w.max[j]})" style="padding:3px 5px;border-radius:5px;border:1px solid var(--line);
        background:${w.changed[j] ? "color-mix(in srgb,var(--warn) 35%,transparent)" : w.min[j] !== w.max[j] ? "color-mix(in srgb,var(--accent) 14%,transparent)" : "var(--panel)"}">
        <span class="muted">${j < 26 ? String.fromCharCode(65 + j) : j}</span> ${x.toString(16).toUpperCase().padStart(2, "0")}</span>`).join("") || '<span class="muted">waiting…</span>'}</div>
      ${hints.length ? `<div style="margin-top:6px;font-size:12.5px;color:var(--ok)">💡 ${hints.slice(0, 4).map(esc).join(" · ")}</div>` : ""}</div>`;
  }).join("");
}

// ---------------------------------------------------------- custom PIDs (Torque-style: header + request + formula over bytes A, B, C…)
const customs = () => (VEH().customPids ||= []);
function compileFormula(f) {
  const s = String(f || "").toUpperCase();
  if (!/^[A-Z0-9+\-*\/()., %<>=!&|?:^~\s]+$/.test(s) || /[A-Z]{2,}/.test(s)) throw new Error("Use bytes A, B, C… with numbers and + − × ÷ ( ) only");
  // eslint-disable-next-line no-new-func
  return new Function(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""), `"use strict";return (${s});`);
}
function editCustom(idx = -1, pre = {}) {
  const c = idx >= 0 ? {...customs()[idx]} : {name: "", header: "7E0", req: "22", formula: "A", unit: "", ...pre};
  const fld = (k, l, ph = "") => `<label class="vf">${l}<input data-c="${k}" value="${esc(c[k] ?? "")}" placeholder="${esc(ph)}"></label>`;
  warnBox(idx >= 0 ? "Edit custom PID" : "New custom PID", `<div class="vgrid">${fld("name", "Name", "e.g. Cylinder 1 timing")}${fld("unit", "Unit", "°, °C, rpm…")}
    ${fld("header", "Module address", "7E0")}${fld("req", "Request", "22xxxx or 21xx")}
    <label class="vf" style="grid-column:1/-1">Formula over reply bytes A, B, C… (after the echoed ID)<input data-c="formula" value="${esc(c.formula)}" placeholder="(A*256+B)/4"></label></div>
    <p class="muted" style="font-size:12px">Examples: <code>A-40</code> temperature · <code>(A*256+B)/4</code> RPM · <code>A*0.5-64</code> timing angle. Only read requests (22/21) are allowed.</p>
    <div class="row" style="justify-content:space-between">${idx >= 0 ? `<button class="btn danger" type="button" data-cdel="${idx}">Delete</button>` : "<span></span>"}
      <button class="btn primary" type="button" data-csave="${idx}">Save</button></div>`);
  $("#wdB").onclick = e => {
    if (e.target.closest("[data-cdel]")) { customs().splice(idx, 1); saveVehicles(); $("#warnDlg").close(); return renderHidden(true); }
    if (!e.target.closest("[data-csave]")) return;
    document.querySelectorAll("#wdB [data-c]").forEach(i => c[i.dataset.c] = i.value.trim());
    c.header = c.header.toUpperCase(); c.req = c.req.toUpperCase().replace(/\s/g, "");
    try { compileFormula(c.formula); OBD.guard(c.req, false, true); if (!/^[0-7][0-9A-F]{2}$/.test(c.header)) throw new Error("Module address like 7E0"); }
    catch (err) { return toast("⚠ " + esc(err.message), false, 6000); }
    if (idx >= 0) customs()[idx] = c; else customs().push(c);
    saveVehicles(); $("#warnDlg").close(); renderHidden(true);
  };
}
async function pollCustoms() {
  const list = customs(); if (customBusy || !list.length || !canExplore() || !S?.connected || Date.now() - lastCustomPoll < 2000) return;
  lastCustomPoll = Date.now(); customBusy = true;
  const res = await ENGINE.exploreMany(list.map(c => [c.header, c.req])).catch(() => []).finally(() => { customBusy = false; });
  res.forEach((r, i) => {
    const c = list[i]; if (!c) return;
    if (!r.res?.bytes) { customVals[i] = {err: r.res?.neg ? NRC[r.res.neg] || "NRC " + r.res.neg : "no answer"}; return; }
    try { const v = compileFormula(c.formula)(...r.res.bytes); customVals[i] = {v: typeof v === "number" ? +v.toFixed(2) : v, raw: hx2(r.res.bytes)}; }
    catch (e) { customVals[i] = {err: "formula error"}; }
  });
  renderCustoms();
}
function renderCustoms() {
  const el = $("#hCustom"); if (!el) return;
  const list = customs();
  el.innerHTML = (list.length ? `<div class="minis" style="margin-top:0">${list.map((c, i) => `<div class="mini" data-cedit="${i}" style="cursor:pointer">
      <div class="k">${esc(c.name || c.req)} <span class="pid">${c.header}·${c.req}</span></div>
      <div class="v"><span>${customVals[i]?.v ?? "–"}</span><small>${esc(c.unit || "")}</small></div>
      ${customVals[i]?.err ? `<div class="muted" style="font-size:11px">${esc(customVals[i].err)}</div>` : ""}</div>`).join("")}</div>`
    : `<p class="muted" style="margin:0 0 8px">No custom PIDs yet. Create one from a watched scan result, or enter a request you know.</p>`) +
    `<div class="row" style="margin-top:8px"><button class="btn" type="button" id="cNew">＋ New custom PID</button>
      <button class="btn" type="button" id="cExport">Export</button><button class="btn" type="button" id="cImport">Import</button></div>`;
}

// ---------------------------------------------------------- render
let hidKey = "";
function renderHidden(force = false) {
  if (!$("#hidden")?.classList.contains("on") && !force) return;
  const why = needDirect();
  $("#hStatus").innerHTML = why ? `<div class="warnbox">${esc(why)}</div>` : "";
  $("#hScanProg").innerHTML = scan ? `<div class="row"><div class="bar" style="flex:1;margin:0"><i style="width:${(scan.done / scan.total * 100).toFixed(0)}%"></i></div>
    <span class="muted" style="font-size:12px">${scan.done}/${scan.total}</span><button class="btn" type="button" id="hStop">Stop</button></div>` : "";
  const key = JSON.stringify([found, scanResults.length, watches.map(w => w.req), force && Date.now()]);
  if (key === hidKey) return; hidKey = key;
  const mods = Object.entries(found);
  $("#hModules").innerHTML = mods.length ? `<table><tr><th>Module</th><th>Address</th><th>Part number</th><th></th></tr>${mods.map(([h, m]) => `
    <tr><td>${esc(m.name)}</td><td class="pid">0x${h}</td><td style="word-break:break-all">${esc(m.part || (m.neg ? "answers (" + (NRC[m.neg] || m.neg) + ")" : "–"))}</td>
    <td class="num"><button class="btn" type="button" data-ident="${h}" style="padding:4px 10px">Details</button></td></tr>`).join("")}</table>`
    : `<p class="muted" style="margin:0">No scan yet.</p>`;
  const opts = [...new Set([...mods.map(([h]) => h), "7E0"])].map(h => `<option value="${h}">${h} · ${esc(modName(h))}</option>`).join("");
  if ($("#hsModList")) $("#hsModList").innerHTML = opts;
  $("#hResults").innerHTML = scanResults.length ? scanResults.slice(0, 80).map(r => `<div class="row" style="border-bottom:1px solid var(--line);padding:6px 0;font-size:12.5px">
      <span class="pid" style="min-width:110px">${r.header} · ${r.req}</span><span style="flex:1;font-family:ui-monospace,Consolas,monospace;word-break:break-all">${esc(r.hex)}</span>
      <span class="muted">${r.len} B</span><button class="btn" type="button" data-watch="${r.header}|${r.req}" style="padding:3px 10px">${watches.some(w => w.req === r.req && w.header === r.header) ? "Watching" : "Watch"}</button></div>`).join("")
    : `<p class="muted" style="margin:0">No results yet.</p>`;
  renderWatches(); renderCustoms();
}
document.addEventListener("click", async e => {
  const t = e.target;
  if (t.closest("#hScanMods")) scanModules(false);
  if (t.closest("#hScanDeep")) scanModules(true);
  if (t.closest("#hStop") && scan) scan.stop = true;
  if (t.closest("#hScanIds")) scanIds();
  if (t.closest("#hClearRes")) { scanResults = []; hstore.set("scan", []); renderHidden(true); }
  const id = t.closest("[data-ident]"); if (id) identify(id.dataset.ident);
  const w = t.closest("[data-watch]"); if (w) { const [h, r] = w.dataset.watch.split("|"); toggleWatch(h, r); }
  const mk = t.closest("[data-mkpid]"); if (mk) { const [h, r] = mk.dataset.mkpid.split("|"); editCustom(-1, {header: h, req: r, name: "", formula: "A"}); }
  const ce = t.closest("[data-cedit]"); if (ce) editCustom(+ce.dataset.cedit);
  if (t.closest("#cNew")) editCustom(-1);
  if (t.closest("#cExport")) window.saveFile?.(`custom-pids-${vehName().replace(/\W+/g, "-")}.json`, "application/json", JSON.stringify(customs(), null, 1));
  if (t.closest("#cImport")) {
    const txt = prompt("Paste custom-PID JSON (exported from this app):"); if (!txt) return;
    try { const arr = JSON.parse(txt); if (!Array.isArray(arr)) throw 0;
      for (const c of arr) { compileFormula(c.formula); OBD.guard(c.req, false, true); }
      VEH().customPids = [...customs(), ...arr]; saveVehicles(); renderHidden(true); toast(`Imported ${arr.length} PID(s)`, true);
    } catch (err) { toast("That doesn't look like a valid custom-PID list (only 22/21 read requests are accepted).", false, 6000); }
  }
});
document.addEventListener("change", e => { if (e.target.id === "hsModList") $("#hsMod").value = e.target.value; if (e.target.id === "hsSvc") { const s = e.target.value === "22"; $("#hsFrom").value = s ? "0100" : "01"; $("#hsTo").value = s ? "01FF" : "FF"; } });
window.RENDER_HOOKS.push(() => { if (!$("#hidden")?.classList.contains("on")) return; renderHidden(); pollWatches(); pollCustoms(); });
window.HIDDEN = {customs, customVals, found: () => found};
