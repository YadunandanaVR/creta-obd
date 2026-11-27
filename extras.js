/* Alerts, performance timers, report export, file export and Google Sheets sync. */
"use strict";
window.RENDER_HOOKS = window.RENDER_HOOKS || [];
window.TRIP_HOOKS = window.TRIP_HOOKS || [];

// ---------------------------------------------------------------- save / share a file (browser download or Android share sheet)
window.saveFile = function (name, mime, text) {
  if (window.AndroidBT?.shareFile) { window.AndroidBT.shareFile(name, mime, text); return; }
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], {type: mime})); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
};
const csvCell = v => v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
const isoT = t => t ? new Date(t * 1000).toISOString() : "";

// ---------------------------------------------------------------- alerts
const ALERT_DEFS = [
  {id: "temp", name: "Engine overheating", unit: "°C", def: 108, test: (lim) => { const t = L(tempPid()); return t != null && t >= lim && `${TEMP_LABEL[tempPid()] || "Engine temp"} ${t} °C`; }},
  {id: "batt", name: "Battery low (engine off)", unit: "V", def: 11.9, test: (lim) => { const v = S?.voltage; return v && (L("0C") || 0) < 300 && v <= lim && `Battery ${v.toFixed(1)} V`; }},
  {id: "charge", name: "Not charging (engine running)", unit: "V", def: 12.6, test: (lim) => { const v = S?.voltage; return v && (L("0C") || 0) > 600 && v < lim && `Charging only ${v.toFixed(1)} V`; }},
  {id: "rev", name: "Over-revving (red zone)", unit: "rpm", def: 0, test: () => { const r = L("0C"); return r != null && r >= VEH().redline && `RPM ${Math.round(r)}`; }},
  {id: "speed", name: "Speed limit", unit: "km/h", def: 100, off: true, test: (lim) => { const s = L("0D"); return s != null && s > lim && `Speed ${s} km/h`; }},
  {id: "dtc", name: "New trouble code", unit: "", def: 0, test: () => { const c = S?.dtc?.stored || []; const nw = c.filter(x => !alertSeenCodes.has(x)); c.forEach(x => alertSeenCodes.add(x)); return alertArmed && nw.length && `New code ${nw.join(", ")}`; }},
];
const alertSeenCodes = new Set(); let alertArmed = false; const alertLast = {};
function alertCfg() { const v = VEH(); v.alerts ||= {}; ALERT_DEFS.forEach(a => v.alerts[a.id] ??= {on: !a.off, lim: a.def}); return v.alerts; }
let audioCtx = null;
function beep() {
  try { audioCtx ||= new (window.AudioContext || window.webkitAudioContext)(); const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880; g.gain.value = 0.15; o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.35); } catch (e) {}
}
function checkAlerts() {
  if (!S?.connected) return;
  if (!alertArmed && S.dtc?.updated) { (S.dtc.stored || []).forEach(x => alertSeenCodes.add(x)); alertArmed = true; }
  const cfg = alertCfg();
  for (const a of ALERT_DEFS) {
    const c = cfg[a.id]; if (!c?.on) continue;
    const msg = a.test(+c.lim);
    if (msg && Date.now() - (alertLast[a.id] || 0) > 60000) {
      alertLast[a.id] = Date.now();
      toast(`🚨 <b>${esc(a.name)}</b>: ${esc(msg)}`, false, 8000); beep(); try { navigator.vibrate?.([200, 100, 200]); } catch (e) {}
    }
  }
}
function renderAlerts() {
  const el = $("#alertsCfg"); if (!el || el.dataset.veh === VEH().id) return; el.dataset.veh = VEH().id;
  const cfg = alertCfg();
  el.innerHTML = ALERT_DEFS.map(a => `<div class="row" style="padding:5px 0;border-bottom:1px solid var(--line)">
    <label style="flex:1;display:flex;gap:8px;align-items:center"><input type="checkbox" data-al="${a.id}" ${cfg[a.id].on ? "checked" : ""}> ${a.name}</label>
    ${a.unit && a.id !== "rev" ? `<input type="number" step="any" data-allim="${a.id}" value="${cfg[a.id].lim}" style="width:84px;background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:5px 8px"> <span class="muted" style="font-size:12px;width:38px">${a.unit}</span>`
      : `<span class="muted" style="font-size:12px">${a.id === "rev" ? "from " + VEH().redline + " rpm" : ""}</span>`}</div>`).join("");
}
document.addEventListener("change", e => {
  const a = e.target.dataset?.al, l = e.target.dataset?.allim; if (!a && !l) return;
  const cfg = alertCfg(); if (a) cfg[a].on = e.target.checked; if (l) cfg[l].lim = +e.target.value; saveVehicles();
});

