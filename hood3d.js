/* Realistic 3D "Under the hood" view (WebGL, Three.js r160 from the jsDelivr CDN, cached by the browser).
 * Everything is modelled in code (no model files): an X-ray car with wheels turning at live speed and a road
 * moving underneath, plus a mechanically animated engine (crankshaft → connecting rods → pistons, spark plugs
 * firing in order, belt and pulleys), radiator + fan, glowing exhaust, intake/exhaust/fuel particles and a battery.
 * Floating labels show live values; tap one for its explanation. If Three.js can't load (offline on first run),
 * this module never runs and the simpler CSS engine from hood.js stays on screen. */
import * as THREE from "three";
import {OrbitControls} from "three/addons/controls/OrbitControls.js";
import {RoomEnvironment} from "three/addons/environments/RoomEnvironment.js";
import {RoundedBoxGeometry} from "three/addons/geometries/RoundedBoxGeometry.js";
import {CSS2DRenderer, CSS2DObject} from "three/addons/renderers/CSS2DRenderer.js";
import {EffectComposer} from "three/addons/postprocessing/EffectComposer.js";
import {RenderPass} from "three/addons/postprocessing/RenderPass.js";
import {UnrealBloomPass} from "three/addons/postprocessing/UnrealBloomPass.js";
import {OutputPass} from "three/addons/postprocessing/OutputPass.js";
import {GLTFLoader} from "three/addons/loaders/GLTFLoader.js";
import {DRACOLoader} from "three/addons/loaders/DRACOLoader.js";

const css = `
.h3d{position:relative;height:430px;border-radius:12px;overflow:hidden;background:var(--panel2);touch-action:none}
.h3d canvas{display:block}
.h3d-bar{position:absolute;left:8px;right:8px;top:8px;display:flex;flex-wrap:wrap;gap:6px;z-index:3;pointer-events:none}
.h3d-bar>*{pointer-events:auto}
.h3d-bar button{background:color-mix(in srgb,var(--panel) 82%,transparent);color:var(--text);border:1px solid var(--line);border-radius:999px;padding:5px 11px;font:600 12px system-ui;cursor:pointer;backdrop-filter:blur(6px)}
.h3d-bar button.on{border-color:var(--accent);color:var(--accent)}
.h3d-paint{display:flex;gap:4px;align-items:center;margin-left:auto}
.h3d-paint i{width:18px;height:18px;border-radius:50%;border:2px solid var(--line);cursor:pointer;display:block}
.h3d-paint i.on{border-color:var(--text)}
.h3d-lbl{font:600 11.5px system-ui;color:var(--text);background:color-mix(in srgb,var(--panel) 78%,transparent);border:1px solid color-mix(in srgb,var(--accent) 55%,var(--line));
  padding:3px 8px;border-radius:8px;white-space:nowrap;pointer-events:auto;cursor:help;backdrop-filter:blur(4px);box-shadow:0 4px 14px rgba(0,0,0,.25)}
.h3d-lbl b{font-variant-numeric:tabular-nums}
.h3d-lbl.warn{border-color:var(--warn)} .h3d-lbl.bad{border-color:var(--bad);animation:h3dpulse 1s infinite alternate}
@keyframes h3dpulse{to{box-shadow:0 0 14px var(--bad)}}
.h3d-menu{display:flex;gap:4px;flex-wrap:wrap;width:100%}.h3d-menu[hidden]{display:none}
.h3d-note{position:absolute;left:10px;bottom:8px;font-size:11px;color:var(--muted);z-index:3;pointer-events:none}
@media (max-width:600px){.h3d{height:380px}.h3d-paint{margin-left:0}.h3d-bar{gap:4px}.h3d-bar button{padding:4px 8px;font-size:11px}.h3d-paint i{width:15px;height:15px}.h3d-lbl{font-size:10.5px;padding:2px 6px}}`;
document.head.appendChild(Object.assign(document.createElement("style"), {textContent: css}));

// ------------------------------------------------------------------ setup
const card = document.querySelector("#e3wrap").parentElement;
const host = Object.assign(document.createElement("div"), {className: "h3d", id: "h3d"});
card.insertBefore(host, document.querySelector("#e3wrap"));
const q = s => { try { return localStorage.getItem("h3d:" + s); } catch (e) { return null; } };
const qs = (s, v) => { try { localStorage.setItem("h3d:" + s, v); } catch (e) {} };
const lowEnd = innerWidth < 700 || (navigator.deviceMemory && navigator.deviceMemory < 4);
let quality = q("quality") || (lowEnd ? "balanced" : "high");

const renderer = new THREE.WebGLRenderer({antialias: true, powerPreference: "high-performance"});
const touch = matchMedia("(pointer: coarse)").matches;
renderer.setPixelRatio(Math.min(devicePixelRatio, quality === "high" ? (touch ? 1.5 : 2) : 1.25));
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = quality === "high"; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
host.appendChild(renderer.domElement);
const labelRenderer = new CSS2DRenderer();
Object.assign(labelRenderer.domElement.style, {position: "absolute", top: "0", left: "0", pointerEvents: "none", zIndex: 2});
host.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
const room = new RoomEnvironment();
scene.environment = pmrem.fromScene(room, 0.04).texture;
room.dispose?.(); pmrem.dispose();
const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 80);
camera.position.set(5.2, 2.6, 5.4);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.08; controls.target.set(0.2, 0.7, 0);
controls.minDistance = 0.8; controls.maxDistance = 14; controls.maxPolarAngle = Math.PI * 0.495;
controls.autoRotate = q("autorot") !== "0"; controls.autoRotateSpeed = 0.55;

scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a1d22, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(4, 7, 3); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, {left: -4, right: 4, top: 4, bottom: -4, near: 1, far: 20}); sun.shadow.bias = -0.0004;
scene.add(sun);

let composer = null, bloom = null;
function setupComposer() {
  if (quality !== "high") { composer = null; return; }
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.4, 0.92);   // only bright emissive parts glow
  composer.addPass(bloom); composer.addPass(new OutputPass());
}

// ------------------------------------------------------------------ materials
const M = {
  rubber: new THREE.MeshStandardMaterial({color: 0x141414, roughness: 0.92}),
  rim: new THREE.MeshStandardMaterial({color: 0xc9ced6, metalness: 1, roughness: 0.22}),
  chrome: new THREE.MeshStandardMaterial({color: 0xffffff, metalness: 1, roughness: 0.08}),
  alu: new THREE.MeshPhysicalMaterial({color: 0xaab3bd, metalness: 0.85, roughness: 0.32, transparent: true, opacity: 0.34, depthWrite: false, side: THREE.DoubleSide}),
  steel: new THREE.MeshStandardMaterial({color: 0x9aa2ab, metalness: 0.9, roughness: 0.28}),
  piston: new THREE.MeshStandardMaterial({color: 0xd8dde3, metalness: 1, roughness: 0.18}),
  dark: new THREE.MeshStandardMaterial({color: 0x23262b, metalness: 0.35, roughness: 0.55}),
  plastic: new THREE.MeshStandardMaterial({color: 0x15171a, roughness: 0.7}),
  glass: new THREE.MeshPhysicalMaterial({color: 0x0b1118, metalness: 0, roughness: 0.04, transparent: true, opacity: 0.55, clearcoat: 1}),
  head: new THREE.MeshStandardMaterial({color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.1}),
  tail: new THREE.MeshStandardMaterial({color: 0x550000, emissive: 0xff1010, emissiveIntensity: 0.8}),
  caliper: new THREE.MeshStandardMaterial({color: 0xb01818, metalness: 0.4, roughness: 0.4, emissive: 0xff2200, emissiveIntensity: 0}),
  belt: new THREE.MeshStandardMaterial({color: 0x101010, roughness: 0.85}),
  exhaust: new THREE.MeshStandardMaterial({color: 0x6d7176, metalness: 0.8, roughness: 0.35, emissive: 0xff4400, emissiveIntensity: 0}),
  hose: new THREE.MeshStandardMaterial({color: 0x1d2a33, roughness: 0.6, emissive: 0x2a7fff, emissiveIntensity: 0.15}),
  radiator: new THREE.MeshStandardMaterial({color: 0x4b545e, metalness: 0.7, roughness: 0.45}),
  battery: new THREE.MeshStandardMaterial({color: 0x202326, roughness: 0.6}),
  charge: new THREE.MeshStandardMaterial({color: 0x10ff70, emissive: 0x10ff70, emissiveIntensity: 0.45}),
  spark: new THREE.MeshBasicMaterial({color: 0xffe08a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false}),
  tank: new THREE.MeshPhysicalMaterial({color: 0x3a4652, metalness: 0.3, roughness: 0.5, transparent: true, opacity: 0.5, depthWrite: false}),
  ground: new THREE.MeshStandardMaterial({color: 0x15181d, roughness: 0.95, metalness: 0}),
  road: new THREE.MeshStandardMaterial({color: 0x1b1f25, roughness: 0.85}),
  lane: new THREE.MeshStandardMaterial({color: 0xd8dde3, emissive: 0x8899aa, emissiveIntensity: 0.04, roughness: 0.6}),
};
const canvasTex = (w, h, draw, repeat) => { const c = document.createElement("canvas"); c.width = w; c.height = h; draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); } t.anisotropy = 4; return t; };
const noise = (g, w, h, base, amp) => { const d = g.createImageData(w, h); for (let i = 0; i < w * h; i++) { const v = base + (Math.random() - 0.5) * amp; d.data.set([v, v, v, 255], i * 4); } g.putImageData(d, 0, 0); };
Object.assign(M, {
  rubber: new THREE.MeshStandardMaterial({color: 0x161616, roughness: 0.9}),
  tyre: new THREE.MeshStandardMaterial({color: 0x1a1a1a, roughness: 0.88, side: THREE.DoubleSide,
    map: canvasTex(512, 64, (g, w, h) => { g.fillStyle = "#1b1b1b"; g.fillRect(0, 0, w, h); g.fillStyle = "#0b0b0b";
      for (let x = 0; x < w; x += 9) { g.fillRect(x, 24, 3, 7); g.fillRect(x + 4, 33, 3, 7); } [22, 32, 42].forEach(y => g.fillRect(0, y, w, 2)); })}),
  rimDark: new THREE.MeshStandardMaterial({color: 0x2a2d31, metalness: 0.8, roughness: 0.35}),
  disc: new THREE.MeshStandardMaterial({color: 0x8d9298, metalness: 0.9, roughness: 0.45}),
  cast: new THREE.MeshStandardMaterial({color: 0xa7adb3, metalness: 0.75, roughness: 0.55, map: canvasTex(128, 128, (g, w, h) => noise(g, w, h, 200, 50))}),
  cover: new THREE.MeshPhysicalMaterial({color: 0xffffff, metalness: 0.35, roughness: 0.42, clearcoat: 0.5,
    map: canvasTex(512, 128, (g, w, h) => { g.fillStyle = "#16181b"; g.fillRect(0, 0, w, h); g.strokeStyle = "#24272b"; g.lineWidth = 6;
      for (let x = -h; x < w; x += 22) { g.beginPath(); g.moveTo(x, h); g.lineTo(x + h, 0); g.stroke(); }
      g.fillStyle = "#101113"; g.fillRect(w / 2 - 92, h / 2 - 30, 184, 60); g.fillStyle = "#c8ccd2"; g.font = "bold 40px system-ui"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("1.5 MPi", w / 2, h / 2 + 2); })}),
  shield: new THREE.MeshStandardMaterial({color: 0xd5d8dc, metalness: 1, roughness: 0.32, bumpScale: 2, bumpMap: canvasTex(128, 128, (g, w, h) => noise(g, w, h, 128, 160))}),
  yellow: new THREE.MeshStandardMaterial({color: 0xffc400, roughness: 0.4}),
  orange: new THREE.MeshStandardMaterial({color: 0xff7a00, roughness: 0.4}),
  res: new THREE.MeshPhysicalMaterial({color: 0xf0f0ea, roughness: 0.35, transparent: true, opacity: 0.4, depthWrite: false}),
  coolant: new THREE.MeshStandardMaterial({color: 0xff3d97, emissive: 0xff3d97, emissiveIntensity: 0.25, transparent: true, opacity: 0.85}),
  brakeFluid: new THREE.MeshStandardMaterial({color: 0xd9b24a, transparent: true, opacity: 0.8}),
  washer: new THREE.MeshStandardMaterial({color: 0x2f7dff, emissive: 0x1040a0, emissiveIntensity: 0.2, transparent: true, opacity: 0.75}),
  trim: new THREE.MeshPhysicalMaterial({color: 0x08090a, metalness: 0.2, roughness: 0.18, clearcoat: 1, transparent: true}),
  clad: new THREE.MeshStandardMaterial({color: 0x101113, roughness: 0.75, transparent: true}),
  rail: new THREE.MeshStandardMaterial({color: 0x9aa0a6, metalness: 0.9, roughness: 0.3, transparent: true}),
  skid: new THREE.MeshStandardMaterial({color: 0xb9bec4, metalness: 0.9, roughness: 0.3}),
  drl: new THREE.MeshStandardMaterial({color: 0xffffff, emissive: 0xeaf4ff, emissiveIntensity: 2.2}),
  amber: new THREE.MeshStandardMaterial({color: 0x663300, emissive: 0xff8a00, emissiveIntensity: 0.6}),
  plate: new THREE.MeshStandardMaterial({color: 0xe8e8e8, roughness: 0.5}),
  seam: new THREE.MeshBasicMaterial({color: 0x050505}),
  sun: new THREE.MeshPhysicalMaterial({color: 0x05080b, metalness: 0.3, roughness: 0.02, clearcoat: 1, envMapIntensity: 1.6}),
  leather: new THREE.MeshPhysicalMaterial({color: 0x1a1b1e, roughness: 0.55, sheen: 0.4, sheenColor: 0x555555}),
  dash: new THREE.MeshStandardMaterial({color: 0x1b1c1f, roughness: 0.65}),
  dashTrim: new THREE.MeshStandardMaterial({color: 0x3a3e44, metalness: 0.7, roughness: 0.3}),
  carpet: new THREE.MeshStandardMaterial({color: 0x111214, roughness: 1}),
  headliner: new THREE.MeshStandardMaterial({color: 0x2b2c2f, roughness: 0.95}),
  ambient: new THREE.MeshStandardMaterial({color: 0x3fa7ff, emissive: 0x3fa7ff, emissiveIntensity: 1.6}),
});
M.glass = new THREE.MeshPhysicalMaterial({color: 0x0c171b, metalness: 0.1, roughness: 0.03, transparent: true, opacity: 0.5, clearcoat: 1, envMapIntensity: 1.6, side: THREE.DoubleSide, depthWrite: false});
M.grille = new THREE.MeshStandardMaterial({metalness: 0.6, roughness: 0.38, alphaTest: 0.5, map: canvasTex(512, 168, (g, w, h) => {
  g.fillStyle = "#07080a"; g.beginPath(); g.roundRect(2, 2, w - 4, h - 4, 34); g.fill(); g.save(); g.clip();
  for (let y = 0; y < 10; y++) for (let x = 0; x < 31; x++) { const cx = x * 17 + (y % 2) * 8.5, cy = 6 + y * 17;
    g.beginPath(); g.moveTo(cx, cy - 7); g.lineTo(cx + 7, cy); g.lineTo(cx, cy + 7); g.lineTo(cx - 7, cy); g.closePath(); g.fillStyle = "#1b1e23"; g.fill(); g.strokeStyle = "#6b727b"; g.lineWidth = 1.3; g.stroke(); }
  g.restore(); g.strokeStyle = "#8e959e"; g.lineWidth = 4; g.beginPath(); g.roundRect(3, 3, w - 6, h - 6, 33); g.stroke(); })});
