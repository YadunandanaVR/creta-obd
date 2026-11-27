/* Driving coach: clutch, gear-shift, acceleration and braking technique — inferred from standard OBD data.
 *
 * OBD has no clutch-pedal, brake-pedal or gear signal. But in gear, RPM ÷ road speed is a fixed ratio per gear,
 * so the app learns the gear ratios while you drive. When the ratio matches no gear, the clutch is down or slipping:
 * that reveals riding the clutch, slow/rough shifts, rev flare, coasting in neutral. RPM, speed, load and the
 * accelerator pedal add lugging, over-revving, high-rev launches, stalls, harsh acceleration/braking and jerky throttle.
 * Results are estimates — the report says so. */
"use strict";
window.RENDER_HOOKS = window.RENDER_HOOKS || [];
window.TRIP_FINALIZERS = window.TRIP_FINALIZERS || [];

const TX = {manual: "Manual", amt: "AMT (auto-clutch manual)", auto: "Automatic (torque converter)", cvt: "CVT / IVT", dct: "DCT (dual clutch)"};
const hasClutchPedal = () => (VEH().transmission || "manual") === "manual";
const geared = () => !["cvt"].includes(VEH().transmission || "manual");

// event types: [label, penalty points per event, tip]
const EV = {
  riding:   ["Riding the clutch", 6, "Clutch was slipping for a long time while accelerating. Release the clutch fully once you're moving; resting a foot on it wears the clutch plate fast."],
  slowShift:["Slow gear change", 1, "Shifts taking over 1.5 s. Practise a quicker, smooth clutch-in → shift → clutch-out."],
  flare:    ["Rev flare during shift", 2, "Engine revs jumped while the clutch was down — accelerator pressed too early. Lift off the pedal while shifting, then feed it back in as the clutch bites."],
  lug:      ["Engine lugging", 3, "High load at very low RPM (too high a gear). Downshift on climbs or when accelerating; lugging strains the engine and clutch."],
  overRev:  ["Over-revving", 4, "Close to the red zone. Shift up earlier — most petrol engines are efficient between 2,000 and 3,000 rpm."],
  launch:   ["High-rev launch", 3, "Pulling away at very high RPM slips the clutch hard. Use 1,200–1,800 rpm and release the clutch smoothly."],
  stall:    ["Engine stall", 5, "The engine stalled. Give a little more throttle when pulling away and release the clutch more slowly at the biting point."],
  coast:    ["Coasting in neutral / clutch down", 2, "Rolling with the clutch down or in neutral removes engine braking and control. Stay in gear when slowing down."],
  hardAcc:  ["Harsh acceleration", 2, "Sudden hard acceleration costs fuel and wears tyres. Build speed progressively."],
  hardBrk:  ["Harsh braking", 3, "Very hard braking. Look further ahead and ease off earlier to brake gently."],
  jerky:    ["Jerky throttle", 1, "Stabbing the accelerator. Smooth pedal inputs save fuel and are kinder to the clutch and mounts."],
  overlap:  ["Accelerator during hard braking", 3, "The accelerator was pressed while slowing hard — possible pedal overlap. Keep the right foot on one pedal at a time."],
  downRev:  ["Harsh downshift", 3, "RPM shot up after a downshift (gear too low for the speed). Match revs or choose a higher gear."],
};

// ------------------------------------------------------------------ gear learning (RPM ÷ speed clusters)
let ratioSamples = [], lastR = null;
function learnGears() {
  if (ratioSamples.length < 60) return;
  const logs = ratioSamples.map(r => Math.log(r)), bin = Math.log(1.03), min = Math.min(...logs), counts = {};
  logs.forEach(l => { const b = Math.round((l - min) / bin); counts[b] = (counts[b] || 0) + 1; });
  const keys = Object.keys(counts).map(Number).sort((a, b) => a - b), need = Math.max(6, ratioSamples.length * 0.03);
  const peaks = [];
  for (const k of keys) {
    const c = counts[k] + (counts[k - 1] || 0) * 0.5 + (counts[k + 1] || 0) * 0.5;
    if (counts[k] >= (counts[k - 1] || 0) && counts[k] >= (counts[k + 1] || 0) && c >= need) {
      // centroid of the neighbourhood
      let s = 0, w = 0; for (let j = k - 1; j <= k + 1; j++) { s += (counts[j] || 0) * (min + j * bin); w += counts[j] || 0; }
      const r = Math.exp(s / w); if (!peaks.some(p => Math.abs(p / r - 1) < 0.08)) peaks.push(r);
    }
  }
  if (peaks.length >= 2) { VEH().gearRatios = peaks.sort((a, b) => b - a).slice(0, 7).map(r => +r.toFixed(1)); saveVehicles(); }
}
function gearOf(r) {
  const g = VEH().gearRatios; if (!g?.length || !r) return -1;
  let best = -1, err = 1; g.forEach((x, i) => { const e = Math.abs(r / x - 1); if (e < err) { err = e; best = i; } });
  return err < 0.075 ? best : -1;
}