// ---------------------------------------------------------------- performance timers (from the speed sensor, ~1 reading/s)
const TIMERS = [{id: "0-60", from: 0, to: 60}, {id: "0-100", from: 0, to: 100}, {id: "40-80", from: 40, to: 80}];
let perf = {}, lastSpd = null;
function perfTick() {
  const s = L("0D"), t = S?.live?.["0D"]?.t; if (s == null || t == null || (lastSpd && lastSpd.t === t)) return;
  const prev = lastSpd; lastSpd = {s, t};
  if (!prev) return;
  for (const T of TIMERS) {
    const st = perf[T.id] ||= {state: "idle"};
    if (T.from === 0) {
      if (s === 0) { st.state = "ready"; st.t0 = null; }
      else if (st.state === "ready" && prev.s === 0) { st.state = "run"; st.t0 = prev.t + (t - prev.t) * (0 - prev.s) / Math.max(1, s - prev.s); }
    } else {
      if (s < T.from) st.state = "ready";
      else if (st.state === "ready" && prev.s < T.from && s >= T.from) { st.state = "run"; st.t0 = prev.t + (t - prev.t) * (T.from - prev.s) / Math.max(1, s - prev.s); }
    }
    if (st.state === "run") {
      if (s < prev.s - 3) st.state = "idle";                       // lifted off / braked: abort
      else if (s >= T.to) {
        const tEnd = prev.t + (t - prev.t) * (T.to - prev.s) / Math.max(1, s - prev.s), secs = tEnd - st.t0;
        st.state = "idle"; st.last = secs;
        if (secs > 1 && secs < 60) {
          const v = VEH(); v.perf ||= {}; const best = v.perf[T.id];
          if (!best || secs < best) { v.perf[T.id] = +secs.toFixed(1); saveVehicles(); toast(`⏱ New best ${T.id} km/h: <b>${secs.toFixed(1)} s</b>`, true, 6000); }
          else toast(`⏱ ${T.id} km/h: ${secs.toFixed(1)} s (best ${best} s)`, true, 5000);
        }
      }
    }
  }
}
function renderPerf() {
  const el = $("#perfBox"); if (!el) return; const best = VEH().perf || {};
  el.innerHTML = `<div class="grid" style="grid-template-columns:repeat(3,minmax(0,1fr));gap:8px">${TIMERS.map(T => { const st = perf[T.id] || {};
    return `<div class="stat"><div class="k">${T.id} km/h</div><div class="v">${st.state === "run" ? "⏱ …" : st.last ? st.last.toFixed(1) + " s" : "–"}</div>
      <div class="s">best ${best[T.id] ? best[T.id] + " s" : "–"} · ${st.state === "ready" ? '<span style="color:var(--ok)">ready</span>' : st.state === "run" ? "timing" : T.from ? "drop below " + T.from : "stop to arm"}</div></div>`; }).join("")}</div>
    <p class="muted" style="font-size:12px;margin-bottom:0">Uses the car's speed sensor (about 1 reading per second, interpolated), so expect ±0.3 s. Only time runs on a closed, safe road.</p>`;
}

