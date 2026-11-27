/* "Under the hood": a CSS-3D glass engine driven by live data, sensor readings grouped by system,
 * cylinder health, and a subtle 3D tilt for the dashboard gauges. Pure CSS 3D: no libraries,
 * works offline in the Android app, the browser and on the laptop. */
"use strict";
window.RENDER_HOOKS = window.RENDER_HOOKS || [];

(function injectCss() {
  const css = `
  .e3-wrap{position:relative;height:340px;perspective:1100px;perspective-origin:50% 35%;overflow:hidden;border-radius:12px;
    background:radial-gradient(ellipse at 50% 30%,color-mix(in srgb,var(--accent) 10%,transparent),transparent 70%),var(--panel2);touch-action:pan-y;cursor:grab}
  .e3-wrap:active{cursor:grabbing}
  .e3-scene{position:absolute;left:50%;top:46%;width:0;height:0;transform-style:preserve-3d;transform:scale3d(var(--zoom,1.45),var(--zoom,1.45),var(--zoom,1.45)) rotateX(var(--rx,-24deg)) rotateY(var(--ry,-32deg))}
  .e3-box,.e3-mv{position:absolute;transform-style:preserve-3d}
  .e3-f{position:absolute;left:0;top:0;backface-visibility:visible;border:1px solid color-mix(in srgb,var(--c) 70%,#fff 10%);
    background:color-mix(in srgb,var(--c) var(--a,22%),transparent);box-shadow:inset 0 0 18px color-mix(in srgb,var(--c) 35%,transparent)}
  .e3-box.solid .e3-f{--a:78%}
  .e3-box.hl .e3-f{box-shadow:inset 0 0 22px var(--c),0 0 16px var(--c)}
  @keyframes e3piston{0%,100%{transform:translateY(-24px)}50%{transform:translateY(22px)}}
  @keyframes e3spark{0%,6%{opacity:1;transform:scale(1.25)}14%,100%{opacity:.08;transform:scale(.6)}}
  @keyframes e3flow{to{background-position:-60px 0}}
  .e3-piston>.e3-mv{animation:e3piston var(--cyc,1.4s) linear infinite;animation-delay:var(--ph,0s);animation-play-state:var(--play,paused)}
  .e3-spark{position:absolute;width:14px;height:14px;margin:-7px;border-radius:50%;background:radial-gradient(circle,#fff,#ffd34d 40%,transparent 70%);
    box-shadow:0 0 14px 6px #ffb020;animation:e3spark var(--cyc,1.4s) linear infinite;animation-delay:var(--ph,0s);animation-play-state:var(--play,paused)}
  .e3-flow .e3-f{background-image:repeating-linear-gradient(90deg,color-mix(in srgb,var(--c) 55%,transparent) 0 14px,transparent 14px 30px);
    animation:e3flow var(--flow,2s) linear infinite;animation-play-state:var(--play,paused)}
  .e3-lbl{position:absolute;font:600 11px system-ui;color:var(--text);background:color-mix(in srgb,var(--panel) 80%,transparent);border:1px solid var(--line);
    padding:2px 6px;border-radius:6px;white-space:nowrap;pointer-events:none}
  .e3-hint{position:absolute;right:10px;bottom:8px;font-size:11px;color:var(--muted)}
  .sysgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-top:12px}
  .sys{border:1px solid var(--line);border-radius:12px;padding:10px;background:var(--panel2);cursor:pointer}
  .sys.on{border-color:var(--accent)}
  .sys h3{margin:0 0 6px;font-size:13px} .sys .r{display:flex;justify-content:space-between;font-size:12.5px;padding:2px 0}
  .sys .r span:last-child{font-variant-numeric:tabular-nums;font-weight:600}
  .cylrow{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
  .cyl{border:1px solid var(--line);border-radius:12px;padding:10px;text-align:center;background:var(--panel2)}
  .cyl b{font-size:22px;display:block}
  .tilt3d{transition:transform .25s ease-out;transform-style:preserve-3d;will-change:transform}
  @media (prefers-reduced-motion:reduce){.e3-piston>.e3-mv,.e3-spark,.e3-flow .e3-f{animation:none}.tilt3d{transition:none;transform:none!important}}
  @media (max-width:600px){.e3-wrap{height:270px}.e3-scene{--zoom:1.05}}`;
  const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
})();