// Creta-style grille: wide trapezoid, dark chrome frame, parametric jewel pattern
M.grilleCreta = new THREE.MeshStandardMaterial({metalness: 0.75, roughness: 0.3, alphaTest: 0.5, map: canvasTex(560, 184, (g, w, h) => {
  const trap = i => { g.beginPath(); g.moveTo(10 + i, 6 + i); g.lineTo(w - 10 - i, 6 + i); g.lineTo(w - 46 - i, h - 6 - i); g.lineTo(46 + i, h - 6 - i); g.closePath(); };
  g.fillStyle = "#050607"; trap(0); g.fill(); g.save(); trap(0); g.clip();
  for (let y = 0; y < 12; y++) for (let x = 0; x < 24; x++) { const cx = x * 24 + (y % 2) * 12, cy = 4 + y * 16, k = (x + y) % 3;
    g.beginPath(); g.moveTo(cx - 10, cy); g.lineTo(cx, cy - 7); g.lineTo(cx + 10, cy); g.lineTo(cx, cy + 7); g.closePath();
    g.fillStyle = k ? "#17191d" : "#2b2f35"; g.fill(); g.strokeStyle = "#4b5058"; g.lineWidth = 1; g.stroke(); }
  g.restore(); g.strokeStyle = "#3a3f46"; g.lineWidth = 7; trap(3); g.stroke(); })});
M.leather.map = canvasTex(256, 256, (g, w, h) => { g.fillStyle = "#4a4b4f"; g.fillRect(0, 0, w, h); g.fillStyle = "#2a2b2e";       // perforated (ventilated) leatherette
  for (let y = 4; y < h; y += 9) for (let x = 4 + (y % 18 ? 4 : 0); x < w; x += 9) { g.beginPath(); g.arc(x, y, 1.6, 0, 7); g.fill(); } }, [2, 2]);
M.leather.color.set(0x3a3b3e);
const DEFAULT_PAINT = "#1f5245";        // Robust Emerald Pearl (approximation)
const paintOf = () => { const p = VEH().paint; return !p || p === "#0f4d3c" ? DEFAULT_PAINT : p; };
const paint = new THREE.MeshPhysicalMaterial({color: DEFAULT_PAINT, metalness: 0.5, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.3,
  iridescence: 0.35, iridescenceIOR: 1.45, iridescenceThicknessRange: [260, 420], transparent: true, opacity: 1, side: THREE.DoubleSide});
const paintV = paint.clone(); paintV.vertexColors = true;      // body shell: vertex colours darken the cladding and wheel wells
const PAINT_MATS = [paint, paintV];
const edgeMat = new THREE.LineBasicMaterial({color: 0x3fa7ff, transparent: true, opacity: 0});
const mesh = (geo, mat, x = 0, y = 0, z = 0, cast = true) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = cast; return m; };
const tube = (pts, r, mat, closed = false, seg = 64) => new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(...p)), closed), seg, r, 10, closed), mat);

// ------------------------------------------------------------------ world: ground, road with moving lane markings
const world = new THREE.Group(); scene.add(world);
const ground = mesh(new THREE.CircleGeometry(30, 64), M.ground, 0, 0, 0, false); ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; world.add(ground);
const road = mesh(new THREE.PlaneGeometry(60, 3.8), M.road, 0, 0.002, 0, false); road.rotation.x = -Math.PI / 2; road.receiveShadow = true; world.add(road);
const LANES = 24, laneGeo = new THREE.BoxGeometry(1.2, 0.004, 0.09);
const lanes = new THREE.InstancedMesh(laneGeo, M.lane, LANES * 2); lanes.receiveShadow = true; world.add(lanes);
let laneOffset = 0;
function placeLanes() {
  const m = new THREE.Matrix4();
  for (let i = 0; i < LANES; i++) {
    const x = ((i * 2.5 - laneOffset) % (LANES * 2.5) + LANES * 2.5) % (LANES * 2.5) - LANES * 1.25;
    m.makeTranslation(x, 0.006, 1.75); lanes.setMatrixAt(i, m);
    m.makeTranslation(x, 0.006, -1.75); lanes.setMatrixAt(i + LANES, m);
  }
  lanes.instanceMatrix.needsUpdate = true;
}
placeLanes();
// soft contact shadow under the car (cheap; works without shadow maps)
const blobTex = (() => { const c = document.createElement("canvas"); c.width = c.height = 128; const g = c.getContext("2d");
  const r = g.createRadialGradient(64, 64, 8, 64, 64, 64); r.addColorStop(0, "rgba(0,0,0,0.75)"); r.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c); })();
const blob = mesh(new THREE.PlaneGeometry(5.2, 2.6), new THREE.MeshBasicMaterial({map: blobTex, transparent: true, depthWrite: false}), 0, 0.01, 0, false);
blob.rotation.x = -Math.PI / 2; world.add(blob);

// ------------------------------------------------------------------ car body: lofted SUV shell with Creta-like proportions
// (Creta: length 4.33 m, width 1.79 m, height 1.635 m, wheelbase 2.61 m, 215/55 R18). Cross-sections are swept along x (+x = front, +z = right / driver side for India).
const car = new THREE.Group(); scene.add(car);
const bodyG = new THREE.Group(), cabinG = new THREE.Group(), bay = new THREE.Group(); car.add(bodyG, cabinG, bay);
const W = 0.895, LH = 2.24, XF = 2.165, XR = -2.165, WR = 0.44, ROOF = 1.6, DARK = 0.07, AX = 1.305, WY = 0.36;
const isCretaVeh = () => { const v = VEH(); return /creta/i.test(v.model || "") || (/hyundai/i.test(v.make || "") && !v.model); };
let bodyMode = q("body") || "auto", CRETA = bodyMode === "creta" || (bodyMode === "auto" && isCretaVeh());
const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const range = (a, b, n) => Array.from({length: n + 1}, (_, i) => a + (b - a) * i / n);
const halfW = x => W * Math.pow(Math.max(0, 1 - Math.pow(Math.min(Math.abs(x) / LH, 1), 6)), 1 / 6);
const noseX = z => Math.min(XF, LH * Math.pow(Math.max(0, 1 - Math.pow(Math.min(Math.abs(z) / W, 0.999), 6)), 1 / 6));
const ySill = x => 0.28 + 0.11 * sstep(1.85, XF, x) + 0.14 * sstep(-1.85, XR, x);
// wheel-arch opening: squarer (superellipse) on the Creta, round on the generic body
const archY = d => { const t = Math.min(1, Math.abs(d) / WR), e = CRETA ? 4 : 2; return WY + (WR + 0.03) * Math.pow(1 - Math.pow(t, e), 1 / e); };
const yArch = x => { let y = ySill(x); for (const xw of [AX, -AX]) { const d = x - xw; if (Math.abs(d) < WR) y = Math.max(y, archY(d)); } return y; };
const yBelt = x => x >= 0.95 ? 1.10 - 0.1 * (x - 0.95) / 1.23 - 0.09 * Math.pow(Math.max(0, (x - 1.92) / 0.26), 2)
  : x >= -1.95 ? 1.10 + 0.06 * (0.95 - x) / 2.9 : 1.16 - 0.06 * Math.pow(Math.min(1, (-1.95 - x) / 0.23), 2);
const yRoof = x => { const b = yBelt(x);
  if (x >= 0.95) return b;
  if (x >= 0.15) return b + (ROOF - b) * Math.sin((0.95 - x) / 0.8 * Math.PI / 2);
  if (x >= -1.82) return ROOF + 0.022 * Math.sin(Math.PI * (0.15 - x) / 1.97);
  if (x >= -2.12) return b + (ROOF - b) * Math.sin((x + 2.12) / 0.3 * Math.PI / 2);
  return b; };