// ---------------------------------------------------------------- report
function reportHtml() {
  const v = VEH(), i = S?.info || {}, d = S?.dtc || {}, codes = [...(d.stored || []).map(c => [c, "Stored"]), ...(d.pending || []).map(c => [c, "Pending"]), ...(d.permanent || []).map(c => [c, "Permanent"])];
  const row = (k, x) => `<tr><td>${k}</td><td>${esc(x ?? "–")}</td></tr>`;
  const trips = (window.TRIPS?.tripsFor(v.id) || []).slice(0, 15), tot = window.TRIPS?.totals(window.TRIPS.tripsFor(v.id)) || {};
  const bat = (S?.bat_tests || []).slice(-1)[0];
  const live = Object.values(S?.live || {}).sort((a, b) => a.group.localeCompare(b.group) || a.pid.localeCompare(b.pid));
  return `<div class="rep">
    <h1>Vehicle health report</h1>
    <p class="muted">${esc(vehName(v))}${v.year ? " · " + esc(v.year) : ""}${v.edition ? " · " + esc(v.edition) : ""} · generated ${new Date().toLocaleString()}</p>
    <h2>Vehicle</h2><table>${row("VIN", i.vin)}${row("Engine ECU", i.ecu_name)}${row("Calibration ID", i.calibration_id)}${row("Protocol", i.protocol)}${row("Fuel type", S?.live?.["51"]?.value)}${row("ECU distance counter", S?.live?.["31"] ? S.live["31"].value + " km since codes cleared" : null)}</table>
    <h2>Trouble codes</h2>${codes.length ? `<table>${codes.map(([c, k]) => { const x = dtcInfo(c); return `<tr><td><b>${c}</b> (${k})</td><td>${esc(x.d)}<br><span class="muted">Fix: ${esc(x.fix.join("; "))}</span></td></tr>`; }).join("")}</table>`
      : `<p>✅ No stored, pending or permanent codes. Check-engine light ${S?.readiness?.mil ? "<b>ON</b>" : "off"}.</p>`}
    ${S?.freeze ? `<h3>Freeze frame (${S.freeze.dtc})</h3><table>${S.freeze.values.map(x => row(x.name, `${x.value} ${x.unit}`)).join("")}</table>` : ""}
    <h2>Readiness monitors</h2><table>${(S?.readiness?.monitors || []).map(m => row(m.name, m.ready ? "Ready" : "Not ready")).join("") || row("–", "not read")}</table>
    <h2>Battery</h2><table>${row("Voltage now", S?.voltage != null ? S.voltage + " V" : null)}${bat ? row("Last cranking test", `${bat.verdict}${bat.score != null ? ` (score ${bat.score}/100, dip ${bat.crank_min} V)` : ""} · ${new Date(bat.t * 1000).toLocaleDateString()}`) : row("Cranking test", "not run yet")}</table>
    ${S?.mode06?.tests?.length ? `<h2>On-board test results</h2><p>${S.mode06.tests.filter(t => !t.pass).length ? "⚠ " + S.mode06.tests.filter(t => !t.pass).length + " failing" : "✅ all " + S.mode06.tests.length + " pass"}</p>` : ""}
    <h2>Trips</h2><p>${tot.n || 0} trips · ${(tot.km || 0).toFixed(1)} km · ${(tot.L || 0).toFixed(1)} L · ${tot.kmpl ? tot.kmpl.toFixed(1) + " km/L average" : "mileage n/a"} · ${v.currency || "₹"}${(tot.cost || 0).toFixed(0)}</p>
    ${trips.length ? `<table><tr><th>Date</th><th>km</th><th>km/L</th><th>Cost</th><th>Top km/h</th><th>Max °C</th></tr>${trips.map(s => `<tr><td>${new Date(s.start * 1000).toLocaleString([], {dateStyle: "short", timeStyle: "short"})}</td><td>${(s.distKm || 0).toFixed(1)}</td><td>${s.kmpl ? s.kmpl.toFixed(1) : "–"}</td><td>${s.cost ? (s.currency || "₹") + s.cost.toFixed(0) : "–"}</td><td>${Math.round(s.topSpeed || 0)}</td><td>${s.maxTemp ?? "–"}</td></tr>`).join("")}</table>` : ""}
    <h2>Live snapshot</h2><table>${live.map(x => row(`${x.name} (${x.pid})`, `${x.value ?? "–"} ${x.unit}`)).join("") || row("–", "not connected")}</table>
    <p class="muted" style="margin-top:18px">Generated by OBD Dashboard (read-only diagnostics). Values come from the vehicle's standard OBD-II data and are estimates where noted.</p></div>`;
}
function openReport() {
  let rv = $("#reportView");
  if (!rv) { rv = document.createElement("div"); rv.id = "reportView"; document.body.appendChild(rv); }
  rv.innerHTML = `<div class="rep-bar"><b>Report preview</b><span style="flex:1"></span>
    <button class="btn primary" type="button" id="repPrint">🖨 Print / Save PDF</button><button class="btn" type="button" id="repJson">⬇ JSON</button><button class="btn" type="button" id="repClose">Close</button></div>${reportHtml()}`;
  document.body.classList.add("reporting"); scrollTo(0, 0);
}
document.addEventListener("click", e => {
  if (e.target.closest("#repClose")) document.body.classList.remove("reporting");
  if (e.target.closest("#repPrint")) { if (window.AndroidBT?.printPage) window.AndroidBT.printPage("Vehicle report " + vehName()); else window.print(); }
  if (e.target.closest("#repJson") || e.target.closest("#expJson")) exportJson();
  if (e.target.closest("#expReport")) openReport();
  if (e.target.closest("#expTripsCsv")) exportTripsCsv();
});
function exportJson() {
  const v = VEH(), data = {generated: new Date().toISOString(), vehicle: {...v}, info: S?.info, dtc: S?.dtc, readiness: S?.readiness, freeze: S?.freeze,
    voltage: S?.voltage, battery_tests: S?.bat_tests, mode06: S?.mode06, live: S?.live, trips: (window.TRIPS?.tripsFor(v.id) || []).map(s => window.TRIPS.get(s.id) || s)};
  saveFile(`obd-${vehName(v).replace(/\W+/g, "-")}-${new Date().toISOString().slice(0, 10)}.json`, "application/json", JSON.stringify(data, null, 1));
}
const TRIP_COLS = ["id", "vehicle", "start", "end", "duration_min", "distance_km", "gps_distance_km", "fuel_l", "km_per_l", "l_per_100km", "cost", "currency",
  "fuel_price", "avg_speed_kmh", "top_speed_kmh", "max_rpm", "avg_rpm", "max_engine_temp_c", "idle_min", "hard_accel", "hard_brake",
  "start_lat", "start_lon", "end_lat", "end_lon", "start_map", "end_map", "fuel_source", "new_codes"];