// ------------------------------------------------------------- 3D primitives
function box(cls, c, w, h, d, x, y, z, inner = "", style = "") {
  const f = (t, W, H) => `<div class="e3-f" style="width:${W}px;height:${H}px;margin:${-H / 2}px 0 0 ${-W / 2}px;transform:${t}"></div>`;
  return `<div class="e3-box ${cls}" style="--c:${c};transform:translate3d(${x}px,${y}px,${z}px);${style}"><div class="e3-mv">
    ${f(`translateZ(${d / 2}px)`, w, h)}${f(`rotateY(180deg) translateZ(${d / 2}px)`, w, h)}
    ${f(`rotateY(90deg) translateZ(${w / 2}px)`, d, h)}${f(`rotateY(-90deg) translateZ(${w / 2}px)`, d, h)}
    ${f(`rotateX(90deg) translateZ(${h / 2}px)`, w, d)}${f(`rotateX(-90deg) translateZ(${h / 2}px)`, w, d)}${inner}</div></div>`;
}
const FIRING = {1: [1], 2: [1, 2], 3: [1, 2, 3], 4: [1, 3, 4, 2], 5: [1, 2, 4, 5, 3], 6: [1, 5, 3, 6, 2, 4], 8: [1, 8, 4, 3, 6, 5, 7, 2]};
const cylCount = () => Math.max(1, Math.min(8, +VEH().cylinders || (isTwoWheeler() ? 1 : 4)));
const mix = (a, b, t) => `color-mix(in srgb, ${b} ${Math.round(Math.max(0, Math.min(1, t)) * 100)}%, ${a})`;