// right half of a cross-section, from the centre line outwards: [z, y, shade]
function bodyRight(x) {
  const w = halfW(x), ys = ySill(x), ya = yArch(x), yb = yBelt(x), arch = ya > ys + 0.005;
  const c1 = Math.max(ya, ys) + (arch ? 0.06 : 0.14), y7 = Math.max(yb - 0.3, c1 + 0.03);
  return [[0, ys, DARK], [w - 0.3, ys, DARK], [w - 0.3, ya, DARK], [w - 0.03, ya, DARK], [w * 0.985, ya + 0.01, DARK], [w * 0.994, c1, DARK],
    [w * 0.996, c1 + 0.008, 1], [w, y7, 1], [w * 0.99, yb - 0.07, 1], [w * 0.95, yb, 1]];
}
function topRight(x, crown) { const w = halfW(x), yb = yBelt(x);
  return [[0, yb + crown, 1], [w * 0.2, yb + crown * 0.98, 1], [w * 0.5, yb + crown * 0.88, 1], [w * 0.8, yb + crown * 0.55, 1], [w * 0.95, yb, 1]]; }
function cabinRight(x) { const w = halfW(x), yb = yBelt(x), yr = yRoof(x), h = yr - yb, hf = Math.min(1, h / 0.45), wb = w * 0.95, wt = w * 0.79, c = 0.03 * hf;
  return [[0, yr + c], [wt * 0.55, yr + c * 0.8], [wt, yr], [(wb + wt) / 2 + 0.012 * hf, yb + h * 0.5], [wb, yb]]; }
function roofRight(x) { const w = halfW(x), yb = yBelt(x), yr = yRoof(x), wt = w * 0.79, c = 0.03 * Math.min(1, (yr - yb) / 0.45);
  return [[0, yr + c + 0.008], [wt * 0.55, yr + c * 0.8 + 0.007], [wt + 0.006, yr + 0.004], [wt + 0.034, yr - 0.07]]; }
const ringFull = right => [...right.slice(1).reverse().map(([z, y, c]) => [-z, y, c]), ...right];
function loft(xs, ringAt, {colors = false, caps = [false, false]} = {}) {
  const pos = [], col = [], idx = []; let R = 0;
  xs.forEach(x => { const r = ringAt(x); R = r.length; r.forEach(([z, y, c]) => { pos.push(x, y, z); if (colors) col.push(c ?? 1, c ?? 1, c ?? 1); }); });
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < R - 1; j++) { const a = i * R + j, b = a + R; idx.push(a, b, a + 1, b, b + 1, a + 1); }
  const cap = i => { const s = pos.length / 3, c = [0, 0, 0];
    for (let j = 0; j < R; j++) { const k = (i * R + j) * 3; pos.push(pos[k], pos[k + 1], pos[k + 2]); c[0] += pos[k]; c[1] += pos[k + 1]; c[2] += pos[k + 2]; if (colors) col.push(col[k], col[k + 1], col[k + 2]); }
    pos.push(c[0] / R, c[1] / R, c[2] / R); if (colors) col.push(1, 1, 1);
    for (let j = 0; j < R - 1; j++) idx.push(s + R, s + j, s + j + 1); };
  if (caps[0]) cap(0); if (caps[1]) cap(xs.length - 1);
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  if (colors) g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals(); return g;
}
const add = (parent, o) => { parent.add(o); return o; };
const tubeOn = (parent, pts, r, mat, seg = 48) => add(parent, tube(pts, r, mat, false, seg));
let glass, hoodG;
function buildBody() {
  bodyG.clear();
  const bodyGeo = loft(range(XR, XF, 150), x => ringFull(bodyRight(x)), {colors: true, caps: [true, true]});
  add(bodyG, mesh(bodyGeo, paintV));
  add(bodyG, new THREE.LineSegments(new THREE.EdgesGeometry(bodyGeo, 35), edgeMat));
  // bonnet: its own panel hinged at the windscreen so it can open in the engine view
  hoodG = new THREE.Group(); hoodG.position.set(0.95, yBelt(0.95), 0); bodyG.add(hoodG);
  const hoodGeo = loft(range(0.95, XF, 40), x => ringFull(topRight(x, 0.035)), {caps: [false, true]}); hoodGeo.translate(-0.95, -yBelt(0.95), 0);
  hoodG.add(mesh(hoodGeo, paint));
  add(bodyG, mesh(loft(range(XR, -2.05, 6), x => ringFull(topRight(x, 0.025)), {caps: [true, false]}), paint));          // tailgate top
  glass = add(bodyG, mesh(loft(range(-2.12, 0.95, 90), x => ringFull(cabinRight(x))), M.glass, 0, 0, 0, false));
  add(bodyG, mesh(loft(range(-1.84, 0.17, 50), x => ringFull(roofRight(x)), {caps: [true, true]}), paint));               // roof
  add(bodyG, mesh(loft(range(-0.95, 0.0, 12), x => { const yr = yRoof(x), c = 0.03; return ringFull([[0, yr + c + 0.012], [0.39, yr + c * 0.8 + 0.011], [0.45, yr + c * 0.65 + 0.01]]); }), M.sun, 0, 0, 0, false)); // panoramic sunroof
  for (const s of [-1, 1]) {
    const wt = x => halfW(x) * 0.79 + 0.004, wb = x => halfW(x) * 0.95;
    tubeOn(bodyG, range(0.15, 0.95, 16).map(x => [x, yRoof(x) + 0.004, s * wt(x)]), 0.022, M.trim);                     // A-pillar
    tubeOn(bodyG, range(-2.12, -1.82, 8).map(x => [x, yRoof(x) + 0.004, s * wt(x)]), 0.024, M.trim);                    // D-pillar
    for (const [x, r] of [[-0.42, 0.03], [-1.5, 0.05]]) { const yb = yBelt(x), yr = yRoof(x), w = halfW(x);              // B and C pillars
      tubeOn(bodyG, [[x, yb + 0.02, s * (wb(x) + 0.004)], [x, yb + (yr - yb) * 0.5, s * ((w * 0.95 + w * 0.79) / 2 + 0.016)], [x, yr - 0.03, s * (w * 0.79 + 0.008)]], r, M.trim, 12); }
    tubeOn(bodyG, range(-1.95, 0.92, 40).map(x => [x, yBelt(x) + 0.004, s * (wb(x) + 0.004)]), 0.007, M.chrome, 80);   // chrome belt line
    tubeOn(bodyG, range(-1.72, 0.02, 30).map(x => [x, yRoof(x) + 0.075, s * halfW(x) * 0.7]), 0.012, M.rail, 60);       // roof rails
    for (const x of [0.0, -0.75, -1.7]) bodyG.add(mesh(new THREE.BoxGeometry(0.06, 0.06, 0.03), M.rail, x, yRoof(x) + 0.05, s * halfW(x) * 0.7));
    for (const x of [0.9, -0.42, -1.44]) tubeOn(bodyG, bodyRight(x).slice(6).map(([z, y]) => [x, y, s * (z + 0.003)]), 0.0035, M.seam, 16); // door shut lines
    for (const x of [0.22, -1.0]) { const h = mesh(new THREE.CapsuleGeometry(0.012, 0.08, 4, 8), M.chrome, x, yBelt(x) - 0.1, s * (halfW(x) * 0.99 + 0.012)); h.rotation.z = Math.PI / 2; bodyG.add(h); }
    for (const xw of [AX, -AX]) { const e = WR + 0.025; tubeOn(bodyG, [[xw - e, ySill(xw - e) + 0.03], ...range(-0.97, 0.97, 26).map(t => [xw + t * e, archY(t * WR) + 0.018]), [xw + e, ySill(xw + e) + 0.03]].map(([x, y]) => [x, y, s * halfW(x) * 0.992]), CRETA ? 0.05 : 0.04, M.clad, 60); }  // arch cladding
    // mirror on a stalk, with an indicator strip
    const mg = new THREE.Group(); mg.position.set(0.8, yBelt(0.8) + 0.1, s * (halfW(0.8) * 0.95 + 0.11)); bodyG.add(mg);
    mg.add(mesh(new RoundedBoxGeometry(0.11, 0.11, 0.2, 3, 0.04), paint), mesh(new THREE.BoxGeometry(0.05, 0.03, 0.1), M.trim, -0.01, -0.06, -s * 0.09));
    mg.add(mesh(new THREE.BoxGeometry(0.01, 0.014, 0.14), M.amber, 0.055, -0.03, s * 0.01, false));
    // headlamp cluster (quad LED) and the vertical tail-lamp blades
    const zl = s * 0.64, xn = noseX(zl), slope = (noseX(zl + 0.01) - noseX(zl - 0.01)) / 0.02;
    const hl = new THREE.Group(); hl.position.set(xn - 0.012, 0.74, zl); hl.rotation.y = Math.atan(slope); bodyG.add(hl);
    hl.add(mesh(new RoundedBoxGeometry(0.05, 0.13, 0.24, 2, 0.02), M.trim, 0, 0, 0, false));
    for (let i = 0; i < 4; i++) hl.add(mesh(new THREE.BoxGeometry(0.02, 0.035, 0.035), M.head, 0.022, 0.025 - (i > 1) * 0.05, -0.05 + (i % 2) * 0.1, false));
    tubeOn(bodyG, range(1.12, 0.9, 6).map(y => [-noseX(s * 0.8) - 0.004, y, s * 0.8]), 0.013, M.tail, 12);
    bodyG.add(mesh(new THREE.BoxGeometry(0.01, 0.03, 0.06), M.tail, XR - 0.004, 0.5, s * 0.7, false));                  // rear reflectors
  }
  add(bodyG, tube(range(-0.84, 0.84, 30).map(z => [noseX(z) + 0.006, yBelt(noseX(z)) - 0.03, z]), 0.011, M.drl, false, 60));  // full-width DRL bar
  tubeOn(bodyG, range(-0.84, 0.84, 30).map(z => [-noseX(z) - 0.006, yBelt(-noseX(z)) - 0.05, z]), 0.013, M.tail, 60);                       // connected tail-lamp bar
  const grille = CRETA ? mesh(new THREE.PlaneGeometry(1.1, 0.36), M.grilleCreta, XF + 0.004, 0.69, 0, false) : mesh(new THREE.PlaneGeometry(0.98, 0.32), M.grille, XF + 0.004, 0.71, 0, false); grille.rotation.y = Math.PI / 2; bodyG.add(grille);
  bodyG.add(mesh(new RoundedBoxGeometry(0.03, 0.06, 0.86, 2, 0.015), M.skid, XF + 0.01, 0.44, 0), mesh(new RoundedBoxGeometry(0.03, 0.05, 1.1, 2, 0.015), M.skid, XR - 0.01, 0.5, 0));
  bodyG.add(mesh(new THREE.BoxGeometry(0.008, 0.1, 0.5), M.plate, XF + 0.012, 0.54, 0), mesh(new THREE.BoxGeometry(0.008, 0.1, 0.5), M.plate, XR - 0.008, 0.78, 0));
  bodyG.add(mesh(new RoundedBoxGeometry(0.2, 0.035, 1.25, 2, 0.015), M.trim, -1.86, ROOF + 0.035, 0));                  // roof spoiler
  if (CRETA) cretaDetails();
}

// Creta 2024 design cues (from published specs): L-shaped LED DRL blades, connected tail lamps, shark-fin antenna, bonnet creases, rear wiper
function cretaDetails() {
  for (const s of [-1, 1]) {
    const z = s * 0.82, x = noseX(z);
    tubeOn(bodyG, range(0, 1, 6).map(t => [noseX(z) + 0.006, yBelt(x) - 0.03 - t * 0.2, z]), 0.011, M.drl, 12);                       // DRL blades
    tubeOn(bodyG, [[-noseX(s * 0.8) - 0.006, 0.9, s * 0.8], [-noseX(s * 0.6) - 0.006, 0.9, s * 0.6]], 0.012, M.tail, 8);               // tail-lamp "L"
    const yh = x => yBelt(x) + 0.035 * 0.92 + 0.003 - yBelt(0.95);
    hoodG.add(tube(range(1.0, 2.08, 16).map(x => [x - 0.95, yh(x), s * halfW(x) * 0.39]), 0.006, paint, false, 32));                   // bonnet creases
  }
  const fin = new THREE.Shape(); fin.moveTo(0.09, 0); fin.lineTo(-0.08, 0); fin.lineTo(-0.075, 0.06); fin.quadraticCurveTo(-0.02, 0.062, 0.09, 0);
  const fg = new THREE.ExtrudeGeometry(fin, {depth: 0.035, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.008, bevelSegments: 3}); fg.translate(0, 0, -0.0175);
  bodyG.add(mesh(fg, M.trim, -1.66, yRoof(-1.66) + 0.035, 0));                                                                      // shark-fin antenna
  const wip = mesh(new THREE.BoxGeometry(0.012, 0.014, 0.36), M.trim, -2.045, 1.35, 0.02); wip.rotation.x = 0.35; bodyG.add(wip);        // rear wiper
}
buildBody();

