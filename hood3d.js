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
const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 80);
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
const paint = new THREE.MeshPhysicalMaterial({color: 0x1b2a4a, metalness: 0.55, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.25,
  transparent: true, opacity: 1});
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

// ------------------------------------------------------------------ car body (side profile extruded, SUV proportions)
const car = new THREE.Group(); scene.add(car);
const shape = new THREE.Shape();
shape.moveTo(-2.15, 0.36); shape.lineTo(-2.18, 0.78); shape.quadraticCurveTo(-2.16, 1.22, -1.96, 1.33); shape.lineTo(-1.72, 1.6);
shape.quadraticCurveTo(-1.62, 1.67, -1.42, 1.67); shape.lineTo(0.08, 1.67); shape.quadraticCurveTo(0.3, 1.65, 0.46, 1.5); shape.lineTo(0.96, 1.1);
shape.lineTo(1.9, 0.99); shape.quadraticCurveTo(2.18, 0.95, 2.18, 0.7); shape.lineTo(2.13, 0.38); shape.lineTo(1.78, 0.38);
shape.absarc(1.35, 0.38, 0.43, 0, Math.PI, false); shape.lineTo(-0.92, 0.38); shape.absarc(-1.35, 0.38, 0.43, 0, Math.PI, false); shape.lineTo(-2.15, 0.36);
const bodyGeo = new THREE.ExtrudeGeometry(shape, {depth: 1.62, bevelEnabled: true, bevelThickness: 0.09, bevelSize: 0.07, bevelSegments: 5, curveSegments: 24});
bodyGeo.translate(0, 0, -0.81);
const body = mesh(bodyGeo, paint); car.add(body);
const edges = new THREE.LineSegments(new THREE.EdgesGeometry(bodyGeo, 28), edgeMat); car.add(edges);
const win = new THREE.Shape();
win.moveTo(-1.66, 1.3); win.lineTo(-1.5, 1.58); win.lineTo(0.06, 1.6); win.lineTo(0.38, 1.46); win.lineTo(0.88, 1.12); win.lineTo(-1.66, 1.14);
const glassGeo = new THREE.ExtrudeGeometry(win, {depth: 1.8, bevelEnabled: false}); glassGeo.translate(0, 0, -0.9);
const glass = mesh(glassGeo, M.glass, 0, 0, 0, false); car.add(glass);
for (const z of [-0.62, 0.62]) {
  car.add(mesh(new RoundedBoxGeometry(0.08, 0.1, 0.34, 2, 0.03), M.head, 2.16, 0.86, z, false));          // headlights
  car.add(mesh(new RoundedBoxGeometry(0.06, 0.09, 0.32, 2, 0.03), M.tail, -2.19, 1.0, z, false));          // taillights
  car.add(mesh(new RoundedBoxGeometry(0.16, 0.1, 0.06, 2, 0.02), paint, 0.82, 1.18, z * 1.48));            // mirrors
  car.add(mesh(new THREE.BoxGeometry(1.6, 0.03, 0.04), M.dark, -0.7, 1.72, z * 0.9));                      // roof rails
}
car.add(mesh(new RoundedBoxGeometry(0.05, 0.22, 1.1, 2, 0.02), M.plastic, 2.17, 0.62, 0, false));          // grille
const grilleStrip = mesh(new THREE.BoxGeometry(0.02, 0.025, 1.5), new THREE.MeshStandardMaterial({color: 0x3fa7ff, emissive: 0x3fa7ff, emissiveIntensity: 1.4}), 2.2, 0.98, 0, false);
car.add(grilleStrip);                                                                                        // LED light bar

// wheels with spokes, discs and calipers
function makeWheel() {
  const g = new THREE.Group(), spin = new THREE.Group(); g.add(spin);
  const tire = mesh(new THREE.TorusGeometry(0.31, 0.11, 18, 48), M.rubber); spin.add(tire);
  const rim = mesh(new THREE.CylinderGeometry(0.235, 0.235, 0.16, 40), M.rim); rim.rotation.x = Math.PI / 2; spin.add(rim);
  for (let i = 0; i < 5; i++) { const s = mesh(new THREE.BoxGeometry(0.045, 0.21, 0.05), M.chrome); s.position.y = 0.1; const p = new THREE.Group(); p.add(s); p.rotation.z = i * Math.PI * 2 / 5; p.position.z = 0.09; spin.add(p); }
  const disc = mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.02, 32), M.steel); disc.rotation.x = Math.PI / 2; spin.add(disc);
  const cal = mesh(new RoundedBoxGeometry(0.1, 0.12, 0.07, 2, 0.02), M.caliper, 0.12, 0.08, 0); g.add(cal);
  return {g, spin};
}
const wheels = [];
for (const [x, z] of [[1.35, 0.8], [1.35, -0.8], [-1.35, 0.8], [-1.35, -0.8]]) {
  const w = makeWheel(); w.g.position.set(x, 0.41, z); if (z < 0) w.g.rotation.y = Math.PI; car.add(w.g); wheels.push(w);
}