let e3Key = "";
function buildEngine() {
  const n = cylCount(), key = n + "|" + VEH().id; if (key === e3Key && $("#e3scene")?.children.length) return; e3Key = key;
  const pitch = 52, bw = n * pitch + 28, x0 = -((n - 1) * pitch) / 2;
  const order = FIRING[n] || Array.from({length: n}, (_, i) => i + 1);
  let h = "";
  h += box("solid", "var(--panel)", bw + 120, 6, 170, 0, 92, 0);                                            // ground plate
  h += box("", "var(--muted)", bw, 92, 86, 0, 30, 0, "", "");                                               // engine block (glass)
  h += box("", "var(--muted)", bw, 18, 86, 0, -26, 0);                                                       // cylinder head
  for (let i = 0; i < n; i++) {
    const ph = order.indexOf(i + 1) / n;
    h += `<div class="e3-piston" id="e3p${i}" style="--ph:calc(var(--cyc,1.4s) * ${-ph})">${box("solid", "var(--accent)", 34, 20, 34, x0 + i * pitch, 24, 0)}</div>`;
    h += `<div class="e3-spark" id="e3s${i}" style="--ph:calc(var(--cyc,1.4s) * ${-ph});transform:translate3d(${x0 + i * pitch}px,-38px,0)"></div>`;
  }
  h += `<div id="e3intake">${box("e3-flow", "var(--accent)", bw - 10, 20, 26, 0, -6, -64)}</div>`;            // intake manifold (back)
  h += `<div id="e3thr">${box("solid", "var(--accent)", 26, 26, 26, -bw / 2 - 26, -6, -64)}</div>`;            // throttle body
  h += `<div id="e3exh">${box("e3-flow", "#888", bw - 10, 18, 22, 0, 10, 62)}</div>`;                          // exhaust manifold (front)
  h += `<div id="e3cat">${box("solid", "#888", 44, 26, 26, bw / 2 + 36, 22, 62)}</div>`;                       // catalytic converter
  h += `<div id="e3rad">${box("solid", "var(--accent)", 12, 96, 110, -bw / 2 - 64, 22, 0)}</div>`;            // radiator
  h += `<div id="e3bat">${box("solid", "var(--ok)", 40, 34, 28, bw / 2 + 40, 58, -54)}</div>`;                 // battery
  $("#e3scene").innerHTML = h;
}
let rot = {rx: -24, ry: -32}, dragging = null, lastInteract = 0;
function e3Frame() {
  const wrap = $("#e3wrap");
  if (wrap && $("#hood")?.classList.contains("on")) {
    if (!dragging && Date.now() - lastInteract > 2500 && !matchMedia("(prefers-reduced-motion: reduce)").matches) rot.ry += 0.12;
    $("#e3scene").style.setProperty("--rx", rot.rx + "deg"); $("#e3scene").style.setProperty("--ry", rot.ry + "deg");
  }
  requestAnimationFrame(e3Frame);
}
function bindDrag() {
  const w = $("#e3wrap"); if (!w || w.dataset.bound) return; w.dataset.bound = 1;
  w.addEventListener("pointerdown", e => { dragging = {x: e.clientX, y: e.clientY, ...rot}; w.setPointerCapture(e.pointerId); });
  w.addEventListener("pointermove", e => { if (!dragging) return; rot.ry = dragging.ry + (e.clientX - dragging.x) * 0.4; rot.rx = Math.max(-70, Math.min(10, dragging.rx - (e.clientY - dragging.y) * 0.3)); lastInteract = Date.now(); });
  w.addEventListener("pointerup", () => { dragging = null; lastInteract = Date.now(); });
  w.addEventListener("pointercancel", () => { dragging = null; });
}
function updateEngine() {
  const sc = $("#e3scene"); if (!sc) return;
  const rpm = L("0C") || 0, run = rpm > 300;
  sc.style.setProperty("--play", run ? "running" : "paused");
  sc.style.setProperty("--cyc", Math.max(0.22, Math.min(2.4, 2.6 - rpm / 2600)).toFixed(2) + "s");
  sc.style.setProperty("--flow", Math.max(0.3, 3 - (L("10") || rpm / 300) / 12).toFixed(2) + "s");
  const temp = L(tempPid()), cat = L("3C"), v = S?.voltage;
  const setC = (id, c) => document.querySelectorAll(`#${id} .e3-box`).forEach(b => b.style.setProperty("--c", c));
  setC("e3rad", temp == null ? "var(--muted)" : temp < 70 ? "var(--accent)" : temp < 105 ? "var(--ok)" : temp < 112 ? "var(--warn)" : "var(--bad)");
  setC("e3cat", cat == null ? "#888" : mix("#777", "#ff6a00", (cat - 200) / 600));
  setC("e3exh", cat == null ? "#888" : mix("#777", "#ff8a3d", (cat - 250) / 650));
  setC("e3bat", v == null ? "var(--muted)" : v >= 13.2 || v >= 12.4 ? "var(--ok)" : v >= 12.0 ? "var(--warn)" : "var(--bad)");
  const h = cylHealth();
  h.cyl.forEach((c, i) => {
    document.querySelectorAll(`#e3p${i} .e3-box`).forEach(b => { b.style.setProperty("--c", c.lvl === "bad" ? "var(--bad)" : c.lvl === "warn" ? "var(--warn)" : "var(--accent)"); b.classList.toggle("hl", c.lvl !== "ok"); });
  });
}