function tripRow(tr) {
  return {id: tr.id, vehicle: tr.vehName, start: isoT(tr.start), end: isoT(tr.end), duration_min: +(tr.durS / 60).toFixed(1), distance_km: +tr.distKm.toFixed(2),
    gps_distance_km: tr.gpsKm ? +tr.gpsKm.toFixed(2) : "", fuel_l: +tr.fuelL.toFixed(3), km_per_l: tr.kmpl ? +tr.kmpl.toFixed(2) : "", l_per_100km: tr.l100 ? +tr.l100.toFixed(2) : "",
    cost: +(tr.cost || 0).toFixed(2), currency: tr.currency, fuel_price: tr.price, avg_speed_kmh: +(tr.avgSpeed || 0).toFixed(1), top_speed_kmh: tr.topSpeed,
    max_rpm: Math.round(tr.maxRpm), avg_rpm: Math.round(tr.avgRpm || 0), max_engine_temp_c: tr.maxTemp ?? "", idle_min: +(tr.idleS / 60).toFixed(1),
    hard_accel: tr.hardAccel, hard_brake: tr.hardBrake, start_lat: tr.startLoc?.[0] ?? "", start_lon: tr.startLoc?.[1] ?? "", end_lat: tr.endLoc?.[0] ?? "", end_lon: tr.endLoc?.[1] ?? "",
    start_map: tr.startLoc ? `https://www.google.com/maps?q=${tr.startLoc[0]},${tr.startLoc[1]}` : "", end_map: tr.endLoc ? `https://www.google.com/maps?q=${tr.endLoc[0]},${tr.endLoc[1]}` : "",
    fuel_source: tr.fuelSource, new_codes: (tr.newCodes || []).join(" ")};
}
function exportTripsCsv() {
  const trips = (window.TRIPS?.index || []).map(s => window.TRIPS.get(s.id)).filter(Boolean);
  if (!trips.length) return toast("No trips recorded yet.", false);
  saveFile(`trips-${new Date().toISOString().slice(0, 10)}.csv`, "text/csv", TRIP_COLS.join(",") + "\n" + trips.map(t => { const r = tripRow(t); return TRIP_COLS.map(c => csvCell(r[c])).join(","); }).join("\n"));
}