// ------------------------------------------------------------------ engine (crank along z, transverse like most FWD cars)
const eng = new THREE.Group(); eng.position.set(1.5, 0.66, 0); car.add(eng);
const sys = {air: new THREE.Group(), fuel: new THREE.Group(), power: new THREE.Group(), exh: new THREE.Group(), cool: new THREE.Group(), elec: new THREE.Group()};
eng.add(sys.power); car.add(sys.air, sys.fuel, sys.exh, sys.cool, sys.elec);
const K = {pitch: 0.105, r: 0.034, l: 0.115, bore: 0.038, deck: 0.2};
let N = 4, cyls = [], crank = null, crankAngle = 0, pulleys = [], fan = null, sparkLight = null;
const FIRING = {1: [1], 2: [1, 2], 3: [1, 2, 3], 4: [1, 3, 4, 2], 5: [1, 2, 4, 5, 3], 6: [1, 5, 3, 6, 2, 4], 8: [1, 8, 4, 3, 6, 5, 7, 2]};
function buildEngine(n) {
  sys.power.clear(); N = n; cyls = [];
  const len = n * K.pitch + 0.08, z0 = -(n - 1) * K.pitch / 2;
  const block = mesh(new RoundedBoxGeometry(0.24, 0.3, len, 3, 0.02), M.alu, 0, 0.1, 0, false); sys.power.add(block);
  sys.power.add(new THREE.LineSegments(new THREE.EdgesGeometry(block.geometry, 30), new THREE.LineBasicMaterial({color: 0x9fb3c8, transparent: true, opacity: 0.5})).translateY(0.1));
  const head = mesh(new RoundedBoxGeometry(0.25, 0.08, len, 3, 0.02), M.dark, 0, 0.29, 0); sys.power.add(head);
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
  const gearbox = mesh(new RoundedBoxGeometry(0.22, 0.24, 0.2, 3, 0.03), M.alu.clone(), 0.02, 0.02, -len / 2 - 0.1); gearbox.material.opacity = 0.6; sys.power.add(gearbox);
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
  label("speed", "0D", car, 1.35, 0.95, 0.95); label("cat", "3C", sys.exh, 0.75, 0.45, 0.3); label("air", "10", sys.air, 2.0, 1.15, -0.5);
  label("fuel", "", sys.fuel, -0.95, 0.72, 0); label("thr", "11", sys.air, eng.position.x - 0.2, eng.position.y + 0.55, -0.4);
}
function setLbl(k, html, lvl = "") { const l = LBL[k]; if (!l) return; if (l.el._h !== html) { l.el.innerHTML = html; l.el._h = html; } l.el.className = "h3d-lbl" + (lvl ? " " + lvl : ""); }

// ------------------------------------------------------------------ toolbar: views, X-ray, labels, rotate, quality, paint
const PAINTS = [["#0b0c10", "Abyss Black"], ["#e9ecef", "Atlas White"], ["#b3121b", "Fiery Red"], ["#5b6168", "Titan Grey"], ["#0f4d3c", "Emerald"], ["#1b2a4a", "Starry Night"], ["#8a7d5b", "Ranger Khaki"]];
const VIEWS = {car: [[5.2, 2.6, 5.4], [0.2, 0.7, 0]], engine: [[2.6, 1.45, 1.45], [1.5, 0.78, 0]], cutaway: [[2.05, 1.22, 0.62], [1.5, 0.7, 0]], side: [[0.2, 1.3, 6.2], [0, 0.55, 0]]};
let xray = q("xray") !== "0", showLbl = q("labels") !== "0", view = "car", camTween = null;
const bar = Object.assign(document.createElement("div"), {className: "h3d-bar"});
bar.innerHTML = `<button data-v="car" class="on">🚗 Car</button><button data-v="engine">⚙ Engine</button><button data-v="cutaway">🔬 Cutaway</button><button data-v="side">💨 Exhaust</button>
  <button data-t="xray">X-ray</button><button data-t="labels">Labels</button><button data-t="rot">⟳ Rotate</button><button data-t="q">✨ ${quality === "high" ? "High" : "Balanced"}</button>
  <span class="h3d-paint">${PAINTS.map(([c, n]) => `<i data-paint="${c}" title="${n}" style="background:${c}"></i>`).join("")}</span>`;