// ------------------------------------------------------------- systems panel
const SYSTEMS = [
  {id: "air", name: "🌬 Air intake", parts: ["e3intake", "e3thr"], pids: [["10", "Airflow (MAF)"], ["0B", "Manifold pressure"], ["0F", "Intake air temp"], ["11", "Throttle"], ["33", "Barometric"]]},
  {id: "fuel", name: "⛽ Fuel", parts: ["e3intake"], pids: [["06", "Short-term trim"], ["07", "Long-term trim"], ["03", "Fuel system"], ["44", "Target λ"], ["2E", "Evap purge"], ["FUEL", "Fuel flow"]]},
  {id: "power", name: "🔥 Ignition & power", parts: ["e3p0", "e3p1", "e3p2", "e3p3"], pids: [["0C", "RPM"], ["04", "Engine load"], ["0E", "Timing advance"], ["43", "Absolute load"]]},
  {id: "exh", name: "💨 Exhaust & emissions", parts: ["e3exh", "e3cat"], pids: [["34", "Air-fuel sensor λ"], ["15", "Rear O2 sensor"], ["3C", "Catalyst temp"], ["2C", "EGR command"]]},
  {id: "cool", name: "🌡 Cooling", parts: ["e3rad"], pids: [["67", "Coolant"], ["05", "Coolant"], ["5C", "Engine oil"], ["46", "Outside air"]]},
  {id: "elec", name: "🔋 Electrical", parts: ["e3bat"], pids: [["RV", "Battery"], ["42", "ECU supply"]]},
];
let sysSel = null;
function sysVal(p) {
  if (p === "RV") return S?.voltage != null ? S.voltage.toFixed(2) + " V" : null;
  if (p === "FUEL") { const f = window.TRIPS?.fuelRate?.(); return f ? f.lph.toFixed(2) + " L/h" : null; }
  const v = S?.live?.[p]; if (!v || v.value == null) return null;
  return typeof v.value === "number" ? `${Number.isInteger(v.value) ? v.value : v.value.toFixed(v.unit === "V" || v.unit === "λ" ? 3 : 1)} ${v.unit}` : v.value;
}
function renderSystems() {
  $("#sysGrid").innerHTML = SYSTEMS.map(s => `<div class="sys${sysSel === s.id ? " on" : ""}" data-sys="${s.id}"><h3>${s.name}</h3>
    ${s.pids.map(([p, n]) => { const v = sysVal(p); return v == null ? "" : `<div class="r" data-info="${p === "FUEL" ? "" : p}"><span class="muted">${n}</span><span>${esc(v)}</span></div>`; }).join("") || '<div class="muted" style="font-size:12px">Not reported by this ECU</div>'}</div>`).join("");
}
document.addEventListener("click", e => {
  const s = e.target.closest("[data-sys]"); if (!s || e.target.closest("[data-info]:not([data-info=''])")) return;
  sysSel = sysSel === s.dataset.sys ? null : s.dataset.sys;
  window.HOOD3D?.highlight(sysSel);
  document.querySelectorAll("#e3scene .e3-box").forEach(b => b.classList.remove("hl"));
  const sys = SYSTEMS.find(x => x.id === sysSel);
  if (sys) sys.parts.forEach(id => document.querySelectorAll(`#${id} .e3-box`).forEach(b => b.classList.add("hl")));
  renderSystems();
});