// ------------------------------------------------------------------ interior (seen through the glass, and from the driver's seat)
const leatherBox = (w, h, d, x, y, z, rz = 0) => { const m = mesh(new RoundedBoxGeometry(w, h, d, 3, Math.min(w, h, d) * 0.35), M.leather, x, y, z); m.rotation.z = rz; cabinG.add(m); return m; };
cabinG.add(mesh(new THREE.BoxGeometry(2.75, 0.02, 1.5), M.carpet, -0.52, 0.42, 0, false));
for (const z of [-0.38, 0.38]) {                     // front seats
  leatherBox(0.5, 0.12, 0.5, 0.0, 0.6, z); leatherBox(0.12, 0.6, 0.5, -0.24, 0.92, z, 0.2); leatherBox(0.09, 0.15, 0.25, -0.32, 1.3, z);
  cabinG.add(mesh(new THREE.BoxGeometry(0.32, 0.12, 0.3), M.dark, 0.0, 0.48, z));
}
leatherBox(0.5, 0.13, 1.24, -0.85, 0.61, 0); leatherBox(0.12, 0.58, 1.24, -1.1, 0.93, 0, 0.22);                         // rear bench
for (const z of [-0.42, 0, 0.42]) leatherBox(0.08, 0.12, 0.22, -1.2, 1.29, z);
leatherBox(0.32, 0.08, 0.22, -0.17, 0.74, 0);                                                                         // armrest
cabinG.add(mesh(new RoundedBoxGeometry(0.42, 0.24, 1.66, 4, 0.08), M.dash, 0.72, 0.98, 0), mesh(new RoundedBoxGeometry(0.3, 0.05, 1.6, 3, 0.02), M.leather, 0.74, 1.115, 0));
cabinG.add(mesh(new THREE.BoxGeometry(0.02, 0.025, 1.5), M.dashTrim, 0.51, 0.95, 0), mesh(new RoundedBoxGeometry(0.55, 0.15, 0.24, 3, 0.04), M.dash, 0.26, 0.58, 0));
cabinG.add(mesh(new RoundedBoxGeometry(0.22, 0.3, 0.26, 3, 0.04), M.dash, 0.52, 0.76, 0));
const amb = add(cabinG, mesh(new THREE.BoxGeometry(0.006, 0.008, 1.4), M.ambient, 0.505, 0.93, 0, false));
for (const z of [-0.6, -0.12, 0.12, 0.62]) cabinG.add(mesh(new RoundedBoxGeometry(0.02, 0.05, 0.13, 2, 0.01), M.plastic, 0.51, 1.03, z));   // AC vents
cabinG.add(mesh(new THREE.CylinderGeometry(0.008, 0.012, 0.12, 8), M.dashTrim, 0.32, 0.71, 0), mesh(new THREE.SphereGeometry(0.03, 16, 12), M.dashTrim, 0.32, 0.79, 0)); // gear lever
for (const s of [-1, 1]) {                           // door cards with ambient strips
  cabinG.add(mesh(new RoundedBoxGeometry(1.28, 0.5, 0.04, 2, 0.015), M.dash, 0.24, 0.83, s * 0.83), mesh(new RoundedBoxGeometry(0.98, 0.5, 0.04, 2, 0.015), M.dash, -0.93, 0.85, s * 0.83));
  cabinG.add(mesh(new THREE.BoxGeometry(2.2, 0.008, 0.006), M.ambient, -0.35, 0.99, s * 0.807, false));
}
cabinG.add(mesh(new THREE.BoxGeometry(1.95, 0.01, 1.3), M.headliner, -0.83, 1.6, 0, false), mesh(new THREE.BoxGeometry(0.9, 0.004, 0.84), M.sun, -0.48, 1.594, 0, false));
cabinG.add(mesh(new THREE.BoxGeometry(0.4, 0.02, 1.4), M.dash, -1.72, 1.08, 0), mesh(new RoundedBoxGeometry(0.02, 0.06, 0.22, 2, 0.01), M.trim, 0.42, 1.49, 0)); // parcel shelf, mirror
// steering wheel on the right (RHD)
const steer = new THREE.Group(); steer.position.set(0.38, 0.96, 0.38); steer.rotation.z = -0.35; cabinG.add(steer);
const sw = new THREE.Group(); sw.rotation.y = Math.PI / 2; steer.add(sw);
sw.add(mesh(new THREE.TorusGeometry(0.17, 0.02, 12, 48), M.leather), mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.04, 24), M.dash).rotateX(Math.PI / 2));
const spokes3 = new THREE.Group(), spokes4 = new THREE.Group(); sw.add(spokes3, spokes4);
for (const [grp, angles] of [[spokes3, [0, Math.PI, -Math.PI / 2]], [spokes4, [0.25, Math.PI - 0.25, -Math.PI / 2 + 0.45, -Math.PI / 2 - 0.45]]])
  for (const a of angles) { const sp = new THREE.Group(); sp.rotation.z = a; grp.add(sp); sp.add(mesh(new THREE.BoxGeometry(0.12, 0.028, 0.015), M.dashTrim, 0.1, 0, 0)); }
// Creta cabin extras: 4-spoke wheel, Bose speaker grilles, dual-zone climate panel, wireless charger, sun visors, dashcam
const cretaCab = new THREE.Group(); cabinG.add(cretaCab);
const spk = new THREE.MeshStandardMaterial({color: 0x8a8f96, metalness: 0.8, roughness: 0.45});
for (const s of [-1, 1]) for (const x of [0.55, -0.72]) cretaCab.add(mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.01, 28), spk, x, 0.68, s * 0.805).rotateX(Math.PI / 2));
cretaCab.add(mesh(new RoundedBoxGeometry(0.015, 0.07, 0.36, 2, 0.006), M.trim, 0.515, 0.875, 0));
for (const z of [-0.13, 0.13]) cretaCab.add(mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.02, 24), M.dashTrim, 0.505, 0.875, z).rotateZ(Math.PI / 2));
cretaCab.add(mesh(new THREE.BoxGeometry(0.12, 0.006, 0.1), M.trim, 0.43, 0.658, 0), mesh(new THREE.BoxGeometry(0.03, 0.03, 0.05), M.trim, 0.44, 1.53, 0.06));
for (const z of [-0.38, 0.38]) cretaCab.add(mesh(new THREE.BoxGeometry(0.17, 0.015, 0.4), M.headliner, 0.22, 1.57, z));
steer.add(mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.25, 12), M.dash, 0.13, 0, 0).rotateZ(Math.PI / 2));
// pedals hinge at the top so they swing forward with throttle / braking
const pedal = (z, w) => { const p = new THREE.Group(); p.position.set(0.66, 0.68, z); cabinG.add(p); p.add(mesh(new THREE.BoxGeometry(0.02, 0.1, w), M.dashTrim, -0.01, -0.09, 0)); return p; };
const accPedal = pedal(0.5, 0.05), brkPedal = pedal(0.36, 0.09);
// live panoramic screens: infotainment (centre) + digital cluster (in front of the driver)
const scrC = document.createElement("canvas"); scrC.width = 1024; scrC.height = 190;
const scrTex = new THREE.CanvasTexture(scrC); scrTex.colorSpace = THREE.SRGBColorSpace;
cabinG.add(mesh(new RoundedBoxGeometry(0.02, 0.16, 0.9, 2, 0.01), M.trim, 0.612, 1.2, 0.21));
const screen = mesh(new THREE.PlaneGeometry(0.86, 0.15), new THREE.MeshBasicMaterial({map: scrTex, toneMapped: false}), 0.6, 1.2, 0.21, false);
screen.rotation.y = -Math.PI / 2; cabinG.add(screen);
let scrT = 0;
function drawScreens(d, ac) {
  const g = scrC.getContext("2d"), w = 1024, h = 190;
  g.fillStyle = "#04060a"; g.fillRect(0, 0, w, h);
  g.fillStyle = "#0b1119"; g.fillRect(6, 6, 500, h - 12); g.fillRect(518, 6, 500, h - 12);
  g.fillStyle = ac; g.font = "600 22px system-ui"; g.fillText("OBD Dashboard", 24, 38);
  g.fillStyle = "#8ea0b5"; g.font = "18px system-ui"; g.fillText(new Date().toTimeString().slice(0, 5), 440, 38);
  const tile = (x, lab, val) => { g.fillStyle = "#121b27"; g.fillRect(x, 58, 150, 110); g.fillStyle = "#8ea0b5"; g.font = "16px system-ui"; g.fillText(lab, x + 12, 84);
    g.fillStyle = "#e8eef5"; g.font = "600 34px system-ui"; g.fillText(val, x + 12, 136); };
  tile(24, "Battery", d.v != null ? d.v.toFixed(1) + " V" : "–"); tile(186, "Coolant", d.temp != null ? Math.round(d.temp) + "°" : "–"); tile(348, "Fuel", d.fuel != null ? Math.round(d.fuel) + "%" : "–");
  const cx = 768, cy = 112, rpmF = Math.min(1, (d.rpm || 0) / 7000);
  g.lineWidth = 12; g.strokeStyle = "#1c2633"; g.beginPath(); g.arc(cx, cy, 70, Math.PI * 0.8, Math.PI * 2.2); g.stroke();
  g.strokeStyle = rpmF > 0.85 ? "#ff4040" : ac; g.beginPath(); g.arc(cx, cy, 70, Math.PI * 0.8, Math.PI * (0.8 + 1.4 * rpmF)); g.stroke();
  g.fillStyle = "#f4f7fb"; g.textAlign = "center"; g.font = "700 54px system-ui"; g.fillText(Math.round(d.spd || 0), cx, cy + 14);
  g.font = "15px system-ui"; g.fillStyle = "#8ea0b5"; g.fillText("km/h", cx, cy + 36); g.fillText(Math.round(d.rpm || 0) + " rpm", cx, cy + 62);
  g.font = "700 40px system-ui"; g.fillStyle = ac; g.fillText(d.gear || "–", 600, 118); g.font = "14px system-ui"; g.fillStyle = "#8ea0b5"; g.fillText("gear", 600, 140);
  const bar = (x, f, col, lab) => { g.fillStyle = "#1c2633"; g.fillRect(x, 50, 14, 100); g.fillStyle = col; const hh = 100 * Math.max(0, Math.min(1, f)); g.fillRect(x, 150 - hh, 14, hh);
    g.fillStyle = "#8ea0b5"; g.fillText(lab, x + 7, 172); };
  bar(920, d.temp != null ? (d.temp - 40) / 80 : 0, d.temp > 105 ? "#ff4040" : "#4fc3ff", "°C"); bar(965, (d.fuel ?? 0) / 100, (d.fuel ?? 100) < 15 ? "#ffb020" : "#5be37d", "fuel");
  g.textAlign = "left"; scrTex.needsUpdate = true;
}

