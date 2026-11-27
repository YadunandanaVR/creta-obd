/* Trip logbook: records every drive automatically while connected.
 * Start = engine running (RPM > 300); end = engine off for 30 s or connection lost for 2 min.
 * Distance = integrated vehicle speed (plus GPS distance when location is allowed).
 * Fuel = fuel-rate PID if the car has it, else airflow (MAF), else a MAP/IAT/engine-size estimate.
 * Everything is stored on this device only (localStorage) unless the user turns on Google Sheets sync. */
"use strict";
window.RENDER_HOOKS = window.RENDER_HOOKS || [];
window.TRIP_HOOKS = window.TRIP_HOOKS || [];      // called with each finished trip (Sheets sync, laptop server)

const tstore = {
  get(k, d) { try { const v = localStorage.getItem("obdtrip:" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("obdtrip:" + k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem("obdtrip:" + k); } catch (e) {} },
};
let tripIndex = tstore.get("index", []);           // newest first: summaries only
let curTrip = tstore.get("current", null);
let tripStartCount = 0, lastSampleT = null, lastSaveAt = 0, gpsWatch = null, lastSeriesT = 0, prevSpeed = null, prevSpeedT = null;
const idleRpm = [];                                 // recent idle RPM samples, also used by cylinder health

const money = v => `${VEH().currency || "₹"}${(v || 0).toFixed(0)}`;
const hhmm = s => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} h ${m} min` : m ? `${m} min ${s % 60}s` : `${s}s`; };
const tdate = t => new Date(t * 1000);
const nowS = () => Date.now() / 1000;

// --------------------------------------------------------------- fuel model
function fuelRate() {
  const v = VEH(), cal = (+v.fuelCal || 100) / 100, rpm = L("0C") || 0;
  if (rpm < 300) return {lph: 0, src: "engine off"};
  const fr = L("5E");
  if (fr != null) return {lph: fr * cal, src: "fuel-rate sensor"};
  const diesel = v.type === "diesel", dens = diesel ? 832 : 745, afr = diesel ? 14.5 : 14.7;
  if (diesel) return null;                          // diesels run lean at variable ratios: airflow can't give fuel use
  const fs = S.live?.["03"]?.value, thr = L("4C") ?? L("45");
  if (typeof fs === "string" && /decel/i.test(fs) && thr != null && thr < 4 && rpm > 1100) return {lph: 0, src: "fuel cut (coasting)"};
  const lam = L("44"), ratio = afr * (lam && lam > 0.6 && lam < 1.4 ? lam : 1);
  const maf = L("10");
  if (maf != null) return {lph: maf / ratio * 3600 / dens * cal, src: "airflow (MAF)"};
  const map = L("0B"), iat = L("0F");
  if (map != null && iat != null) {
    const air = (rpm / 120) * map * 1000 * ((+v.engineCc || 1500) / 1e6) * 0.85 / (287 * (iat + 273.15)) * 1000;   // g/s
    return {lph: air / ratio * 3600 / dens * cal, src: "manifold pressure estimate"};
  }
  return null;
}
const haversine = (a, b) => { const R = 6371, r = x => x * Math.PI / 180, dLa = r(b[0] - a[0]), dLo = r(b[1] - a[1]);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };

// --------------------------------------------------------------- recorder
function startTrip(t) {
  const v = VEH();
  curTrip = {id: "t" + Math.round(t * 1000).toString(36), vehId: v.id, vehName: vehName(v), vin: v.vin || S.info?.vin || "",
    start: t, lastT: t, distKm: 0, fuelL: 0, fuelKnownS: 0, fuelSrc: {}, durS: 0, idleS: 0, movingS: 0, topSpeed: 0, maxRpm: 0, rpmInt: 0,
    maxTemp: null, tempPid: tempPid(), maxIat: null, minVolt: null, maxVolt: null, hardAccel: 0, hardBrake: 0, buckets: [0, 0, 0, 0, 0],
    series: [], path: [], gpsKm: 0, startLoc: null, endLoc: null, codesAtStart: [...(S.dtc?.stored || [])], price: +v.fuelPrice || 100, currency: v.currency || "₹"};
  tstore.set("current", curTrip);
  startGps();
  toast?.(`🚦 Trip started · ${esc(curTrip.vehName)}`, true, 2500);
}
function finishTrip(reason) {
  const tr = curTrip; curTrip = null; stopGps(); tstore.del("current");
  if (!tr || tr.durS < 45) return;                  // ignore engine blips
  tr.end = tr.lastT; tr.endReason = reason;
  tr.avgSpeed = tr.movingS > 0 ? tr.distKm / (tr.movingS / 3600) : 0;
  tr.avgRpm = tr.durS ? tr.rpmInt / tr.durS : 0;
  tr.fuelCoverage = tr.durS ? tr.fuelKnownS / tr.durS : 0;
  tr.kmpl = tr.fuelL > 0.02 ? tr.distKm / tr.fuelL : null;
  tr.l100 = tr.distKm > 0.2 && tr.fuelL > 0 ? tr.fuelL / tr.distKm * 100 : null;
  tr.cost = tr.fuelL * tr.price;
  tr.newCodes = (S?.dtc?.stored || []).filter(c => !tr.codesAtStart.includes(c));   // S may not exist yet when closing a trip left open last session
  tr.fuelSource = Object.entries(tr.fuelSrc).sort((a, b) => b[1] - a[1])[0]?.[0] || "not available";
  for (const f of window.TRIP_FINALIZERS || []) try { f(tr); } catch (e) { console.error(e); }   // e.g. driving-coach report
  if (!tstore.set("trip:" + tr.id, tr)) {          // storage full: drop the detailed series/route of the oldest trips, then retry
    for (const s of tripIndex.slice(-40)) { const o = tstore.get("trip:" + s.id, null); if (o) { o.series = []; o.path = o.path?.filter((_, i) => i % 4 === 0) || []; tstore.set("trip:" + s.id, o); } }
    tstore.set("trip:" + tr.id, tr);
  }
  tripIndex.unshift(summaryOf(tr));
  while (tripIndex.length > 300) tstore.del("trip:" + tripIndex.pop().id);
  tstore.set("index", tripIndex);
  for (const f of window.TRIP_HOOKS) try { f(tr); } catch (e) { console.error(e); }
  if (typeof toast === "function") toast(`🏁 Trip saved · ${tr.distKm.toFixed(1)} km${tr.kmpl ? ` · ${tr.kmpl.toFixed(1)} km/L` : ""}${tr.fuelL ? ` · ${money(tr.cost)}` : ""}`, true, 6000);
  if (document.querySelector("#tripLive")) renderTrips(true);
}
const summaryOf = tr => ({id: tr.id, vehId: tr.vehId, vehName: tr.vehName, start: tr.start, end: tr.end, distKm: tr.distKm, fuelL: tr.fuelL,
  kmpl: tr.kmpl, cost: tr.cost, currency: tr.currency, topSpeed: tr.topSpeed, maxTemp: tr.maxTemp, durS: tr.durS,
  from: tr.startLoc, to: tr.endLoc, newCodes: tr.newCodes, drive: tr.driving?.score ?? null});

function sampleTrip() {
  const t = S?.live?.["0C"]?.t;
  if (!S?.connected || t == null) {
    if (curTrip && nowS() - curTrip.lastT > 120) finishTrip("connection lost");
    return;
  }
  if (t === lastSampleT) return;
  const dt = lastSampleT ? Math.max(0, Math.min(t - lastSampleT, 10)) : 0;
  lastSampleT = t;
  const rpm = L("0C") || 0, spd = L("0D") || 0;
  if (rpm > 300 && spd === 0) { idleRpm.push(rpm); if (idleRpm.length > 90) idleRpm.shift(); }
  if (!curTrip) { if (rpm > 300) { if (++tripStartCount >= 2) startTrip(t); } else tripStartCount = 0; return; }
  const tr = curTrip;
  if (rpm < 300) { tr.offSince ??= t; if (t - tr.offSince > 30) return finishTrip("engine off"); return; }
  tr.offSince = null; tr.lastT = t;
  if (!dt) return;
  tr.durS += dt; tr.distKm += spd * dt / 3600; tr.rpmInt += rpm * dt;
  if (spd === 0) tr.idleS += dt; else tr.movingS += dt;
  tr.topSpeed = Math.max(tr.topSpeed, spd); tr.maxRpm = Math.max(tr.maxRpm, rpm);
  tr.buckets[spd === 0 ? 0 : spd < 40 ? 1 : spd < 80 ? 2 : spd < 120 ? 3 : 4] += dt;
  const temp = L(tr.tempPid); if (temp != null) tr.maxTemp = tr.maxTemp == null ? temp : Math.max(tr.maxTemp, temp);
  const iat = L("0F"); if (iat != null) tr.maxIat = tr.maxIat == null ? iat : Math.max(tr.maxIat, iat);
  if (S.voltage) { tr.minVolt = tr.minVolt == null ? S.voltage : Math.min(tr.minVolt, S.voltage); tr.maxVolt = Math.max(tr.maxVolt || 0, S.voltage); }
  const f = fuelRate();
  if (f) { tr.fuelL += f.lph * dt / 3600; tr.fuelKnownS += dt; tr.fuelSrc[f.src] = (tr.fuelSrc[f.src] || 0) + dt; }
  // harsh driving: speed change over ≥1 s
  if (prevSpeed != null && t - prevSpeedT >= 1) {
    const a = (spd - prevSpeed) / (t - prevSpeedT);          // km/h per second
    if (a > 11 && t - (tr.lastHarshA || 0) > 4) { tr.hardAccel++; tr.lastHarshA = t; }
    if (a < -13 && t - (tr.lastHarshB || 0) > 4) { tr.hardBrake++; tr.lastHarshB = t; }
    prevSpeed = spd; prevSpeedT = t;
  } else if (prevSpeed == null) { prevSpeed = spd; prevSpeedT = t; }
  if (t - lastSeriesT >= 5) {
    lastSeriesT = t;
    tr.series.push([Math.round(t - tr.start), Math.round(spd), Math.round(rpm), temp == null ? null : Math.round(temp), f ? +f.lph.toFixed(2) : null]);
    if (tr.series.length > 1440) tr.series = tr.series.filter((_, i) => i % 2 === 0);
  }
  if (Date.now() - lastSaveAt > 10000) { lastSaveAt = Date.now(); tstore.set("current", tr); }
}

// --------------------------------------------------------------- GPS (optional)
function startGps() {
  if (VEH().gps === false || !navigator.geolocation || gpsWatch != null) return;
  gpsWatch = navigator.geolocation.watchPosition(p => {
    const tr = curTrip; if (!tr) return;
    const pt = [+p.coords.latitude.toFixed(5), +p.coords.longitude.toFixed(5), Math.round(p.timestamp / 1000)];
    if (p.coords.accuracy > 80) return;              // ignore poor fixes
    if (!tr.startLoc) tr.startLoc = pt.slice(0, 2);
    const last = tr.path[tr.path.length - 1];
    if (!last || haversine(last, pt) > 0.03 || pt[2] - last[2] > 30) {
      if (last) tr.gpsKm += haversine(last, pt);
      tr.path.push(pt); if (tr.path.length > 800) tr.path = tr.path.filter((_, i) => i % 2 === 0);
    }
    tr.endLoc = pt.slice(0, 2);
  }, err => { console.warn("GPS", err.message); }, {enableHighAccuracy: true, maximumAge: 5000, timeout: 20000});
}
function stopGps() { if (gpsWatch != null) { navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null; } }


// --------------------------------------------------------------- UI
const mapsLink = p => p ? `https://www.google.com/maps?q=${p[0]},${p[1]}` : null;
function routeSvg(path, w = 320, h = 180) {
  if (!path || path.length < 2) return `<div class="muted" style="font-size:12px">No GPS route recorded${VEH().gps === false ? " (GPS is off for this vehicle)" : " (allow location to record routes)"}.</div>`;
  const lat0 = path[0][0], k = Math.cos(lat0 * Math.PI / 180);
  const xs = path.map(p => p[1] * k), ys = path.map(p => -p[0]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const s = Math.min((w - 20) / ((maxX - minX) || 1e-6), (h - 20) / ((maxY - minY) || 1e-6));
  const P = path.map((_, i) => [10 + (xs[i] - minX) * s, 10 + (ys[i] - minY) * s]);
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;max-width:${w}px;background:var(--panel2);border-radius:10px">
    <polyline points="${P.map(p => p.map(n => n.toFixed(1)).join(",")).join(" ")}" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${P[0][0]}" cy="${P[0][1]}" r="6" fill="var(--ok)"/><circle cx="${P[P.length - 1][0]}" cy="${P[P.length - 1][1]}" r="6" fill="var(--bad)"/></svg>`;
}
function seriesSvg(series, idx, max, color, label, w = 320, h = 90) {
  const pts = series.filter(p => p[idx] != null); if (pts.length < 2) return "";
  const T = series[series.length - 1][0] || 1, m = max || Math.max(...pts.map(p => p[idx])) || 1;
  return `<div class="muted" style="font-size:11px;margin-top:6px">${label}</div><svg viewBox="0 0 ${w} ${h}" style="width:100%;max-width:${w}px">
    <polyline fill="none" stroke="${color}" stroke-width="2" points="${pts.map(p => `${(p[0] / T * w).toFixed(1)},${(h - 3 - p[idx] / m * (h - 6)).toFixed(1)}`).join(" ")}"/></svg>`;
}
function tripStats(tr, live = false) {
  const st = (k, v, s = "") => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const cov = tr.durS ? tr.fuelKnownS / tr.durS : 0;
  return `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px">
    ${st("Distance", `${tr.distKm.toFixed(1)} km`, tr.gpsKm > 0.1 ? `GPS ${tr.gpsKm.toFixed(1)} km` : "from speed sensor")}
    ${st("Duration", hhmm(tr.durS), `idle ${hhmm(tr.idleS)}`)}
    ${st("Mileage", tr.fuelL > 0.02 ? `${(tr.distKm / tr.fuelL).toFixed(1)} km/L` : "–", tr.distKm > 0.2 && tr.fuelL > 0 ? `${(tr.fuelL / tr.distKm * 100).toFixed(1)} L/100 km` : "")}
    ${st("Fuel used", `${tr.fuelL.toFixed(2)} L`, cov < 0.5 ? "not measurable on this vehicle" : (live ? "estimated live" : "estimated"))}
    ${st("Trip cost", tr.fuelL ? money(tr.fuelL * tr.price) : "–", `at ${tr.currency}${tr.price}/L`)}
    ${st("Avg speed", `${(tr.movingS ? tr.distKm / (tr.movingS / 3600) : 0).toFixed(0)} km/h`, "while moving")}
    ${st("Top speed", `${Math.round(tr.topSpeed)} km/h`)}
    ${st("Max RPM", Math.round(tr.maxRpm).toLocaleString(), `avg ${Math.round(tr.durS ? tr.rpmInt / tr.durS : 0)}`)}
    ${st(TEMP_LABEL[tr.tempPid] ? "Max " + TEMP_LABEL[tr.tempPid].toLowerCase().replace(" temperature", " temp") : "Max engine temp", tr.maxTemp != null ? `${tr.maxTemp} °C` : "–")}
    ${st("Harsh driving", `${tr.hardAccel} / ${tr.hardBrake}`, "hard accel / hard brake")}
    ${st("Battery", tr.minVolt ? `${tr.minVolt.toFixed(1)}–${(tr.maxVolt || 0).toFixed(1)} V` : "–", "min–max while driving")}
  </div>`;
}
function openTrip(id) {
  const tr = tstore.get("trip:" + id, null); if (!tr) return;
  const b = tr.buckets || [], tot = b.reduce((a, x) => a + x, 0) || 1;
  const bucket = ["Stopped", "1–40", "40–80", "80–120", "120+"].map((n, i) => `<div style="flex:${Math.max(b[i] / tot, 0.001)};background:${["var(--muted)", "var(--accent)", "var(--ok)", "var(--warn)", "var(--bad)"][i]};height:10px" title="${n} km/h: ${hhmm(b[i])}"></div>`).join("");
  warnBox(`${tdate(tr.start).toLocaleDateString()} · ${tdate(tr.start).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})} → ${tdate(tr.end).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})}`, `
    <div class="muted" style="margin:-6px 0 8px">${esc(tr.vehName)} · fuel from ${esc(tr.fuelSource)}${tr.endReason ? " · ended: " + esc(tr.endReason) : ""}</div>
    ${tripStats(tr)}
    <div class="muted" style="font-size:11px;margin-top:10px">Time at speed (stopped · 1–40 · 40–80 · 80–120 · 120+ km/h)</div>
    <div style="display:flex;border-radius:5px;overflow:hidden;margin-top:4px">${bucket}</div>
    <h4 style="margin:12px 0 4px">Route</h4>${routeSvg(tr.path)}
    <div class="row" style="margin-top:6px;font-size:13px">${tr.startLoc ? `<a href="${mapsLink(tr.startLoc)}" target="_blank" rel="noopener" style="color:var(--ok)">● Start on map</a>` : ""}
      ${tr.endLoc ? `<a href="${mapsLink(tr.endLoc)}" target="_blank" rel="noopener" style="color:var(--bad)">● End on map</a>` : ""}</div>
    ${seriesSvg(tr.series, 1, null, "var(--accent)", "Speed")}${seriesSvg(tr.series, 3, null, "var(--warn)", "Engine temperature")}${seriesSvg(tr.series, 2, null, "var(--needle)", "RPM")}
    ${window.drivingHtml ? window.drivingHtml(tr) : ""}
    ${tr.newCodes?.length ? `<div class="warnbox bad" style="margin-top:10px"><h4 style="margin:0">New trouble codes during this trip</h4><p style="margin:4px 0 0">${tr.newCodes.join(", ")}</p></div>` : ""}
    <div class="row" style="justify-content:space-between;margin-top:12px">
      <button class="btn danger" type="button" data-deltrip="${tr.id}">Delete trip</button>
      <button class="btn" type="button" data-exptrip="${tr.id}">Export this trip</button></div>`);
  $("#wdB").onclick = e => {
    const d = e.target.closest("[data-deltrip]"), x = e.target.closest("[data-exptrip]");
    if (d && confirm("Delete this trip?")) { tstore.del("trip:" + id); tripIndex = tripIndex.filter(s => s.id !== id); tstore.set("index", tripIndex); $("#warnDlg").close(); renderTrips(true); }
    if (x) window.saveFile?.(`trip-${tdate(tr.start).toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`, "application/json", JSON.stringify(tr, null, 1));
  };
}
function tripsFor(vehId) { return tripIndex.filter(s => !vehId || s.vehId === vehId); }
function totals(list) {
  const km = list.reduce((a, s) => a + (s.distKm || 0), 0), L_ = list.reduce((a, s) => a + (s.fuelL || 0), 0), cost = list.reduce((a, s) => a + (s.cost || 0), 0);
  return {n: list.length, km, L: L_, cost, kmpl: L_ > 0.1 ? km / L_ : null, durS: list.reduce((a, s) => a + (s.durS || 0), 0)};
}
let tripsListKey = "";
function renderTrips(force = false) {
  if (!document.querySelector("#trips")) return;
  const tr = curTrip;
  $("#tripLive").innerHTML = tr
    ? `<div class="row" style="margin-bottom:8px"><span class="tag ok">● Recording</span><span class="muted">since ${tdate(tr.start).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})} · ${esc(tr.vehName)} · fuel from ${esc(fuelRate()?.src || "n/a")}</span></div>${tripStats(tr, true)}`
    : `<p class="muted" style="margin:0">${S?.connected ? "Waiting for the engine to start. A trip begins automatically when RPM rises." : "Connect to the adapter. Trips record automatically while you drive."}</p>`;
  const v = VEH(), mine = tripsFor(v.id), key = [force, mine.length, mine[0]?.id, v.id, v.fuelPrice].join("|");
  if (key === tripsListKey && !force) return; tripsListKey = key;
  const month = new Date(); month.setDate(1); month.setHours(0, 0, 0, 0);
  const tm = totals(mine.filter(s => s.start * 1000 >= month)), ta = totals(mine);
  const sum = (lbl, t) => `<div class="stat"><div class="k">${lbl}</div><div class="v">${t.km.toFixed(t.km < 100 ? 1 : 0)} km</div><div class="s">${t.n} trips · ${t.kmpl ? t.kmpl.toFixed(1) + " km/L" : "– km/L"} · ${money(t.cost)}</div></div>`;
  $("#tripSummary").innerHTML = sum("This month", tm) + sum("All time", ta) +
    `<div class="stat"><div class="k">Fuel price</div><div class="v">${v.currency || "₹"}${v.fuelPrice || 100}/L</div><div class="s"><a href="#" id="tripPrice" style="color:var(--accent)">change</a> · calibration ${v.fuelCal || 100}%</div></div>`;
  $("#tripList").innerHTML = mine.length ? mine.slice(0, 60).map(s => `
    <div class="dtc" data-trip="${s.id}" style="cursor:pointer;margin-top:8px"><div class="row">
      <b>${tdate(s.start).toLocaleDateString([], {day: "numeric", month: "short"})} · ${tdate(s.start).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})}</b>
      <span class="muted">${hhmm(s.durS)}</span><span class="spacer" style="flex:1"></span>
      <b>${(s.distKm || 0).toFixed(1)} km</b></div>
      <div class="muted" style="font-size:12.5px;margin-top:3px">${s.kmpl ? s.kmpl.toFixed(1) + " km/L · " : ""}${s.fuelL ? (s.fuelL).toFixed(2) + " L · " + money(s.cost) + " · " : ""}${s.drive != null ? `🎓 ${s.drive}/100 · ` : ""}top ${Math.round(s.topSpeed || 0)} km/h${s.maxTemp != null ? " · max " + s.maxTemp + " °C" : ""}${s.newCodes?.length ? ` · <span style="color:var(--bad)">⚠ ${s.newCodes.join(", ")}</span>` : ""}</div></div>`).join("")
    : `<p class="muted">No trips yet for ${esc(vehName(v))}.</p>`;
}
document.addEventListener("click", e => {
  const t = e.target.closest("[data-trip]"); if (t) openTrip(t.dataset.trip);
  if (e.target.closest("#tripPrice")) { e.preventDefault(); const p = prompt(`Fuel price per litre (${VEH().currency || "₹"}):`, VEH().fuelPrice || 100); if (p && +p > 0) { VEH().fuelPrice = +p; saveVehicles(); renderTrips(true); } }
});
// Fill-up calibration: litres actually added at the pump vs what the app estimated since the last fill-up
document.addEventListener("click", e => {
  if (!e.target.closest("#tripCalBtn")) return;
  const v = VEH(), since = v.calMark || 0, est = tripsFor(v.id).filter(s => s.start > since).reduce((a, s) => a + (s.fuelL || 0), 0);
  if (!since) { v.calMark = nowS(); saveVehicles(); return toast("⛽ Fill-up marked. After your <b>next</b> full tank, tap this again and enter the litres the pump showed.", true, 9000); }
  if (est < 3) return toast(`Only ${est.toFixed(1)} L estimated since the last fill-up mark. Drive more first (at least about 3 L).`, false, 7000);
  const actual = parseFloat(prompt(`The app estimated ${est.toFixed(1)} L since your last fill-up mark.\nHow many litres did the pump show to fill up again?`) || "");
  if (!(actual > 0)) return;
  v.fuelCal = Math.round(Math.max(50, Math.min(200, (+v.fuelCal || 100) * actual / est)));
  v.calMark = nowS(); saveVehicles(); renderTrips(true);
  toast(`✅ Fuel calibration set to ${v.fuelCal}%. Mileage figures now match your pump readings.`, true, 7000);
});
window.RENDER_HOOKS.push(sampleTrip, () => { if ($("#trips")?.classList.contains("on")) renderTrips(); });
// resume or close a trip left open when the app was closed (runs last: everything above must be initialised)
try { if (curTrip) { if (nowS() - curTrip.lastT > 600) finishTrip("app closed"); else startGps(); } } catch (e) { console.error("trip resume", e); }
window.TRIPS = {get index() { return tripIndex; }, get: id => tstore.get("trip:" + id, null),
  // restore trips from a JSON backup (export file); skips ones already on this device
  restore(list) {
    let added = 0;
    for (const tr of list) {
      if (!tr?.id || !tr.start || tripIndex.some(s => s.id === tr.id)) continue;
      tstore.set("trip:" + tr.id, tr); tripIndex.push(summaryOf(tr)); added++;
    }
    tripIndex.sort((a, b) => b.start - a.start); tstore.set("index", tripIndex); renderTrips(true); return added;
  }, get current() { return curTrip; }, idleRpm, fuelRate, totals, tripsFor};