host.appendChild(bar);
const note = Object.assign(document.createElement("div"), {className: "h3d-note", textContent: "drag to orbit · pinch / scroll to zoom · engine in slow motion (1/10)"});
host.appendChild(note);
function syncBar() {
  bar.querySelectorAll("[data-v]").forEach(b => b.classList.toggle("on", b.dataset.v === view));
  bar.querySelector('[data-t="xray"]').classList.toggle("on", xray);
  bar.querySelector('[data-t="labels"]').classList.toggle("on", showLbl);
  bar.querySelector('[data-t="rot"]').classList.toggle("on", controls.autoRotate);
  bar.querySelectorAll("[data-paint]").forEach(i => i.classList.toggle("on", i.dataset.paint === (VEH().paint || "#1b2a4a")));
  labelRenderer.domElement.style.display = showLbl ? "" : "none";
}
function goView(v) {
  view = v; const [p, t] = VIEWS[v];
  camTween = {t: 0, p0: camera.position.clone(), t0: controls.target.clone(), p1: new THREE.Vector3(...p), t1: new THREE.Vector3(...t)};
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
  if (b.dataset.paint) { VEH().paint = b.dataset.paint; saveVehicles(); }
  syncBar();
});
renderer.domElement.addEventListener("pointerdown", () => { camTween = null; });

// ------------------------------------------------------------------ highlight (from the systems panel in hood.js)
let hl = null;
window.HOOD3D = {active: true, highlight(id) { hl = id || null; if (id) { const map = {air: "engine", fuel: "side", power: "cutaway", exh: "side", cool: "engine", elec: "engine"}; goView(map[id] || "car"); } }};

// ------------------------------------------------------------------ frame loop
const clock = new THREE.Clock(); let built = "", lastTheme = 0, smoothSpeed = 0, prevSpeed = 0, brakeGlow = 0, sparkT = 0;
const lerp = (a, b, t) => a + (b - a) * t, clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function rebuildIfNeeded() {
  const two = isTwoWheeler(), n = Math.max(1, Math.min(8, +VEH().cylinders || (two ? 1 : 4))), key = n + "|" + two;
  if (key === built) return; built = key;
  buildEngine(n); buildIntake(); buildExhaust(); buildCooling(); buildElectrical(); buildFuel(); buildLabels();
  // two-wheelers: engine only (no car body), centred
  [body, edges, glass, blob, ...wheels.map(w => w.g)].forEach(o => o.visible = !two);
  car.children.filter(o => o.isMesh && o !== body && o !== glass).forEach(o => o.visible = !two);
  [sys.cool, sys.fuel, sys.exh].forEach(g => g.visible = !two);
  eng.visible = true;
  if (two) { controls.target.set(1.5, 0.75, 0); camera.position.set(2.5, 1.4, 1.5); }
}
function themeSync() {
  const cs = getComputedStyle(document.documentElement), bg = cs.getPropertyValue("--panel2").trim() || "#18212d", ac = cs.getPropertyValue("--accent").trim() || "#3fa7ff";
  scene.background = new THREE.Color(bg); scene.fog = new THREE.Fog(bg, 10, 26);
  edgeMat.color.set(ac); grilleStrip.material.color.set(ac); grilleStrip.material.emissive.set(ac); airFlow.p.material.color.set(ac);
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
  paint.color.set(VEH().paint || "#1b2a4a");
  paint.opacity = lerp(paint.opacity, view === "cutaway" || view === "engine" ? 0.04 : xray ? 0.13 : 1, 0.12); paint.depthWrite = paint.opacity > 0.9; paint.transparent = true;
  M.glass.opacity = lerp(M.glass.opacity, xray ? 0.12 : 0.55, 0.12); edgeMat.opacity = lerp(edgeMat.opacity, xray ? 0.55 : 0, 0.12);
  // cutaway: hide everything around the engine so the crank, rods and pistons are clear
  const cut = view === "cutaway", two = isTwoWheeler();
  sys.cool.visible = sys.elec.visible = sys.air.visible = !cut; sys.fuel.visible = !cut && !two; sys.exh.visible = !two;
  glass.visible = !cut && !two; wheels.forEach(w => w.g.visible = !two && !cut);
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
  wheels.forEach((w, i) => w.spin.rotation.z -= (i % 2 ? -1 : 1) * ms / 0.41 * dt);
  laneOffset += ms * dt; placeLanes();
  const decel = (prevSpeed - spd) / Math.max(dt, 0.016); prevSpeed = spd;
  brakeGlow = lerp(brakeGlow, decel > 25 ? 1 : 0, 0.1);
  M.tail.emissiveIntensity = 0.8 + brakeGlow * 3; M.caliper.emissiveIntensity = brakeGlow * 0.8;
  M.head.emissiveIntensity = conn ? 1.1 : 0.25;
  // cooling: fan speed + hose tint by coolant temperature
  if (fan) fan.rotation.x += dt * (rpm > 300 ? (temp != null && temp > 98 ? 30 : 8) : 0);
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
  if (camTween) { camTween.t = Math.min(1, camTween.t + dt / 0.9); const e = 1 - Math.pow(1 - camTween.t, 3);
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