// ------------------------------------------------------------------ engine bay furniture (visible with the bonnet open)
for (const s of [-1, 1]) bay.add(mesh(new THREE.CylinderGeometry(0.075, 0.095, 0.16, 24), paint, 1.3, 0.83, s * 0.62), mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.02, 16), M.dark, 1.3, 0.92, s * 0.62));
bay.add(mesh(new THREE.BoxGeometry(0.02, 0.32, 1.5), M.dark, 0.95, 0.86, 0), mesh(new RoundedBoxGeometry(0.09, 0.05, 1.5, 2, 0.015), M.plastic, 0.99, 1.075, 0));   // firewall, cowl
bay.add(mesh(new RoundedBoxGeometry(0.06, 0.045, 1.3, 2, 0.015), M.plastic, 2.0, 0.87, 0), mesh(new THREE.BoxGeometry(0.03, 0.03, 0.06), M.steel, 2.03, 0.86, 0)); // radiator support + latch
// coolant expansion tank (level rises with temperature), brake booster + fluid, washer bottle
bay.add(mesh(new RoundedBoxGeometry(0.11, 0.13, 0.12, 2, 0.02), M.res, 1.86, 0.82, 0.5, false));
const coolGeo = new THREE.BoxGeometry(0.095, 0.1, 0.105); coolGeo.translate(0, 0.05, 0);
const coolFluid = add(bay, mesh(coolGeo, M.coolant, 1.86, 0.762, 0.5, false));
bay.add(mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.02, 16), M.plastic, 1.86, 0.895, 0.5));
bay.add(mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.1, 32), M.dark, 1.03, 0.88, 0.48).rotateZ(Math.PI / 2));
bay.add(mesh(new RoundedBoxGeometry(0.07, 0.06, 0.09, 2, 0.01), M.brakeFluid, 1.12, 0.96, 0.48), mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.02, 12), M.plastic, 1.12, 1.0, 0.48));
bay.add(mesh(new RoundedBoxGeometry(0.1, 0.13, 0.09, 2, 0.02), M.washer, 1.92, 0.76, -0.72), mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.02, 12), M.washer, 1.92, 0.835, -0.72));
// drive shafts with CV boots, spinning with the front wheels
const bootGeo = new THREE.LatheGeometry(range(-0.05, 0.05, 16).map((y, i) => new THREE.Vector2(0.018 + 0.012 * Math.abs(Math.sin(i * Math.PI / 4)) + (0.05 - Math.abs(y)) * 0.15, y)), 16);
function shaft(a, b) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A), len = d.length();
  const g = new THREE.Group(); g.position.copy(A).add(B).multiplyScalar(0.5); g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()); bay.add(g);
  const s = new THREE.Group(); g.add(s); s.add(mesh(new THREE.CylinderGeometry(0.013, 0.013, len, 10), M.steel));
  for (const e of [-1, 1]) s.add(mesh(bootGeo, M.rubber, 0, e * (len / 2 - 0.06), 0));
  return s;
}
const shafts = [shaft([1.47, 0.5, -0.42], [AX, WY, -0.7]), shaft([1.36, 0.46, -0.25], [AX, WY, 0.7])];

// ------------------------------------------------------------------ wheels: lathe-profile tyres, diamond-cut twin-spoke alloys, discs, calipers
const tyreGeo = new THREE.LatheGeometry([[0.255, -0.1], [0.3, -0.108], [0.335, -0.105], [0.352, -0.088], [0.359, -0.06], [0.361, 0], [0.359, 0.06], [0.352, 0.088], [0.335, 0.105], [0.3, 0.108], [0.255, 0.1]].map(([r, y]) => new THREE.Vector2(r, y)), 72);
function makeWheel() {
  const g = new THREE.Group(), spin = new THREE.Group(); g.add(spin);
  const tyre = mesh(tyreGeo, M.tyre); tyre.rotation.x = Math.PI / 2; spin.add(tyre);
  const barrel = mesh(new THREE.CylinderGeometry(0.255, 0.255, 0.2, 48, 1, true), M.rimDark); barrel.rotation.x = Math.PI / 2; spin.add(barrel);
  spin.add(mesh(new THREE.TorusGeometry(0.252, 0.012, 8, 48), M.rim, 0, 0, 0.1), mesh(new THREE.CircleGeometry(0.25, 32), M.rimDark, 0, 0, -0.04));
  spin.add(mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.05, 24), M.rim, 0, 0, 0.085).rotateX(Math.PI / 2), mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.012, 20), M.dark, 0, 0, 0.112).rotateX(Math.PI / 2));
  for (let i = 0; i < 10; i++) {
    const p = new THREE.Group(); p.rotation.z = Math.floor(i / 2) * 2 * Math.PI / 5 + (i % 2 ? 0.14 : -0.14); p.position.z = 0.085; spin.add(p);
    const sp = mesh(new THREE.BoxGeometry(0.034, 0.19, 0.03), M.rimDark, 0, 0.155, 0); p.add(sp); sp.add(mesh(new THREE.BoxGeometry(0.026, 0.19, 0.006), M.rim, 0, 0, 0.017));
  }
  spin.add(mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.02, 40), M.disc).rotateX(Math.PI / 2));
  g.add(mesh(new RoundedBoxGeometry(0.1, 0.12, 0.07, 2, 0.02), M.caliper, 0.13, 0.09, 0.02));
  return {g, spin};
}
const wheels = [];
for (const [x, z] of [[AX, 0.79], [AX, -0.79], [-AX, 0.79], [-AX, -0.79]]) {
  const w = makeWheel(); w.g.position.set(x, WY, z); if (z < 0) w.g.rotation.y = Math.PI; car.add(w.g); wheels.push(w);
}

// ------------------------------------------------------------------ engine (crank along z, transverse like most FWD cars)
const eng = new THREE.Group(); eng.position.set(1.5, 0.6, 0); car.add(eng);
const sys = {air: new THREE.Group(), fuel: new THREE.Group(), power: new THREE.Group(), exh: new THREE.Group(), cool: new THREE.Group(), elec: new THREE.Group()};
eng.add(sys.power); car.add(sys.air, sys.fuel, sys.exh, sys.cool, sys.elec);
const K = {pitch: 0.105, r: 0.034, l: 0.115, bore: 0.038, deck: 0.2};
let engParts = null, N = 4, cyls = [], crank = null, crankAngle = 0, pulleys = [], fan = null, sparkLight = null;
const FIRING = {1: [1], 2: [1, 2], 3: [1, 2, 3], 4: [1, 3, 4, 2], 5: [1, 2, 4, 5, 3], 6: [1, 5, 3, 6, 2, 4], 8: [1, 8, 4, 3, 6, 5, 7, 2]};
function buildEngine(n) {
  sys.power.clear(); N = n; cyls = [];
  const len = n * K.pitch + 0.08, z0 = -(n - 1) * K.pitch / 2;
  const block = mesh(new RoundedBoxGeometry(0.24, 0.3, len, 3, 0.02), M.cast, 0, 0.1, 0, false); sys.power.add(block);
  const blockEdges = new THREE.LineSegments(new THREE.EdgesGeometry(block.geometry, 30), new THREE.LineBasicMaterial({color: 0x9fb3c8, transparent: true, opacity: 0.5})).translateY(0.1); sys.power.add(blockEdges);
  const head = mesh(new RoundedBoxGeometry(0.25, 0.08, len, 3, 0.02), M.cast, 0, 0.29, 0); sys.power.add(head);
  // dress-up parts that hide the internals until X-ray / cutaway: plastic engine cover, oil pan, timing cover, exhaust heat shield
  const dress = new THREE.Group(); sys.power.add(dress);
  dress.add(mesh(new RoundedBoxGeometry(0.21, 0.045, len - 0.06, 4, 0.02), M.cover, -0.01, 0.425, 0));
  dress.add(mesh(new RoundedBoxGeometry(0.2, 0.08, len - 0.04, 3, 0.02), M.dark, 0, -0.09, 0));
  dress.add(mesh(new RoundedBoxGeometry(0.2, 0.34, 0.025, 3, 0.01), M.dark, 0, 0.12, len / 2 + 0.005));
  dress.add(mesh(new RoundedBoxGeometry(0.035, 0.15, len - 0.04, 2, 0.012), M.shield, 0.16, 0.2, 0));
  dress.add(mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.02, 20), M.yellow, 0.05, 0.455, z0));                       // oil filler cap
  dress.add(tube([[-0.1, 0.1, z0 + 0.12], [-0.13, 0.36, z0 + 0.12], [-0.13, 0.41, z0 + 0.12]], 0.005, M.steel, false, 12));  // dipstick
  dress.add(mesh(new THREE.TorusGeometry(0.018, 0.006, 8, 20), M.orange, -0.13, 0.43, z0 + 0.12));
  const cover = mesh(new RoundedBoxGeometry(0.2, 0.06, len - 0.02, 4, 0.025), new THREE.MeshPhysicalMaterial({color: 0x1a1c20, metalness: 0.6, roughness: 0.35, clearcoat: 0.6}), 0, 0.355, 0); sys.power.add(cover);
  for (let i = 0; i < 5; i++) sys.power.add(mesh(new THREE.BoxGeometry(0.21, 0.006, 0.012), M.chrome, 0, 0.386, z0 - 0.03 + i * (len - 0.05) / 4));
  const order = FIRING[n] || Array.from({length: n}, (_, i) => i + 1);
  crank = new THREE.Group(); crank.position.y = -0.02; sys.power.add(crank);
  crank.add(mesh(new THREE.CylinderGeometry(0.014, 0.014, len + 0.1, 16), M.steel).rotateX(Math.PI / 2));
  for (let i = 0; i < n; i++) {
    const z = z0 + i * K.pitch, k = order.indexOf(i + 1), fireAt = k * 4 * Math.PI / n;
    const throwG = new THREE.Group(); throwG.rotation.z = fireAt; throwG.position.z = z; crank.add(throwG);      // crank pin angle = −fire angle
    throwG.add(mesh(new THREE.BoxGeometry(0.03, K.r + 0.03, 0.012), M.steel, 0, K.r / 2, -0.022), mesh(new THREE.BoxGeometry(0.03, K.r + 0.03, 0.012), M.steel, 0, K.r / 2, 0.022));
    throwG.add(mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.05, 12), M.chrome, 0, K.r, 0).rotateX(Math.PI / 2));
    const pmat = M.piston.clone();
    const piston = mesh(new THREE.CylinderGeometry(K.bore * 0.96, K.bore * 0.96, 0.05, 28), pmat); sys.power.add(piston);
    const rod = mesh(new THREE.BoxGeometry(0.014, K.l, 0.02), M.steel); sys.power.add(rod);
    const coil = mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.06, 16), M.plastic, 0, 0.41, z); sys.power.add(coil);
    const sp = mesh(new THREE.SphereGeometry(0.03, 14, 10), M.spark.clone(), 0, 0.235, z, false); sys.power.add(sp);
    cyls.push({z, fireAt, piston, rod, spark: sp, pmat, coil});
    piston.position.z = z; rod.position.z = z;
  }
  sparkLight = new THREE.PointLight(0xffc860, 0, 0.6, 2); sys.power.add(sparkLight);
  // belt drive at the +z end: crank pulley, alternator, water pump / AC
  const ez = len / 2 + 0.03;
  pulleys = [[0, -0.02, 0.06, 1], [0.13, 0.22, 0.032, 2.2], [-0.1, 0.24, 0.045, 1.5]].map(([x, y, r, ratio]) => {
    const p = mesh(new THREE.CylinderGeometry(r, r, 0.022, 32), M.chrome, x, y, ez); p.rotation.x = Math.PI / 2; sys.power.add(p);
    p.add(mesh(new THREE.BoxGeometry(r * 1.6, 0.006, 0.024), M.dark)); return {p, ratio};
  });
  const beltPts = [[0.065, -0.02], [0.16, 0.22], [0.13, 0.255], [-0.1, 0.29], [-0.15, 0.23], [-0.055, -0.04], [0, -0.085]].map(([x, y]) => [x, y, ez]);
  const beltTex = (() => { const c = document.createElement("canvas"); c.width = 64; c.height = 4; const g = c.getContext("2d"); g.fillStyle = "#111"; g.fillRect(0, 0, 64, 4); g.fillStyle = "#3a3a3a"; for (let i = 0; i < 64; i += 8) g.fillRect(i, 0, 3, 4); const t = new THREE.CanvasTexture(c); t.wrapS = THREE.RepeatWrapping; t.repeat.set(14, 1); return t; })();
  M.belt.map = beltTex; sys.power.add(tube(beltPts, 0.007, M.belt, true, 120));
  sys.power.add(mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.1, 24), M.steel, 0.13, 0.22, ez - 0.07).rotateX(Math.PI / 2));   // alternator
  const gearbox = mesh(new RoundedBoxGeometry(0.22, 0.24, 0.2, 3, 0.03), M.cast, 0.02, 0.02, -len / 2 - 0.12); sys.power.add(gearbox);
  const bell = mesh(new THREE.CylinderGeometry(0.15, 0.12, 0.06, 32), M.cast, 0, 0.04, -len / 2 - 0.02); bell.rotation.x = Math.PI / 2; sys.power.add(bell);
  engParts = {block, head, gearbox, bell, blockEdges, dress};
}