// ---------------------------------------------------------------- Google Sheets sync (via the user's own Apps Script web app)
const sstore = {
  get(k, d) { try { const v = localStorage.getItem("obdsync:" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("obdsync:" + k, JSON.stringify(v)); } catch (e) {} },
};
const APPS_SCRIPT = `// OBD Dashboard → Google Sheets. Paste into Extensions → Apps Script of a new Google Sheet.
// 1) Change SECRET below. 2) Deploy → New deployment → Web app: Execute as "Me", Who has access "Anyone".
// 3) Copy the web-app URL into the app (Export & sync tab) with the same secret.
const SECRET = 'change-me-to-something-long';
const TRIP_COLS = ${JSON.stringify(TRIP_COLS)};
const HEALTH_COLS = ["time","vehicle","vin","mil","stored_codes","pending_codes","battery_v","ecu_km","coolant_c"];
function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  if (data.secret !== SECRET) return out({ok: false, error: 'wrong secret'});
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const trips = sheet(ss, 'Trips', TRIP_COLS), health = sheet(ss, 'Health', HEALTH_COLS);
  const have = new Set(trips.getLastRow() > 1 ? trips.getRange(2, 1, trips.getLastRow() - 1, 1).getValues().flat() : []);
  let added = 0;
  (data.trips || []).forEach(t => { if (!have.has(t.id)) { trips.appendRow(TRIP_COLS.map(c => t[c] ?? '')); added++; } });
  if (data.health) health.appendRow(HEALTH_COLS.map(c => data.health[c] ?? ''));
  return out({ok: true, added});
}
function doGet() { return out({ok: true, hello: 'OBD Dashboard sync is set up'}); }
function sheet(ss, name, cols) { const s = ss.getSheetByName(name) || ss.insertSheet(name); if (s.getLastRow() === 0) { s.appendRow(cols); s.setFrozenRows(1); } return s; }
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }`;
async function sheetsPost(payload) {
  const cfg = sstore.get("cfg", {}); if (!cfg.url) throw new Error("Add your Apps Script web-app URL first");
  const body = JSON.stringify({...payload, secret: cfg.secret || ""});
  try {
    const r = await fetch(cfg.url, {method: "POST", body});          // text/plain: no CORS preflight
    const j = await r.json(); if (!j.ok) throw new Error(j.error || "rejected"); return j;
  } catch (e) {
    if (/wrong secret|rejected/.test(e.message)) throw e;
    await fetch(cfg.url, {method: "POST", body, mode: "no-cors"});    // fallback: delivered, reply unreadable
    return {ok: true, added: "?"};
  }
}
async function syncNow(manual = true) {
  const cfg = sstore.get("cfg", {}); if (!cfg.url) { if (manual) toast("Set up Google Sheets first (URL + secret).", false); return; }
  const sent = new Set(sstore.get("sent", []));
  const trips = (window.TRIPS?.index || []).filter(s => !sent.has(s.id)).map(s => window.TRIPS.get(s.id)).filter(Boolean).slice(0, 50);
  const v = VEH(), health = S?.connected ? {time: new Date().toISOString(), vehicle: vehName(v), vin: S.info?.vin || v.vin || "", mil: S.readiness?.mil ? "ON" : "off",
    stored_codes: (S.dtc?.stored || []).join(" "), pending_codes: (S.dtc?.pending || []).join(" "), battery_v: S.voltage ?? "", ecu_km: L("31") ?? "", coolant_c: coolantOnly() ?? ""} : null;
  try {
    const r = await sheetsPost({trips: trips.map(tripRow), health});
    trips.forEach(t => sent.add(t.id)); sstore.set("sent", [...sent].slice(-1000));
    sstore.set("last", {t: Date.now(), ok: true, msg: `${trips.length} trip(s) sent${health ? " + health snapshot" : ""}`});
    if (manual) toast(`☁ Synced to Google Sheets: ${trips.length} trip(s)${r.added !== undefined ? ` (${r.added} new rows)` : ""}`, true);
  } catch (e) { sstore.set("last", {t: Date.now(), ok: false, msg: e.message}); if (manual) toast("☁ Sync failed: " + esc(e.message), false, 7000); }
  renderSync(true);
}
let syncKey = "";
function renderSync(force = false) {
  const el = $("#syncBox"); if (!el) return;
  const cfg = sstore.get("cfg", {}), last = sstore.get("last", null), key = JSON.stringify([cfg, last]);
  if (key === syncKey && !force) return; syncKey = key;
  el.innerHTML = `<ol class="muted" style="padding-left:18px;margin-top:0;font-size:13px">
      <li>Create a new Google Sheet → <b>Extensions → Apps Script</b>.</li><li>Paste the script below, change the <b>SECRET</b>, then <b>Deploy → New deployment → Web app</b> (Execute as: Me · Access: Anyone).</li>
      <li>Paste the web-app URL and the same secret here.</li></ol>
    <div class="vgrid"><label class="vf" style="grid-column:1/-1">Apps Script web-app URL<input id="syncUrl" value="${esc(cfg.url || "")}" placeholder="https://script.google.com/macros/s/…/exec"></label>
      <label class="vf">Secret<input id="syncSecret" type="password" value="${esc(cfg.secret || "")}" autocomplete="off"></label>
      <label class="vf">Auto-sync<select id="syncAuto"><option value="1" ${cfg.auto !== false ? "selected" : ""}>After every trip</option><option value="0" ${cfg.auto === false ? "selected" : ""}>Manual only</option></select></label></div>
    <div class="row" style="margin-top:8px"><button class="btn primary" type="button" id="syncSave">Save</button><button class="btn" type="button" id="syncGo">☁ Sync now</button>
      <button class="btn" type="button" id="syncCopy">Copy script</button></div>
    <p class="muted" style="font-size:12px">${last ? `${last.ok ? "✅" : "⚠"} ${new Date(last.t).toLocaleString()}: ${esc(last.msg)}` : "Not synced yet."}
      Data goes only to your own sheet: trips (including GPS start/end) and a health snapshot (codes, battery). Nothing is sent anywhere else.</p>
    <details><summary class="muted" style="cursor:pointer">Show the Apps Script</summary><pre id="syncScript" style="white-space:pre-wrap;font-size:11px;background:var(--panel2);padding:8px;border-radius:8px;max-height:260px;overflow:auto">${esc(APPS_SCRIPT)}</pre></details>`;
}
document.addEventListener("click", e => {
  if (e.target.closest("#syncSave")) {
    const url = $("#syncUrl").value.trim();
    if (url && !/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) return toast("That should be a script.google.com web-app URL", false, 6000);
    sstore.set("cfg", {url, secret: $("#syncSecret").value, auto: $("#syncAuto").value === "1"}); toast("Saved", true, 2000); renderSync(true);
  }
  if (e.target.closest("#syncGo")) syncNow(true);
  if (e.target.closest("#syncCopy")) navigator.clipboard?.writeText(APPS_SCRIPT).then(() => toast("Script copied", true, 2000), () => toast("Copy failed: open 'Show the Apps Script' and copy by hand", false));
});
window.TRIP_HOOKS.push(tr => { if (sstore.get("cfg", {}).url && sstore.get("cfg", {}).auto !== false) syncNow(false); });
// laptop: keep finished trips on the server too (the MCP server reads them from there)
window.TRIP_HOOKS.push(tr => { if (ENGINE?.kind === "server") ENGINE.post("/api/trips", tr).catch(() => {}); });

window.RENDER_HOOKS.push(checkAlerts, perfTick, () => {
  if ($("#trips")?.classList.contains("on")) { renderAlerts(); renderPerf(); }
  if ($("#export")?.classList.contains("on")) renderSync();
});