// gear number to show: if the lowest gear hasn't been seen yet (car 1st gear ≈ 100–130 rpm per km/h), start numbering at 2
const gearOffset = () => { const g = VEH().gearRatios; return g?.length && !isTwoWheeler() && g[0] < 85 ? 2 : 1; };
const gearName = i => i + gearOffset();

// ------------------------------------------------------------------ live analysis
let st = null, lastT = null, coachLast = {};
function freshState() { return {events: [], counts: {}, shifts: 0, upRpm: [], slip: null, gear: -1, gearRpm: 0, lugT: 0, prevRpm: 0, prevSpd: 0, prevT: 0,
  movedAt: 0, pedalMin: 100, pedalHist: [], lastEv: {}, gearTime: {}, kmManual: 0}; }
function addEv(type, t, info = {}) {
  if (t - (st.lastEv[type] || 0) < (type === "riding" || type === "lug" ? 8 : 4)) return;
  st.lastEv[type] = t; st.counts[type] = (st.counts[type] || 0) + 1;
  const tr = window.TRIPS?.current; st.events.push({type, t: tr ? Math.round(t - tr.start) : 0, ...info}); if (st.events.length > 300) st.events.shift();
  if (VEH().coachLive !== false && ["riding", "stall", "lug", "flare", "overRev", "downRev"].includes(type) && Date.now() - (coachLast[type] || 0) > 45000) {
    coachLast[type] = Date.now(); toast(`🎓 <b>${EV[type][0]}</b>: ${esc(EV[type][2].split(".")[0])}.`, false, 6000);
  }
}
function sample() {
  const tr = window.TRIPS?.current, t = S?.live?.["0C"]?.t;
  if (!tr) { st = null; return; }
  if (!st || st.trip !== tr.id) { st = freshState(); st.trip = tr.id; }
  if (t == null || t === lastT) return; lastT = t;
  const rpm = L("0C") || 0, spd = L("0D") || 0, load = L("04") || 0, pedal = L("49") ?? L("11"), v = VEH();
  const dt = st.prevT ? Math.min(3, t - st.prevT) : 0;
  // acceleration over ≥1 s (speed has 1 km/h resolution, so very short gaps would exaggerate it)
  st.spdHist = (st.spdHist || []).filter(p => t - p[0] < 2.5); st.spdHist.push([t, spd]);
  const ref = st.spdHist.find(p => t - p[0] >= 0.9), acc = ref ? (spd - ref[1]) / (t - ref[0]) : 0;   // km/h per s
  if (pedal != null) { st.pedalMin = Math.min(st.pedalMin, pedal); st.pedalHist.push([t, pedal]); st.pedalHist = st.pedalHist.filter(p => t - p[0] < 1.3); }
  const pedalRel = pedal != null ? pedal - st.pedalMin : 0;
  if (spd > 3) st.movedAt = t;
  // stall: RPM collapses while (nearly) stopped, shortly after moving or pulling away
  if (st.prevRpm > 450 && rpm < 250 && spd < 15 && t - st.movedAt < 8) addEv("stall", t, {rpm: Math.round(st.prevRpm)});
  // launch with very high revs (manual / AMT: clutch slip)
  if (geared() && spd > 0 && spd < 8 && rpm > 2900 && acc > 0) addEv("launch", t, {rpm: Math.round(rpm)});
  if (rpm >= v.redline - 200) addEv("overRev", t, {rpm: Math.round(rpm)});
  if (ref && acc > 11) addEv("hardAcc", t, {acc: +acc.toFixed(1)});
  if (ref && acc < -13) addEv("hardBrk", t, {acc: +acc.toFixed(1)});
  if (ref && acc < -9 && pedalRel > 18) addEv("overlap", t, {pedal: Math.round(pedalRel)});
  if (st.pedalHist.length > 1 && Math.abs(st.pedalHist[st.pedalHist.length - 1][1] - st.pedalHist[0][1]) > 35) { addEv("jerky", t); st.pedalHist = []; }
  // gear / clutch analysis (needs steady-ish driving above walking pace)
  if (geared() && spd >= 10 && rpm > 600) {
    const r = rpm / spd;
    if (lastR && Math.abs(r / lastR - 1) < 0.035 && Math.abs(acc) < 6) { ratioSamples.push(r); if (ratioSamples.length > 3000) ratioSamples.shift(); if (ratioSamples.length % 40 === 0) learnGears(); }
    lastR = r;
    const g0 = gearOf(r);
    // a gear only counts after 2 matching samples in a row: a slipping clutch sweeps through other gears' ratios
    if (g0 === st.candG) st.candN++; else { st.candG = g0; st.candN = 1; }
    const g = g0 >= 0 && st.candN >= 2 ? g0 : -1;
    if (g0 >= 0 && g < 0 && !st.slip) { st.prevRpm = rpm; st.prevSpd = spd; st.prevT = t; return; }   // wait for confirmation
    if (g >= 0) {
      if (st.slip) {
        const dur = t - st.slip.t0;
        if (dur >= 2.5 && st.slip.pedalMax > 10 && st.slip.gainSpd > 3 && hasClutchPedal()) addEv("riding", t, {secs: +dur.toFixed(1)});
        else if (st.gear >= 0 && g !== st.gear) {
          st.shifts++;
          if (g > st.gear) st.upRpm.push(Math.round(st.gearRpm));
          if (dur > 1.5 && hasClutchPedal()) addEv("slowShift", t, {secs: +dur.toFixed(1), from: gearName(st.gear), to: gearName(g)});
          if (st.slip.flare && hasClutchPedal()) addEv("flare", t, {from: gearName(st.gear), to: gearName(g)});
          if (g < st.gear && rpm > Math.min(v.redline - 500, 4500) && rpm > st.gearRpm * 1.5) addEv("downRev", t, {rpm: Math.round(rpm), to: gearName(g)});
        }
        st.slip = null;
      } else if (st.gear >= 0 && g !== st.gear) {                      // shift completed between two samples
        st.shifts++; if (g > st.gear) st.upRpm.push(Math.round(st.gearRpm));
        if (g < st.gear && rpm > Math.min(v.redline - 500, 4500) && rpm > st.gearRpm * 1.5) addEv("downRev", t, {rpm: Math.round(rpm), to: gearName(g)});
      }
      st.gear = g; st.gearRpm = rpm; st.gearTime[g] = (st.gearTime[g] || 0) + dt;
      if (rpm < 1250 && load > 70) { st.lugT += dt; if (st.lugT > 2) { addEv("lug", t, {rpm: Math.round(rpm), gear: gearName(g)}); st.lugT = 0; } } else st.lugT = 0;
    } else if (v.gearRatios?.length >= 2) {
      st.slip ||= {t0: t, pedalMax: 0, flare: false, spd0: spd, gainSpd: 0, maxRpm: rpm};
      st.slip.pedalMax = Math.max(st.slip.pedalMax, pedalRel); st.slip.gainSpd = Math.max(st.slip.gainSpd, spd - st.slip.spd0);
      st.slip.maxRpm = Math.max(st.slip.maxRpm, rpm);
      if (st.gearRpm && rpm > st.gearRpm + 500 && pedalRel > 15) st.slip.flare = true;
      if (t - st.slip.t0 > 4 && pedalRel < 3 && spd > 25 && rpm < (v.idleMax || 900) + 250 && !st.slip.coasted) { st.slip.coasted = true; addEv("coast", t, {kmh: Math.round(spd)}); }
    }
  } else if (spd < 10) { st.slip = null; st.gear = spd < 3 ? -1 : st.gear; lastR = null; }
  st.prevRpm = rpm; st.prevSpd = spd; st.prevT = t;
}