// intake: air box → throttle body → plenum → runners (with flowing particles)
function buildIntake() {
  sys.air.clear(); const len = N * K.pitch, z0 = -(N - 1) * K.pitch / 2, ex = eng.position.x, ey = eng.position.y;
  const plast = new THREE.MeshStandardMaterial({color: 0x1d2025, roughness: 0.6, emissive: 0x3fa7ff, emissiveIntensity: 0});
  sys.air.userData.mats = [plast];
  sys.air.add(mesh(new THREE.CylinderGeometry(0.045, 0.045, len + 0.06, 20), plast, ex - 0.2, ey + 0.32, 0).rotateX(Math.PI / 2));
  for (let i = 0; i < N; i++) sys.air.add(tube([[ex - 0.2, ey + 0.32, z0 + i * K.pitch], [ex - 0.19, ey + 0.38, z0 + i * K.pitch], [ex - 0.11, ey + 0.33, z0 + i * K.pitch], [ex - 0.09, ey + 0.28, z0 + i * K.pitch]], 0.018, plast));
  sys.air.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.07, 24), M.chrome, ex - 0.2, ey + 0.32, -len / 2 - 0.08).rotateX(Math.PI / 2));     // throttle body
  sys.air.add(mesh(new RoundedBoxGeometry(0.28, 0.13, 0.26, 3, 0.03), plast, ex + 0.25, ey + 0.28, -0.5));                                          // air box
  sys.air.add(tube([[ex + 0.25, ey + 0.28, -0.4], [ex + 0.05, ey + 0.36, -0.42], [ex - 0.2, ey + 0.32, -len / 2 - 0.12]], 0.035, plast));
  airPath = new THREE.CatmullRomCurve3([[2.15, 0.62, -0.45], [1.85, 0.8, -0.5], [ex + 0.25, ey + 0.28, -0.5], [ex + 0.05, ey + 0.36, -0.42], [ex - 0.2, ey + 0.32, -len / 2 - 0.12], [ex - 0.2, ey + 0.32, 0]].map(p => new THREE.Vector3(...p)));
}
// exhaust: headers → downpipe → catalyst → under the floor → muffler → tailpipe (glows with heat)
let exPath = null, airPath = null, fuelPath = null;
function buildExhaust() {
  sys.exh.clear(); const z0 = -(N - 1) * K.pitch / 2, ex = eng.position.x, ey = eng.position.y;
  for (let i = 0; i < N; i++) sys.exh.add(tube([[ex + 0.12, ey + 0.26, z0 + i * K.pitch], [ex + 0.2, ey + 0.22, z0 + i * K.pitch * 0.7], [ex + 0.22, ey + 0.05, 0.08], [ex + 0.16, ey - 0.15, 0.12]], 0.016, M.exhaust));
  exPath = new THREE.CatmullRomCurve3([[ex + 0.16, ey - 0.15, 0.12], [ex - 0.05, 0.28, 0.2], [0.6, 0.22, 0.32], [-1.0, 0.22, 0.38], [-1.75, 0.26, 0.42], [-2.25, 0.27, 0.45]].map(p => new THREE.Vector3(...p)));
  sys.exh.add(new THREE.Mesh(new THREE.TubeGeometry(exPath, 120, 0.032, 12), M.exhaust));
  sys.exh.add(mesh(new THREE.CapsuleGeometry(0.07, 0.3, 6, 16), M.exhaust, 0.75, 0.23, 0.3).rotateZ(Math.PI / 2));     // catalytic converter
  sys.exh.add(mesh(new THREE.CapsuleGeometry(0.11, 0.42, 6, 18), M.exhaust, -1.6, 0.27, 0.42).rotateZ(Math.PI / 2));    // muffler
}
// cooling: radiator with fins, electric fan, hoses tinted by coolant temperature
function buildCooling() {
  sys.cool.clear();
  const finTex = (() => { const c = document.createElement("canvas"); c.width = 8; c.height = 64; const g = c.getContext("2d"); g.fillStyle = "#3d454e"; g.fillRect(0, 0, 8, 64); g.fillStyle = "#7b8691"; for (let i = 0; i < 64; i += 4) g.fillRect(0, i, 8, 1); const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(40, 6); return t; })();
  M.radiator.map = finTex;
  sys.cool.add(mesh(new THREE.BoxGeometry(0.05, 0.42, 1.1), M.radiator, 1.98, 0.62, 0));
  fan = new THREE.Group(); fan.position.set(1.91, 0.62, 0); sys.cool.add(fan);
  fan.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.04, 16), M.plastic).rotateZ(Math.PI / 2));
  for (let i = 0; i < 7; i++) { const b = mesh(new THREE.BoxGeometry(0.01, 0.16, 0.05), M.plastic); b.position.y = 0.09; b.rotation.x = 0.4; const p = new THREE.Group(); p.rotation.x = i * Math.PI * 2 / 7; p.add(b); fan.add(p); }
  sys.cool.add(mesh(new THREE.TorusGeometry(0.19, 0.01, 8, 40), M.plastic, 1.91, 0.62, 0).rotateY(Math.PI / 2));
  sys.cool.add(tube([[1.96, 0.8, 0.4], [1.8, 0.9, 0.3], [eng.position.x + 0.1, eng.position.y + 0.3, 0.25]], 0.022, M.hose));
  sys.cool.add(tube([[1.96, 0.45, -0.4], [1.75, 0.42, -0.3], [eng.position.x + 0.1, eng.position.y - 0.05, -0.2]], 0.022, M.hose));
}
// electrical: battery with a live charge bar + cable to the alternator
let chargeBar = null;
function buildElectrical() {
  sys.elec.clear();
  sys.elec.add(mesh(new RoundedBoxGeometry(0.26, 0.19, 0.17, 3, 0.015), M.battery, 1.62, 0.66, -0.62));
  sys.elec.add(mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.03, 12), new THREE.MeshStandardMaterial({color: 0xcc2020}), 1.55, 0.77, -0.62));
  sys.elec.add(mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.03, 12), M.dark, 1.69, 0.77, -0.62));
  chargeBar = mesh(new THREE.BoxGeometry(0.2, 0.012, 0.03), M.charge, 1.62, 0.758, -0.55, false); sys.elec.add(chargeBar);
  sys.elec.add(tube([[1.55, 0.79, -0.62], [1.62, 0.95, -0.2], [1.6, 0.95, 0.2], [eng.position.x + 0.13, eng.position.y + 0.22, N * K.pitch / 2 + 0.02]], 0.008, new THREE.MeshStandardMaterial({color: 0xaa1515})));
}
// fuel: tank under the rear seats + fuel line with flowing particles
function buildFuel() {
  sys.fuel.clear();
  sys.fuel.add(mesh(new RoundedBoxGeometry(0.7, 0.24, 0.95, 4, 0.06), M.tank, -0.95, 0.44, 0));
  fuelPath = new THREE.CatmullRomCurve3([[-0.7, 0.36, -0.3], [0, 0.3, -0.45], [1.0, 0.36, -0.4], [eng.position.x - 0.15, eng.position.y + 0.3, -0.2]].map(p => new THREE.Vector3(...p)));
  sys.fuel.add(new THREE.Mesh(new THREE.TubeGeometry(fuelPath, 80, 0.008, 8), M.steel));
}

// ------------------------------------------------------------------ particles (air in, exhaust out, fuel flow)
function makeFlow(n, color, size) {
  const g = new THREE.BufferGeometry(), pos = new Float32Array(n * 3), t = new Float32Array(n);
  for (let i = 0; i < n; i++) t[i] = Math.random();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({color, size, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true});
  const p = new THREE.Points(g, m); p.frustumCulled = false; scene.add(p); return {p, t, n};
}
const airFlow = makeFlow(140, 0x7cc4ff, 0.028), fuelFlow = makeFlow(50, 0xffc040, 0.022);
const exhN = 160, exhGeo = new THREE.BufferGeometry(), exhPos = new Float32Array(exhN * 3), exhVel = new Float32Array(exhN * 3), exhAge = new Float32Array(exhN).fill(9);
exhGeo.setAttribute("position", new THREE.BufferAttribute(exhPos, 3));
const exhMat = new THREE.PointsMaterial({color: 0xbfc6cf, size: 0.09, transparent: true, opacity: 0.35, depthWrite: false, sizeAttenuation: true});
const exhPts = new THREE.Points(exhGeo, exhMat); exhPts.frustumCulled = false; scene.add(exhPts);
function flowStep(f, path, speed, dt, obj) {
  if (!path) return; const a = f.p.geometry.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < f.n; i++) {
    f.t[i] = (f.t[i] + speed * dt * (0.8 + (i % 7) * 0.05)) % 1;
    path.getPointAt(f.t[i], v); obj.localToWorld(v);
    a.setXYZ(i, v.x + Math.sin(i * 12.9) * 0.012, v.y + Math.cos(i * 7.3) * 0.012, v.z + Math.sin(i * 3.1) * 0.012);
  }
  a.needsUpdate = true; f.p.material.opacity = speed > 0 ? 0.85 : 0;
}

// ------------------------------------------------------------------ live labels
const LBL = {};
function label(key, info, parent, x, y, z) {
  const el = document.createElement("div"); el.className = "h3d-lbl"; el.dataset.info = info; el.innerHTML = "–";
  const o = new CSS2DObject(el); o.position.set(x, y, z); parent.add(o); LBL[key] = {el, o}; return el;
}
function buildLabels() {
  Object.values(LBL).forEach(l => l.o.parent?.remove(l.o));
  label("rpm", "0C", eng, 0, 0.55, 0); label("cool", "67", sys.cool, 1.98, 0.95, -0.5); label("bat", "RV", sys.elec, 1.62, 0.92, -0.62);
  label("speed", "0D", car, AX, 0.9, 0.95); label("cat", "3C", sys.exh, 0.75, 0.45, 0.3); label("air", "10", sys.air, 2.0, 1.15, -0.5);
  label("fuel", "", sys.fuel, -0.95, 0.72, 0); label("thr", "11", sys.air, eng.position.x - 0.2, eng.position.y + 0.55, -0.4);
}
function setLbl(k, html, lvl = "") { const l = LBL[k]; if (!l) return; if (l.el._h !== html) { l.el.innerHTML = html; l.el._h = html; } l.el.className = "h3d-lbl" + (lvl ? " " + lvl : ""); }