// ------------------------------------------------------------- cylinder health
function cylHealth() {
  const n = cylCount(), codes = [...(S?.dtc?.stored || []), ...(S?.dtc?.pending || [])];
  const m06 = S?.mode06?.tests || [], random = codes.includes("P0300");
  const cyl = Array.from({length: n}, (_, i) => {
    const code = "P03" + String(i + 1).padStart(2, "0"), mid = (0xA2 + i).toString(16).toUpperCase();
    const t = m06.filter(x => x.mid === mid), avg = t.find(x => x.tid === "0B")?.value, last = t.find(x => x.tid === "0C")?.value;
    let lvl = "ok", why = "No misfire codes";
    if (codes.includes(code)) { lvl = "bad"; why = `${code}: misfire detected`; }
    else if (last > 0 || avg > 0) { lvl = "warn"; why = `Misfire counter ${last ?? avg}`; }
    else if (random) { lvl = "warn"; why = "P0300 random misfire (cylinder not identified)"; }
    return {n: i + 1, lvl, why, counts: t.length ? {avg, last} : null};
  });
  const ir = window.TRIPS?.idleRpm || [], mean = ir.length ? ir.reduce((a, b) => a + b, 0) / ir.length : null;
  const sd = ir.length > 8 ? Math.sqrt(ir.reduce((a, b) => a + (b - mean) ** 2, 0) / ir.length) : null;
  const misMon = S?.readiness?.monitors?.find(m => m.name === "Misfire");
  return {cyl, sd, mean, hasCounters: m06.some(x => /^A[2-9A-D]$/.test(x.mid)), misMon, ltft: L("07"), m06Read: !!S?.mode06};
}
function renderCyl() {
  const h = cylHealth(), ic = {ok: "✓", warn: "!", bad: "✕"};
  const smooth = h.sd == null ? ["mute", "Idle the engine ~30 s to measure"] : h.sd < 15 ? ["ok", `Smooth (±${h.sd.toFixed(0)} rpm)`] : h.sd < 40 ? ["warn", `Slightly uneven (±${h.sd.toFixed(0)} rpm)`] : ["bad", `Rough (±${h.sd.toFixed(0)} rpm)`];
  $("#cylHealth").innerHTML = `<div class="cylrow">${h.cyl.map(c => `<div class="cyl"><span class="muted" style="font-size:12px">Cylinder ${c.n}</span>
      <b style="color:var(--${c.lvl === "ok" ? "ok" : c.lvl === "warn" ? "warn" : "bad"})">${ic[c.lvl]}</b><span style="font-size:12px">${esc(c.why)}</span>
      ${c.counts ? `<div class="muted" style="font-size:11px">misfires: last ${c.counts.last ?? "–"} · avg ${c.counts.avg ?? "–"}</div>` : ""}</div>`).join("")}</div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;margin-top:10px">
      <div class="stat"><div class="k">Idle smoothness</div><div class="v" style="color:var(--${smooth[0] === "mute" ? "muted" : smooth[0]})">${smooth[1].split(" (")[0]}</div><div class="s">${smooth[1].includes("(") ? "RPM variation " + smooth[1].split("(")[1].replace(")", "") : smooth[1]}</div></div>
      <div class="stat"><div class="k">Misfire monitor</div><div class="v">${h.misMon ? (h.misMon.ready ? "Complete" : "Running") : "–"}</div><div class="s">continuous self-test by the ECU</div></div>
      <div class="stat"><div class="k">Long-term fuel trim</div><div class="v">${h.ltft != null ? h.ltft.toFixed(1) + " %" : "–"}</div><div class="s">±10 % or less is healthy</div></div>
    </div>
    <p class="muted" style="font-size:12px;margin-bottom:0">${h.hasCounters ? "Per-cylinder misfire counters come from the ECU's own tests (Mode 06)."
      : h.m06Read ? "This ECU doesn't report per-cylinder misfire counters over standard OBD, so cylinder status uses misfire codes (P0301…) and idle smoothness. For deeper data, see the Hidden data tab."
      : `Tap <button class="btn" id="cylRead" style="padding:3px 10px">Read misfire counters</button> to check the ECU's per-cylinder test results, where supported.`}</p>`;
}
document.addEventListener("click", e => { if (e.target.closest("#cylRead")) api("/api/mode06", {}); });

// ------------------------------------------------------------- 3D tilt for gauges (mouse + phone motion)
(function tilt() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const cards = () => document.querySelectorAll("#dash .card.gauge");
  const apply = (rx, ry) => cards().forEach(c => { c.classList.add("tilt3d"); c.style.transform = `perspective(700px) rotateX(${rx}deg) rotateY(${ry}deg)`; });
  document.addEventListener("pointermove", e => {
    const c = e.target.closest?.("#dash .card.gauge"); if (!c || e.pointerType === "touch") return;
    const r = c.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
    c.classList.add("tilt3d"); c.style.transform = `perspective(700px) rotateX(${(-y * 10).toFixed(1)}deg) rotateY(${(x * 12).toFixed(1)}deg) translateZ(6px)`;
  });
  document.addEventListener("pointerout", e => { const c = e.target.closest?.("#dash .card.gauge"); if (c && !c.contains(e.relatedTarget)) c.style.transform = ""; });
  let base = null;
  window.addEventListener("deviceorientation", e => {
    if (e.beta == null) return; base ??= {b: e.beta, g: e.gamma};
    apply(Math.max(-8, Math.min(8, (e.beta - base.b) * 0.25)).toFixed(1), Math.max(-8, Math.min(8, (e.gamma - base.g) * 0.3)).toFixed(1));
  });
})();

window.RENDER_HOOKS.push(() => {
  if (!$("#hood")?.classList.contains("on")) return;
  if (!window.HOOD3D?.active) { buildEngine(); bindDrag(); updateEngine(); }   // CSS fallback only when WebGL view didn't load
  renderSystems(); renderCyl();
});
requestAnimationFrame(e3Frame);
window.HOOD = {cylHealth};