function scoreOf(counts, km) {
  const pen = Object.entries(counts).reduce((a, [k, n]) => a + (EV[k]?.[1] || 0) * n, 0);
  return Math.max(0, Math.round(100 - pen * 10 / Math.max(5, km)));      // penalties per 10 km driven
}
const gradeOf = s => s >= 90 ? ["Excellent", "ok"] : s >= 75 ? ["Good", "ok"] : s >= 60 ? ["Fair", "warn"] : ["Needs practice", "bad"];
window.TRIP_FINALIZERS.push(tr => {
  if (!st || st.trip !== tr.id) return;
  const up = st.upRpm.length ? Math.round(st.upRpm.reduce((a, b) => a + b, 0) / st.upRpm.length) : null;
  tr.driving = {score: scoreOf(st.counts, tr.distKm), counts: st.counts, events: st.events.slice(-120), shifts: st.shifts, avgUpshiftRpm: up,
    transmission: VEH().transmission || "manual", gears: VEH().gearRatios || null, gearTime: st.gearTime};
  st = null;
});

// ------------------------------------------------------------------ UI
function drivingHtml(tr) {
  const d = tr.driving;
  if (!d) return tr.distKm > 0.5 ? `<div class="muted" style="font-size:12px;margin-top:10px">No driving-coach data for this trip.</div>` : "";
  const [g, c] = gradeOf(d.score), list = Object.entries(d.counts).sort((a, b) => EV[b[0]][1] * b[1] - EV[a[0]][1] * a[1]);
  const fmtT = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return `<h4 style="margin:14px 0 6px">🎓 Driving technique</h4>
    <div class="row"><span style="font-size:30px;font-weight:800;color:var(--${c})">${d.score}</span><span class="muted">/100 · <b style="color:var(--${c})">${g}</b> · ${TX[d.transmission] || d.transmission}
      · ${d.shifts} gear changes${d.avgUpshiftRpm ? ` · avg upshift at ${d.avgUpshiftRpm.toLocaleString()} rpm` : ""}</span></div>
    ${list.length ? `<table style="margin-top:6px">${list.map(([k, n]) => `<tr><td>${EV[k][0]}</td><td class="num"><b>${n}×</b></td></tr><tr><td colspan="2" class="muted" style="font-size:12px;border-bottom:1px solid var(--line)">💡 ${EV[k][2]}</td></tr>`).join("")}</table>`
      : `<p style="color:var(--ok);margin:6px 0">✅ Smooth driving: no clutch, shift, acceleration or braking issues detected.</p>`}
    ${d.events?.length ? `<details style="margin-top:6px"><summary class="muted" style="cursor:pointer">Timeline (${d.events.length} events)</summary>
      <table>${d.events.slice(0, 60).map(e => `<tr><td class="pid">${fmtT(e.t)}</td><td>${EV[e.type][0]}${e.secs ? ` · ${e.secs}s` : ""}${e.rpm ? ` · ${e.rpm} rpm` : ""}${e.to ? ` · gear ${e.from ? e.from + "→" : ""}${e.to}` : ""}${e.acc ? ` · ${e.acc} km/h/s` : ""}</td></tr>`).join("")}</table></details>` : ""}
    <p class="muted" style="font-size:11.5px">Estimated from RPM ÷ speed, load and the accelerator pedal. OBD has no clutch, brake-pedal or gear sensor, so treat single events as hints and look at the trend.</p>`;
}
window.drivingHtml = drivingHtml;