// ------------------------------------------------------------------ toolbar: views, X-ray, labels, rotate, quality, paint
const PAINTS = [["#0b0c10", "Abyss Black"], ["#e9ecef", "Atlas White"], ["#b3121b", "Fiery Red"], ["#5b6168", "Titan Grey"], ["#1f5245", "Robust Emerald Pearl"], ["#1b2a4a", "Starry Night"], ["#8a7d5b", "Ranger Khaki"]];
const VIEWS = {car: [[5.2, 2.6, 5.4], [0.2, 0.7, 0]], cabin: [[-0.25, 1.29, 0.385], [-0.17, 1.27, 0.38]], engine: [[3.0, 2.0, 1.35], [1.45, 0.75, 0]], cutaway: [[2.05, 1.22, 0.62], [1.5, 0.7, 0]], side: [[0.2, 1.3, 6.2], [0, 0.55, 0]]};
let xray = q("xray") === "1", showLbl = q("labels") !== "0", view = "car", camTween = null;
const bar = Object.assign(document.createElement("div"), {className: "h3d-bar"});
bar.innerHTML = `<button data-v="car" class="on">🚗 Car</button><button data-v="cabin">🪑 Interior</button><button data-v="engine">⚙ Engine</button><button data-v="cutaway">🔬 Cutaway</button><button data-v="side">💨 Exhaust</button>
  <button data-t="xray">X-ray</button><button data-t="labels">Labels</button><button data-t="rot">⟳ Rotate</button><button data-t="q">✨ ${quality === "high" ? "High" : "Balanced"}</button><button data-t="body"></button><button data-t="model">📦 3D model</button>
  <span class="h3d-menu" hidden><button data-m="load">Load .glb / .gltf file…</button><button data-m="turn">↻ Turn 180°</button><button data-m="remove">Remove model</button></span>
  <span class="h3d-paint">${PAINTS.map(([c, n]) => `<i data-paint="${c}" title="${n}" style="background:${c}"></i>`).join("")}</span>`;
host.appendChild(bar);
const note = Object.assign(document.createElement("div"), {className: "h3d-note", textContent: "drag to orbit · pinch / scroll to zoom · engine in slow motion (1/10)"});
host.appendChild(note);
function syncBar() {
  bar.querySelectorAll("[data-v]").forEach(b => b.classList.toggle("on", b.dataset.v === view));
  bar.querySelector('[data-t="xray"]').classList.toggle("on", xray);
  bar.querySelector('[data-t="labels"]').classList.toggle("on", showLbl);
  bar.querySelector('[data-t="rot"]').classList.toggle("on", controls.autoRotate);
  bar.querySelector('[data-t="body"]').textContent = "🚙 " + (custom ? "Your model" : bodyMode === "auto" ? `Auto (${CRETA ? "Creta" : "generic SUV"})` : bodyMode === "creta" ? "Creta" : "Generic SUV");
  bar.querySelector('[data-t="model"]').classList.toggle("on", !!custom);
  bar.querySelectorAll("[data-paint]").forEach(i => i.classList.toggle("on", i.dataset.paint === paintOf()));
  labelRenderer.domElement.style.display = showLbl && view !== "cabin" ? "" : "none";
}
function goView(v) {
  view = v; const [p, t] = VIEWS[v], inside = v === "cabin";
  // inside the car the camera pivots around the driver's eye ("look around"); outside it orbits the car
  Object.assign(controls, inside ? {minDistance: 0.02, maxDistance: 0.12, minPolarAngle: 0.25, maxPolarAngle: Math.PI * 0.85, autoRotate: false}
    : {minDistance: 0.8, maxDistance: 14, minPolarAngle: 0, maxPolarAngle: Math.PI * 0.495, autoRotate: q("autorot") !== "0"});
  camTween = {t: 0, s: performance.now(), p0: camera.position.clone(), t0: controls.target.clone(), p1: new THREE.Vector3(...p), t1: new THREE.Vector3(...t)};
  if (v === "cutaway" || v === "side") xray = true;
  syncBar();
}
bar.addEventListener("click", e => {
  const b = e.target.closest("button,[data-paint]"); if (!b) return;
  if (b.dataset.v) goView(b.dataset.v);
  if (b.dataset.t === "xray") { xray = !xray; qs("xray", xray ? "1" : "0"); }
  if (b.dataset.t === "labels") { showLbl = !showLbl; qs("labels", showLbl ? "1" : "0"); }
  if (b.dataset.t === "rot") { controls.autoRotate = !controls.autoRotate; qs("autorot", controls.autoRotate ? "1" : "0"); }
  if (b.dataset.t === "q") { quality = quality === "high" ? "balanced" : "high"; qs("quality", quality); location.reload(); }
  if (b.dataset.t === "body") { bodyMode = {auto: "creta", creta: "generic", generic: "auto"}[bodyMode]; qs("body", bodyMode); }
  if (b.dataset.t === "model") bar.querySelector(".h3d-menu").hidden = !bar.querySelector(".h3d-menu").hidden;
  if (b.dataset.m === "load") filePick.click();
  if (b.dataset.m === "turn" && custom) { custom.rotation.y += Math.PI; qs("modelTurn", String((+(q("modelTurn") || 0) + 1) % 2)); }
  if (b.dataset.m === "remove") { setCustom(null); idb("delete"); }
  if (b.dataset.paint) { VEH().paint = b.dataset.paint; saveVehicles(); }
  syncBar();
});
renderer.domElement.addEventListener("pointerdown", () => { camTween = null; });

// ------------------------------------------------------------------ your own 3D model (.glb/.gltf): replaces the built-in body, kept on this device
// e.g. a Creta model you bought or downloaded under a licence that allows personal use. It's scaled to the real
// length (4.33 m), set on the road and centred; the engine, systems and labels stay in place underneath it.
const filePick = Object.assign(document.createElement("input"), {type: "file", accept: ".glb,.gltf,model/gltf-binary"}); filePick.hidden = true; host.appendChild(filePick);
let custom = null, customMats = [];
function idb(op, val) {
  return new Promise(res => { try { const r = indexedDB.open("h3d", 1); r.onupgradeneeded = () => r.result.createObjectStore("files");
    r.onsuccess = () => { const tx = r.result.transaction("files", op === "get" ? "readonly" : "readwrite"), st = tx.objectStore("files");
      const q2 = op === "get" ? st.get("model") : op === "put" ? st.put(val, "model") : st.delete("model"); q2.onsuccess = () => res(q2.result); q2.onerror = () => res(null); };
    r.onerror = () => res(null); } catch (e) { res(null); } });
}
function setCustom(obj) {
  if (custom) { car.remove(custom); custom = null; customMats = []; }
  if (obj) { custom = obj; car.add(obj); }
  syncBar();
}
async function loadCustom(buf) {
  const loader = new GLTFLoader(), draco = new DRACOLoader(); draco.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.6/"); loader.setDRACOLoader(draco);
  const gltf = await loader.parseAsync(buf, ""), m = gltf.scene, g = new THREE.Group(); g.add(m);
  let box = new THREE.Box3().setFromObject(m), size = box.getSize(new THREE.Vector3());
  if (size.z > size.x) { m.rotation.y = Math.PI / 2; box = new THREE.Box3().setFromObject(m); size = box.getSize(new THREE.Vector3()); }   // length along x
  const k = 4.33 / size.x; m.scale.multiplyScalar(k); box = new THREE.Box3().setFromObject(m); const c = box.getCenter(new THREE.Vector3());
  m.position.x -= c.x; m.position.z -= c.z; m.position.y -= box.min.y;
  if (q("modelTurn") === "1") g.rotation.y = Math.PI;
  const mats = []; m.traverse(o => { if (o.isMesh) { o.castShadow = true; o.material = Array.isArray(o.material) ? o.material.map(x => x.clone()) : o.material.clone();
    [].concat(o.material).forEach(x => { x.userData.o0 = x.opacity; x.userData.t0 = x.transparent; mats.push(x); }); } });
  setCustom(g); customMats = mats;
}
filePick.addEventListener("change", async () => {
  const f = filePick.files[0]; filePick.value = ""; if (!f) return;
  try { const buf = await f.arrayBuffer(); await loadCustom(buf); await idb("put", buf); bar.querySelector(".h3d-menu").hidden = true;
    window.toast?.(`3D model loaded: <b>${f.name.replace(/[<>&]/g, "")}</b>`); }
  catch (e) { window.toast ? toast("Couldn't load that 3D model: " + String(e.message || e).replace(/[<>&]/g, "")) : alert(e); }
});
idb("get").then(buf => buf && loadCustom(buf).catch(() => {}));

// ------------------------------------------------------------------ highlight (from the systems panel in hood.js)
let hl = null;
window.HOOD3D = {active: true, get debug() { return {camera, controls, view}; }, highlight(id) { hl = id || null; if (id) { const map = {air: "engine", fuel: "side", power: "cutaway", exh: "side", cool: "engine", elec: "engine"}; goView(map[id] || "car"); } }};

// ------------------------------------------------------------------ frame loop
const clock = new THREE.Clock(); let accent = "#3fa7ff", hoodAng = 0, built = "", lastTheme = 0, smoothSpeed = 0, prevSpeed = 0, brakeGlow = 0, sparkT = 0;
const lerp = (a, b, t) => a + (b - a) * t, clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function rebuildIfNeeded() {
  const two = isTwoWheeler(), n = Math.max(1, Math.min(8, +VEH().cylinders || (two ? 1 : 4))), key = n + "|" + two;
  const cr = bodyMode === "creta" || (bodyMode === "auto" && isCretaVeh());
  if (cr !== CRETA) { CRETA = cr; buildBody(); syncBar(); }
  spokes4.visible = cretaCab.visible = CRETA; spokes3.visible = !CRETA;
  if (key === built) return; built = key;
  buildEngine(n); buildIntake(); buildExhaust(); buildCooling(); buildElectrical(); buildFuel(); buildLabels();
  // two-wheelers: engine only (no car body), centred
  [bodyG, cabinG, bay, blob, ...wheels.map(w => w.g)].forEach(o => o.visible = !two);
  [sys.cool, sys.fuel, sys.exh].forEach(g => g.visible = !two);
  eng.visible = true;
  if (two) { controls.target.set(1.5, 0.75, 0); camera.position.set(2.5, 1.4, 1.5); }
}
function themeSync() {
  const cs = getComputedStyle(document.documentElement), bg = cs.getPropertyValue("--panel2").trim() || "#18212d", ac = cs.getPropertyValue("--accent").trim() || "#3fa7ff";
  scene.background = new THREE.Color(bg); scene.fog = new THREE.Fog(bg, 10, 26);
  edgeMat.color.set(ac); M.ambient.color.set(ac); M.ambient.emissive.set(ac); airFlow.p.material.color.set(ac); accent = ac;
  const light = new THREE.Color(bg).getHSL({}).l > 0.6;
  M.ground.color.set(light ? 0xd5dbe2 : 0x15181d); M.road.color.set(light ? 0xb9c0c8 : 0x1b1f25);
}
function resize() {
  const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return;
  renderer.setSize(w, h); labelRenderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  composer?.setSize(w, h); bloom?.setSize(w / 2, h / 2);
}
new ResizeObserver(resize).observe(host);

function frame() {
  requestAnimationFrame(frame);
  const visible = document.querySelector("#hood")?.classList.contains("on") && !document.hidden;
  if (!visible) { clock.getDelta(); return; }
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!built) { rebuildIfNeeded(); resize(); syncBar(); }
  rebuildIfNeeded();
  if (performance.now() - lastTheme > 1500) { lastTheme = performance.now(); themeSync(); syncBar(); }
  const conn = !!S?.connected, rpm = conn ? (L("0C") || 0) : 0, spd = conn ? (L("0D") || 0) : 0;
  const temp = L(tempPid()), cat = L("3C"), v = S?.voltage, maf = L("10"), load = L("04") || 0, fr = window.TRIPS?.fuelRate?.();
  // paint / X-ray
  const cut = view === "cutaway", two = isTwoWheeler(), inside = view === "cabin", see = cut || xray;
  const po = lerp(paint.opacity, cut ? 0.04 : xray && !inside ? 0.13 : 1, 0.12), pcol = paintOf();
  for (const m of [...PAINT_MATS, M.trim, M.clad, M.rail]) { if (PAINT_MATS.includes(m)) m.color.set(pcol); m.opacity = po; m.depthWrite = po > 0.9; m.transparent = po < 0.99; }
  M.glass.opacity = lerp(M.glass.opacity, xray && !inside ? 0.12 : inside ? 0.22 : 0.5, 0.12); edgeMat.opacity = lerp(edgeMat.opacity, xray && !inside ? 0.55 : 0, 0.12);
  // bonnet opens in the engine and cutaway views
  hoodAng = lerp(hoodAng, view === "engine" || cut ? 0.95 : 0, 0.06); hoodG.rotation.z = hoodAng;
  // opaque cast metal normally; translucent block with the internals showing in X-ray / cutaway
  if (engParts) { const bm = see ? M.alu : M.cast; engParts.block.material = engParts.head.material = bm; engParts.gearbox.material = engParts.bell.material = see ? M.alu : M.cast;
    engParts.dress.visible = !see; engParts.blockEdges.visible = see; }
  // cutaway: hide everything around the engine so the crank, rods and pistons are clear
  sys.cool.visible = sys.elec.visible = sys.air.visible = !cut; sys.fuel.visible = !cut && !two; sys.exh.visible = !two;
  glass.visible = !cut && !two; wheels.forEach(w => w.g.visible = !two && !cut); cabinG.visible = bay.visible = !cut && !two;
  camera.fov = lerp(camera.fov, inside ? 64 : 38, 0.12); camera.updateProjectionMatrix();
  if (custom) {   // your own model replaces the built-in body; it fades in the engine views and X-ray since its bonnet can't open
    bodyG.visible = false; wheels.forEach(w => w.g.visible = false); cabinG.visible = inside && !two; custom.visible = !two && !inside;
    const co = cut ? 0.05 : view === "engine" || xray ? 0.15 : 1;
    customMats.forEach(m => { m.opacity = co < 1 ? Math.min(m.userData.o0, co) : m.userData.o0; m.transparent = co < 1 || m.userData.t0; m.depthWrite = co >= 1; });
  } else bodyG.visible = !two;
  airFlow.p.visible = fuelFlow.p.visible = !cut; M.alu.opacity = lerp(M.alu.opacity, cut ? 0.18 : 0.34, 0.1);
  M.piston.emissiveIntensity = 0; cyls.forEach(c => { if (cut && c.pmat.emissiveIntensity === 0) { c.pmat.emissive.set(0x3a4a5a); c.pmat.emissiveIntensity = 0.25; } });
  // engine mechanics (slow motion 1/10 so the motion is readable)
  crankAngle += (rpm / 60) * Math.PI * 2 * 0.1 * dt;
  if (crank) crank.rotation.z = -crankAngle;
  const health = window.HOOD?.cylHealth?.();
  let fired = -1;
  cyls.forEach((c, i) => {
    const phi = crankAngle - c.fireAt, sx = -K.r * Math.sin(phi), sy = K.r * Math.cos(phi);       // crank pin (rotates with the crank)
    const wy = sy + Math.sqrt(K.l * K.l - sx * sx);                                                // wrist pin height
    c.piston.position.set(0, -0.02 + wy + 0.02, c.z);
    c.rod.position.set(sx / 2, -0.02 + (sy + wy) / 2, c.z); c.rod.rotation.z = Math.atan2(sx, wy - sy);
    const cyc = ((phi % (4 * Math.PI)) + 4 * Math.PI) % (4 * Math.PI);
    const on = rpm > 300 && cyc < 0.45;
    c.spark.material.opacity = on ? 1 - cyc / 0.45 : 0; c.spark.scale.setScalar(on ? 1 + (0.45 - cyc) * 2 : 0.5);
    if (on) fired = i;
    const lvl = health?.cyl?.[i]?.lvl || "ok";
    c.pmat.emissive.set(lvl === "bad" ? 0xff2020 : lvl === "warn" ? 0xffa000 : 0x000000); c.pmat.emissiveIntensity = lvl === "ok" ? 0 : 0.6 + Math.sin(performance.now() / 200) * 0.3;
  });
  if (sparkLight) { if (fired >= 0) { sparkLight.position.set(0, 0.24, cyls[fired].z); sparkLight.intensity = 3; } else sparkLight.intensity *= 0.8; }
  pulleys.forEach(({p, ratio}) => p.rotation.y = crankAngle * ratio);
  if (M.belt.map) M.belt.map.offset.x = -crankAngle * 0.05;
  // wheels + road speed (real time), brake-light glow when slowing hard
  smoothSpeed = lerp(smoothSpeed, spd, 0.08);
  const ms = smoothSpeed / 3.6;
  wheels.forEach((w, i) => w.spin.rotation.z -= (i % 2 ? -1 : 1) * ms / WY * dt);
  shafts.forEach(sh => sh.rotation.y += ms / WY * dt);
  laneOffset += ms * dt; placeLanes();
  const decel = (prevSpeed - spd) / Math.max(dt, 0.016); prevSpeed = spd;
  brakeGlow = lerp(brakeGlow, decel > 25 ? 1 : 0, 0.1);
  M.tail.emissiveIntensity = 0.8 + brakeGlow * 3; M.caliper.emissiveIntensity = brakeGlow * 0.8;
  M.head.emissiveIntensity = conn ? 1.1 : 0.25; M.drl.emissiveIntensity = conn ? 2.2 : 0.6;
  // cabin: pedals follow the accelerator / braking, screens show live data (4x a second)
  const ped = L("49") != null ? clamp((L("49") - 14) / 66, 0, 1) : clamp(((L("11") ?? 0) - 10) / 80, 0, 1);
  accPedal.rotation.z = lerp(accPedal.rotation.z, (conn ? ped : 0) * 0.35, 0.3); brkPedal.rotation.z = lerp(brkPedal.rotation.z, brakeGlow * 0.3, 0.3);
  if (cabinG.visible && performance.now() - scrT > 250) { scrT = performance.now();
    const st = window.COACH?.state, gear = st && st.gear >= 0 && typeof gearName === "function" ? gearName(st.gear) : (conn && spd < 1 ? "N" : "");
    drawScreens({rpm, spd, temp, v, fuel: L("2F"), gear}, accent); }
  // cooling: fan speed + hose tint by coolant temperature
  if (fan) fan.rotation.x += dt * (rpm > 300 ? (temp != null && temp > 98 ? 30 : 8) : 0);
  coolFluid.scale.y = lerp(coolFluid.scale.y, 0.55 + clamp(((temp ?? 20) - 20) / 90, 0, 1) * 0.35, 0.05);
  if (temp != null) { const t = clamp((temp - 40) / 75, 0, 1); M.hose.emissive.setHSL(0.62 - t * 0.62, 1, 0.5); M.hose.emissiveIntensity = 0.05 + t * 0.18; }
  // exhaust heat glow from catalyst temperature (or engine load as a fallback)
  const heat = cat != null ? clamp((cat - 250) / 600, 0, 1) : clamp(load / 100, 0, 0.6) * (rpm > 300 ? 1 : 0);
  M.exhaust.emissiveIntensity = lerp(M.exhaust.emissiveIntensity, heat * 1.6, 0.05);
  // battery charge bar
  if (chargeBar && v != null) { const soc = rpm > 300 ? 1 : clamp(OBD.socFromV(v) / 100, 0.05, 1); chargeBar.scale.x = soc; chargeBar.position.x = 1.62 - 0.1 * (1 - soc);
    const col = v >= 13.2 || soc > 0.7 ? 0x10ff70 : soc > 0.4 ? 0xffb020 : 0xff3030; M.charge.color.set(col); M.charge.emissive.set(col); }
  // particles
  const airSpeed = rpm > 300 ? clamp((maf ?? rpm / 300) / 25, 0.08, 1.6) : 0;
  flowStep(airFlow, airPath, airSpeed, dt, car);
  flowStep(fuelFlow, fuelPath, rpm > 300 ? clamp((fr?.lph ?? 1) / 6, 0.05, 1.2) : 0, dt, car);
  if (exPath && !isTwoWheeler()) {
    const tip = exPath.getPointAt(1), tw = car.localToWorld(tip.clone()), rate = rpm > 300 ? 2 + load / 15 : 0;
    exhMat.color.setHSL(0.08, heat * 0.9, 0.75 - heat * 0.2);
    for (let i = 0, spawn = rate; i < exhN; i++) {
      exhAge[i] += dt;
      if (exhAge[i] > 1.6 && spawn-- > 0 && Math.random() < 0.6) { exhAge[i] = 0; exhPos.set([tw.x, tw.y, tw.z], i * 3); exhVel.set([-0.6 - ms * 0.7 - Math.random() * 0.4, 0.15 + Math.random() * 0.25, (Math.random() - 0.5) * 0.3], i * 3); }
      if (exhAge[i] <= 1.6) { exhPos[i * 3] += exhVel[i * 3] * dt; exhPos[i * 3 + 1] += exhVel[i * 3 + 1] * dt; exhPos[i * 3 + 2] += exhVel[i * 3 + 2] * dt; }
      else exhPos[i * 3 + 1] = -50;
    }
    exhGeo.attributes.position.needsUpdate = true;
  }
  // highlight pulse for the selected system
  const pulse = 0.5 + Math.sin(performance.now() / 180) * 0.5;
  for (const [id, g] of Object.entries(sys)) g.traverse(o => { if (!o.isMesh || !o.material.emissive || o.material === M.spark) return;
    o.userData.e0 ??= o.material.emissiveIntensity;
    if (hl === id) { o.material.emissiveIntensity = Math.max(o.userData.e0, 0.35 + pulse * 0.5); if (!o.userData.hlc) { o.userData.hlc = o.material.emissive.getHex(); if (!o.userData.hlc) o.material.emissive.set(0x3fa7ff); } }
    else if (o.userData.hlc !== undefined) { o.material.emissive.setHex(o.userData.hlc); o.material.emissiveIntensity = o.userData.e0; delete o.userData.hlc; } });
  // labels
  if (showLbl) {
    const f1 = x => x == null ? "–" : (+x).toFixed(1), f0 = x => x == null ? "–" : Math.round(x);
    setLbl("rpm", `⚙ <b>${f0(rpm)}</b> rpm · load ${f0(load)}%`, rpm >= VEH().redline ? "bad" : "");
    setLbl("cool", `🌡 <b>${f0(temp)}</b> °C`, temp > 110 ? "bad" : temp > 104 ? "warn" : "");
    setLbl("bat", `🔋 <b>${v != null ? v.toFixed(2) : "–"}</b> V`, v != null && v < 12 ? "bad" : "");
    setLbl("speed", `<b>${f0(spd)}</b> km/h`);
    setLbl("cat", `🔥 cat <b>${f0(cat)}</b> °C`, cat > 850 ? "bad" : "");
    setLbl("air", `🌬 <b>${f1(maf)}</b> g/s · ${f0(L("0F"))} °C`);
    setLbl("fuel", `⛽ <b>${fr ? fr.lph.toFixed(2) : "–"}</b> L/h`);
    setLbl("thr", `throttle <b>${f0(L("11"))}</b>%`);
    LBL.fuel.o.visible = LBL.cat.o.visible = LBL.speed.o.visible = !isTwoWheeler();
  }
  // camera tween
  if (camTween) { camTween.t = Math.min(1, (performance.now() - camTween.s) / 900); /* wall-clock: slow devices still finish on time */ const e = 1 - Math.pow(1 - camTween.t, 3);
    camera.position.lerpVectors(camTween.p0, camTween.p1, e); controls.target.lerpVectors(camTween.t0, camTween.t1, e); if (camTween.t >= 1) camTween = null; }
  controls.update(dt);
  if (composer) composer.render(); else renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}
setupComposer();
// the 3D view replaces the simple CSS engine
document.querySelector("#e3wrap").style.display = "none";
requestAnimationFrame(frame);
console.info("3D engine view ready (Three.js r" + THREE.REVISION + ")");