let coachKey = "";
function renderCoach() {
  const el = $("#coachBox"); if (!el) return;
  const v = VEH(), tx = v.transmission || "manual", gears = v.gearRatios || [], liveG = st && st.gear >= 0 ? gearName(st.gear) : null;
  const scores = (window.TRIPS?.tripsFor(v.id) || []).filter(s => s.drive != null).slice(0, 12);
  const key = JSON.stringify([tx, gears, liveG, scores.map(s => s.drive), st?.slip ? 1 : 0, Object.keys(st?.counts || {}).length, v.coachLive, ratioSamples.length >> 5]);
  if (key === coachKey) return; coachKey = key;
  const avg = scores.length ? Math.round(scores.reduce((a, s) => a + s.drive, 0) / scores.length) : null;
  el.innerHTML = `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px">
      <div class="stat"><div class="k">Gearbox</div><div class="v" style="font-size:16px">${TX[tx]}</div><div class="s"><a href="#" id="coachTx" style="color:var(--accent)">change</a></div></div>
      <div class="stat"><div class="k">Current gear (estimated)</div><div class="v">${!geared() ? "–" : liveG ? liveG : st?.slip ? "clutch" : "–"}</div><div class="s">${geared() ? (gears.length ? `${gears.length} gears learned` : `learning… ${Math.min(99, Math.round(ratioSamples.length / 0.6))}%`) : "continuously variable"}</div></div>
      <div class="stat"><div class="k">This trip</div><div class="v">${st ? scoreOf(st.counts, window.TRIPS?.current?.distKm || 0) : "–"}</div><div class="s">${st ? Object.values(st.counts).reduce((a, b) => a + b, 0) + " event(s) so far" : "starts with the next drive"}</div></div>
      <div class="stat"><div class="k">Average score</div><div class="v" style="color:var(--${avg == null ? "muted" : gradeOf(avg)[1]})">${avg ?? "–"}</div><div class="s">last ${scores.length} trip(s)</div></div></div>
    ${scores.length > 1 ? `<svg viewBox="0 0 300 50" style="width:100%;max-width:420px;height:50px;margin-top:8px"><polyline fill="none" stroke="var(--accent)" stroke-width="2" points="${scores.slice().reverse().map((s, i, a) => `${(i / (a.length - 1) * 296 + 2).toFixed(0)},${(48 - s.drive / 100 * 46).toFixed(0)}`).join(" ")}"/></svg><div class="muted" style="font-size:11px">score trend (oldest → newest)</div>` : ""}
    ${gears.length ? `<div class="muted" style="font-size:12px;margin-top:8px">Learned gear ratios (rpm per km/h): ${gears.map((r, i) => `<b>${gearName(i)}</b> ${r}`).join(" · ")} <a href="#" id="coachRelearn" style="color:var(--accent)">re-learn</a></div>` : ""}
    <label style="display:flex;gap:8px;align-items:center;margin-top:10px;font-size:13px"><input type="checkbox" id="coachLive" ${v.coachLive !== false ? "checked" : ""}> Live coaching pop-ups (stall, riding the clutch, lugging, rev flare, over-revving)</label>
    <p class="muted" style="font-size:12px;margin-bottom:0">Every trip gets a technique score and tips (open a trip below). ${hasClutchPedal() ? "Clutch checks use the gap between engine and wheel speed while shifting." : "Clutch checks are off for this gearbox type; acceleration, braking and throttle checks still run."}</p>`;
}
document.addEventListener("click", e => {
  if (e.target.closest("#coachRelearn")) { e.preventDefault(); VEH().gearRatios = []; ratioSamples = []; saveVehicles(); coachKey = ""; toast("Gear ratios reset. They'll be re-learned as you drive.", true); }
  if (e.target.closest("#coachTx")) {
    e.preventDefault();
    warnBox("Gearbox type", `<div class="grid" style="gap:8px">${Object.entries(TX).map(([k, n]) => `<button class="btn${(VEH().transmission || "manual") === k ? " primary" : ""}" type="button" data-tx="${k}" style="text-align:left">${n}</button>`).join("")}</div>
      <p class="muted" style="font-size:12px">Manual enables clutch checks. Automatic / AMT / DCT still get gear-shift, acceleration and braking analysis; CVT / IVT (continuously variable) skips gear analysis.</p>`);
    $("#wdB").onclick = ev => { const b = ev.target.closest("[data-tx]"); if (!b) return; VEH().transmission = b.dataset.tx; VEH().gearRatios = []; ratioSamples = []; saveVehicles(); coachKey = ""; $("#warnDlg").close(); renderCoach(); };
  }
});
document.addEventListener("change", e => { if (e.target.id === "coachLive") { VEH().coachLive = e.target.checked; saveVehicles(); } });
window.RENDER_HOOKS.push(sample, () => { if ($("#trips")?.classList.contains("on")) renderCoach(); });
window.COACH = {get state() { return st; }, EV, scoreOf, gradeOf, TX};
