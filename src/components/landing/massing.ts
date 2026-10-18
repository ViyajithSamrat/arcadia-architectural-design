import * as THREE from "three";
import { footprint, SETBACK, type PlotSpec } from "@/lib/landing/preview";

/**
 * A procedural architectural "white model" built from a PlotSpec.
 * Layers appear in order (plot → plan → mass → detail → light) so the
 * hero can grow the house as the visitor scrolls through the journey.
 */

const S = 0.1; // scene units per foot
const FLOOR_H = 1.0;

const C = {
  plot: 0xd8d0bf,
  plotEdge: 0x1e1f1c,
  slab: 0xf6f3ed,
  plaster: 0xf7f4ee,
  band: 0xd3ccbe,
  glass: 0x2a2e2c,
  glow: 0xffb35c,
  wood: 0x6b4a33,
  roof: 0x8f5a47,
  leaf: 0x2f5d46,
  leaf2: 0x46765a,
  trunk: 0x5b4636,
  stone: 0xd9d2c4,
  lawn: 0xa7b08a,
  earth: 0xc9b996,
  fabric: 0x24513b,
  dark: 0x2b2c29,
} as const;

type LayerName = "plot" | "plan" | "mass" | "detail";
const LAYERS: LayerName[] = ["plot", "plan", "mass", "detail"];

export interface MassingOptions {
  /** Keep the camera still (prefers-reduced-motion). */
  still?: boolean;
  /** Called once when WebGL cannot start. */
  onFail?: () => void;
}

function mat(color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0, ...extra });
}

function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Hip roof over a w × d rectangle, ridge along the longer side. */
function hipRoof(w: number, d: number, h: number, m: THREE.Material) {
  const long = Math.max(w, d);
  const short = Math.min(w, d);
  const r = (long - short) / 2;
  const hw = long / 2;
  const hd = short / 2;
  const v = [
    [-hw, 0, -hd], [hw, 0, -hd], [hw, 0, hd], [-hw, 0, hd], // eaves
    [-r, h, 0], [r, h, 0], // ridge
  ];
  const tris = [
    [0, 4, 5], [0, 5, 1], // back slope
    [3, 2, 5], [3, 5, 4], // front slope
    [0, 3, 4], // left hip
    [1, 5, 2], // right hip
  ];
  const pos: number[] = [];
  for (const t of tris) for (const i of t) pos.push(...v[i]);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, m);
  mesh.material = m;
  (mesh.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  if (d > w) mesh.rotation.y = Math.PI / 2;
  mesh.castShadow = true;
  return mesh;
}

function tree(x: number, z: number, scale: number, leaf: THREE.Material, trunk: THREE.Material) {
  const g = new THREE.Group();
  const t = new THREE.Mesh(new THREE.CylinderGeometry(0.04 * scale, 0.06 * scale, 0.7 * scale, 6), trunk);
  t.position.y = 0.35 * scale;
  t.castShadow = true;
  const c = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42 * scale, 1), leaf);
  c.position.y = 0.95 * scale;
  c.scale.set(1, 0.85, 1);
  c.castShadow = true;
  const c2 = new THREE.Mesh(new THREE.IcosahedronGeometry(0.28 * scale, 1), leaf);
  c2.position.set(0.22 * scale, 1.2 * scale, 0.05 * scale);
  c2.castShadow = true;
  g.add(t, c, c2);
  g.position.set(x, 0, z);
  return g;
}

function rectLine(w: number, d: number, y: number, color: number) {
  const hw = w / 2;
  const hd = d / 2;
  const pts = [
    -hw, y, -hd, hw, y, -hd, hw, y, -hd, hw, y, hd, hw, y, hd, -hw, y, hd, -hw, y, hd, -hw, y, -hd,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color }));
}

/** Deterministic pseudo-random so every visit draws the same model for the same spec. */
function seeded(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export class MassingModel {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
  private root = new THREE.Group();
  private layers: Record<LayerName, THREE.Group> = {
    plot: new THREE.Group(), plan: new THREE.Group(), mass: new THREE.Group(), detail: new THREE.Group(),
  };
  private progress: Record<LayerName, number> = { plot: 0, plan: 0, mass: 0, detail: 0 };
  private lightP = 0;
  private stage = 4;
  private glassMats: THREE.MeshStandardMaterial[] = [];
  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  private frame = 0;
  private running = false;
  private last = 0;
  private time = 0;
  private pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  private fit = { radius: 8, targetY: 0.6 };
  private fitSmooth = { radius: 8, targetY: 0.6 };
  private specKey = "";
  private built = false;
  private shift = 0;
  private size = { w: 1, h: 1 };
  private materials: THREE.Material[] = [];
  private still: boolean;

  constructor(private canvas: HTMLCanvasElement, opts: MassingOptions = {}) {
    this.still = !!opts.still;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.hemi = new THREE.HemisphereLight(0xfffaf0, 0xcfc8b9, 1.9);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.4);
    this.sun.position.set(-6, 10, 7);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -10;
    this.sun.shadow.camera.right = 10;
    this.sun.shadow.camera.top = 10;
    this.sun.shadow.camera.bottom = -10;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.radius = 4;
    this.scene.add(this.hemi, this.sun);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.ShadowMaterial({ opacity: 0.16 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.081;
    ground.receiveShadow = true;
    this.scene.add(ground);

    for (const l of LAYERS) this.root.add(this.layers[l]);
    this.scene.add(this.root);
  }

  setStage(stage: number) {
    this.stage = stage;
    if (this.still) this.snap();
    this.kick();
  }

  setSpec(spec: PlotSpec) {
    const shapeKey = `${spec.type}|${spec.floors}|${spec.style}|${spec.garden}|${spec.rooms}`;
    const regrow = this.specKey !== "" && !this.specKey.startsWith(shapeKey);
    this.specKey = `${shapeKey}|${spec.widthFt}|${spec.depthFt}`;
    this.build(spec);
    if (regrow && !this.still) {
      this.progress.mass = Math.min(this.progress.mass, 0.35);
      this.progress.detail = 0;
    }
    if (this.still) this.snap();
    this.kick();
  }

  setPointer(x: number, y: number) {
    this.pointer.tx = x;
    this.pointer.ty = y;
    this.kick();
  }

  /** Shift the picture sideways (fraction of width) to leave room for text beside it. */
  setShift(shift: number) {
    this.shift = shift;
    this.applyView();
    this.kick();
  }

  resize(w: number, h: number) {
    if (w === 0 || h === 0) return;
    this.size = { w, h };
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.applyView();
    this.kick();
  }

  private applyView() {
    const { w, h } = this.size;
    if (this.shift) this.camera.setViewOffset(w, h, -this.shift * w, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.frame);
  }

  dispose() {
    this.stop();
    this.clear();
    this.renderer.dispose();
  }

  private kick() {
    if (!this.running) this.render();
  }

  private snap() {
    LAYERS.forEach((l, i) => (this.progress[l] = this.stage >= i ? 1 : 0));
    this.lightP = this.stage >= 4 ? 1 : 0;
    this.fitSmooth = { ...this.fit };
  }

  private tick = (now: number) => {
    if (!this.running) return;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    this.update(dt);
    this.render();
    this.frame = requestAnimationFrame(this.tick);
  };

  private update(dt: number) {
    const k = 1 - Math.exp(-dt * 4.5);
    LAYERS.forEach((l, i) => {
      const target = this.stage >= i ? 1 : 0;
      this.progress[l] += (target - this.progress[l]) * k;
    });
    this.lightP += ((this.stage >= 4 ? 1 : 0) - this.lightP) * (1 - Math.exp(-dt * 2.5));
    this.pointer.x += (this.pointer.tx - this.pointer.x) * k;
    this.pointer.y += (this.pointer.ty - this.pointer.y) * k;
    this.fitSmooth.radius += (this.fit.radius - this.fitSmooth.radius) * k;
    this.fitSmooth.targetY += (this.fit.targetY - this.fitSmooth.targetY) * k;
  }

  private ease(p: number) {
    const x = Math.min(1, Math.max(0, p));
    return x * x * (3 - 2 * x);
  }

  private render() {
    const p = this.progress;
    this.layers.plot.visible = p.plot > 0.01;
    this.layers.plot.scale.setScalar(0.92 + 0.08 * this.ease(p.plot));

    this.layers.plan.visible = p.plan > 0.01;
    this.layers.plan.scale.set(1, Math.max(0.001, this.ease(p.plan)), 1);

    this.layers.mass.visible = p.mass > 0.01;
    this.layers.mass.children.forEach((c, i, all) => {
      const local = this.ease(p.mass * all.length - i * 0.6);
      c.scale.y = Math.max(0.001, local);
      c.visible = local > 0.01;
    });

    this.layers.detail.visible = p.detail > 0.01;
    this.layers.detail.children.forEach((c) => {
      const s = this.ease(p.detail);
      c.scale.setScalar(Math.max(0.001, 0.6 + 0.4 * s));
      c.visible = s > 0.02;
    });

    // Daylight → warm evening with lit windows when the concept is "released".
    const l = this.lightP;
    this.hemi.intensity = 1.9 - 0.6 * l;
    this.hemi.color.setRGB(1, 0.98 - 0.06 * l, 0.94 - 0.16 * l);
    this.sun.intensity = 2.4 - 0.8 * l;
    this.sun.color.setRGB(1, 1 - 0.18 * l, 1 - 0.4 * l);
    this.sun.position.set(-6 + 3 * l, 10 - 4.5 * l, 7);
    for (const g of this.glassMats) g.emissiveIntensity = 1.6 * l;

    // Camera: slow sway plus a little pointer parallax.
    const sway = this.still ? 0 : Math.sin(this.time * 0.18) * 0.28;
    const az = 0.72 + sway + this.pointer.x * 0.22;
    const el = 0.56 + this.pointer.y * 0.06;
    // Fit the model's bounding sphere inside the narrower field of view.
    const vfov = (this.camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect * (1 - Math.abs(this.shift)));
    const r = (this.fitSmooth.radius / Math.sin(Math.min(vfov, hfov) / 2)) * 0.84;
    this.camera.position.set(Math.sin(az) * Math.cos(el) * r, Math.sin(el) * r + this.fitSmooth.targetY, Math.cos(az) * Math.cos(el) * r);
    this.camera.lookAt(0, this.fitSmooth.targetY, 0);
    this.renderer.render(this.scene, this.camera);
  }

  private clear() {
    for (const l of LAYERS) {
      const g = this.layers[l];
      g.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) o.geometry.dispose();
      });
      g.clear();
    }
    for (const m of this.materials) m.dispose();
    this.materials = [];
    this.glassMats = [];
  }

  private m(color: number, extra?: Partial<THREE.MeshStandardMaterialParameters>) {
    const mm = mat(color, extra);
    this.materials.push(mm);
    return mm;
  }

  private build(spec: PlotSpec) {
    this.clear();
    if (spec.type === "new-build") this.buildHouse(spec);
    else if (spec.type === "interior") this.buildInterior(spec);
    else this.buildGarden(spec);

    const w = spec.widthFt * S;
    const d = spec.depthFt * S;
    const h = spec.type === "new-build" ? spec.floors * FLOOR_H + (spec.style === "sloped" ? 0.9 : 0.3) : 1.3;
    this.fit = { radius: 0.5 * Math.hypot(w, d, h) + 0.15, targetY: h * 0.36 };
    if (!this.built) {
      this.fitSmooth = { ...this.fit };
      this.built = true;
    }
  }

  private glass() {
    const g = this.m(C.glass, { emissive: C.glow, emissiveIntensity: 0, roughness: 0.25 });
    this.glassMats.push(g);
    return g;
  }

  private plotBase(w: number, d: number, color: number) {
    const base = box(w, 0.08, d, this.m(color), 0, -0.04, 0);
    base.castShadow = false;
    this.layers.plot.add(base, rectLine(w, d, 0.002, C.plotEdge));
    const stake = this.m(C.dark);
    for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const s = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.32, 6), stake);
      s.position.set((x * w) / 2, 0.16, (z * d) / 2);
      s.castShadow = true;
      this.layers.plot.add(s);
    }
  }

  private buildHouse(spec: PlotSpec) {
    const w = spec.widthFt * S;
    const d = spec.depthFt * S;
    const fp = footprint(spec);
    const fw = fp.w * S;
    const fd = fp.d * S;
    const cz = -d / 2 + SETBACK.rear * S + fd / 2;
    const frontZ = cz + fd / 2;

    this.plotBase(w, d, C.plot);
    if (spec.garden) {
      const lawnD = d / 2 - frontZ - 0.12;
      if (lawnD > 0.2) this.layers.plot.add(box(w - 0.24, 0.03, lawnD, this.m(C.lawn), 0, 0.015, frontZ + 0.06 + lawnD / 2));
    }

    // Plan: floor slab with the ground-floor walls drawn low.
    const slab = this.m(C.slab);
    const wall = this.m(C.plaster);
    this.layers.plan.add(box(fw, 0.05, fd, slab, 0, 0.025, cz));
    const wt = 0.05;
    const wh = 0.32;
    const split = cz + fd * 0.08;
    this.layers.plan.add(box(fw, wh, wt, wall, 0, wh / 2, split));
    const cols = Math.max(1, Math.ceil(spec.rooms / spec.floors));
    for (let i = 1; i < cols; i++) {
      const x = -fw / 2 + (fw / cols) * i;
      this.layers.plan.add(box(wt, wh, (fd / 2) * 0.92, wall, x, wh / 2, cz - fd / 4 + fd * 0.04));
    }
    this.layers.plan.add(box(wt, wh, fd * 0.42, wall, fw * 0.12, wh / 2, cz + fd * 0.29));

    // Mass: one block per floor (pivot at its base so it can grow upward).
    const plaster = this.m(C.plaster);
    const band = this.m(C.band);
    const courtyard = spec.style === "courtyard";
    const flat = spec.style === "flat";
    for (let f = 0; f < spec.floors; f++) {
      const g = new THREE.Group();
      g.position.y = f * FLOOR_H;
      const terrace = flat && spec.floors > 1 && f === spec.floors - 1;
      const bd = terrace ? fd * 0.68 : fd;
      const bz = terrace ? cz - (fd - bd) / 2 : cz;
      if (courtyard) {
        const vw = fw * 0.38;
        const vd = fd * 0.34;
        const sideW = (fw - vw) / 2;
        const endD = (fd - vd) / 2;
        g.add(box(fw, FLOOR_H - 0.05, endD, plaster, 0, (FLOOR_H - 0.05) / 2, cz - fd / 2 + endD / 2));
        g.add(box(fw, FLOOR_H - 0.05, endD, plaster, 0, (FLOOR_H - 0.05) / 2, cz + fd / 2 - endD / 2));
        g.add(box(sideW, FLOOR_H - 0.05, vd, plaster, -fw / 2 + sideW / 2, (FLOOR_H - 0.05) / 2, cz));
        g.add(box(sideW, FLOOR_H - 0.05, vd, plaster, fw / 2 - sideW / 2, (FLOOR_H - 0.05) / 2, cz));
      } else {
        g.add(box(fw, FLOOR_H - 0.05, bd, plaster, 0, (FLOOR_H - 0.05) / 2, bz));
      }
      if (courtyard) {
        // Ring-shaped band so the court stays open to the sky.
        const endD = (fd - fd * 0.34) / 2;
        const sideW = (fw - fw * 0.38) / 2;
        const y = FLOOR_H - 0.025;
        g.add(box(fw + 0.06, 0.05, endD + 0.03, band, 0, y, cz - fd / 2 + endD / 2));
        g.add(box(fw + 0.06, 0.05, endD + 0.03, band, 0, y, cz + fd / 2 - endD / 2));
        g.add(box(sideW + 0.03, 0.05, fd * 0.34, band, -fw / 2 + sideW / 2, y, cz));
        g.add(box(sideW + 0.03, 0.05, fd * 0.34, band, fw / 2 - sideW / 2, y, cz));
      } else {
        g.add(box(fw + 0.06, 0.05, bd + 0.06, band, 0, FLOOR_H - 0.025, bz));
      }
      this.layers.mass.add(g);
    }

    // Detail: openings, door, roof, path and trees.
    const det = new THREE.Group();
    const glass = this.glass();
    const n = Math.max(1, Math.floor(fp.w / 9));
    for (let f = 0; f < spec.floors; f++) {
      const terrace = flat && spec.floors > 1 && f === spec.floors - 1;
      const z = terrace ? cz - fd / 2 + fd * 0.68 : frontZ;
      for (let i = 0; i < n; i++) {
        const x = -fw / 2 + (fw / n) * (i + 0.5);
        if (f === 0 && i === 0 && n > 1) continue;
        det.add(box(Math.min(0.55, (fw / n) * 0.55), 0.5, 0.03, glass, x, f * FLOOR_H + 0.48, z + 0.016));
      }
      const sides = Math.max(1, Math.floor(fp.d / 12));
      for (let i = 0; i < sides; i++) {
        const z2 = cz - fd / 2 + (fd / sides) * (i + 0.5);
        if (terrace && z2 > cz - fd / 2 + fd * 0.68) continue;
        det.add(box(0.03, 0.46, 0.42, glass, fw / 2 + 0.016, f * FLOOR_H + 0.5, z2));
      }
    }
    const doorX = n > 1 ? -fw / 2 + fw / n / 2 : -fw / 4;
    det.add(box(0.3, 0.72, 0.03, this.m(C.wood), doorX, 0.36, frontZ + 0.016));
    const pathLen = d / 2 - frontZ;
    if (pathLen > 0.1) det.add(box(0.36, 0.02, pathLen, this.m(C.stone), doorX, 0.03, frontZ + pathLen / 2));

    const topY = spec.floors * FLOOR_H;
    if (spec.style === "sloped") {
      const roof = hipRoof(fw + 0.3, fd + 0.3, Math.min(fw, fd) * 0.3 + 0.2, this.m(C.roof, { side: THREE.DoubleSide }));
      roof.position.set(0, topY, cz);
      det.add(roof);
    } else {
      const parapet = this.m(C.plaster);
      const pd = flat && spec.floors > 1 ? fd * 0.68 : fd;
      const pz = flat && spec.floors > 1 ? cz - (fd - pd) / 2 : cz;
      const ph = 0.22;
      det.add(box(fw, ph, 0.05, parapet, 0, topY + ph / 2, pz - pd / 2));
      det.add(box(fw, ph, 0.05, parapet, 0, topY + ph / 2, pz + pd / 2));
      det.add(box(0.05, ph, pd, parapet, -fw / 2, topY + ph / 2, pz));
      det.add(box(0.05, ph, pd, parapet, fw / 2, topY + ph / 2, pz));
      if (flat && spec.floors > 1) {
        const ty = (spec.floors - 1) * FLOOR_H;
        const tz0 = pz + pd / 2;
        const tdep = fd - pd;
        const wood = this.m(C.wood);
        for (let i = 0; i < 6; i++) {
          det.add(box(0.04, 0.04, tdep, wood, -fw / 2 + 0.2 + ((fw - 0.4) / 5) * i, ty + 0.78, tz0 + tdep / 2));
        }
        det.add(box(fw - 0.3, 0.05, 0.05, wood, 0, ty + 0.74, tz0 + tdep - 0.1));
        for (const x of [-fw / 2 + 0.2, fw / 2 - 0.2]) det.add(box(0.05, 0.74, 0.05, wood, x, ty + 0.37, tz0 + tdep - 0.1));
        det.add(box(fw, 0.18, 0.04, parapet, 0, ty + 0.09, tz0 + tdep));
      }
    }

    const leaf = this.m(C.leaf, { flatShading: true });
    const leaf2 = this.m(C.leaf2, { flatShading: true });
    const trunk = this.m(C.trunk);
    if (courtyard) det.add(tree(0, cz, 0.9, leaf2, trunk));
    det.add(tree(-w / 2 + 0.35, -d / 2 + 0.35, 1, leaf, trunk));
    if (spec.garden) {
      det.add(tree(w / 2 - 0.45, d / 2 - 0.5, 1.15, leaf2, trunk));
      det.add(tree(-w / 2 + 0.5, d / 2 - 0.7, 0.85, leaf, trunk));
    }
    this.layers.detail.add(det);
  }

  private buildInterior(spec: PlotSpec) {
    const w = spec.widthFt * S;
    const d = spec.depthFt * S;
    const finish = spec.style === "wood" ? 0xb88a5e : spec.style === "terrazzo" ? 0xd8d0c2 : 0xe7e1d6;
    this.plotBase(w, d, finish);

    const wall = this.m(C.plaster);
    const wt = 0.06;
    const cols = Math.min(3, spec.rooms);
    const rows = Math.ceil(spec.rooms / cols);
    for (let i = 1; i < cols; i++) this.layers.plan.add(box(wt, 0.32, d, wall, -w / 2 + (w / cols) * i, 0.16, 0));
    for (let j = 1; j < rows; j++) this.layers.plan.add(box(w, 0.32, wt, wall, 0, 0.16, -d / 2 + (d / rows) * j));

    // Cut-away: full-height walls on the back and left only, so the rooms stay visible.
    const g = new THREE.Group();
    g.add(box(w, 1, wt, wall, 0, 0.5, -d / 2));
    g.add(box(wt, 1, d, wall, -w / 2, 0.5, 0));
    for (let i = 1; i < cols; i++) g.add(box(wt, 0.9, d * 0.4, wall, -w / 2 + (w / cols) * i, 0.45, -d / 2 + d * 0.2));
    this.layers.mass.add(g);

    const det = new THREE.Group();
    const glass = this.glass();
    det.add(box(w * 0.3, 0.55, 0.03, glass, -w * 0.15, 0.55, -d / 2 + 0.035));
    det.add(box(0.03, 0.55, d * 0.25, glass, -w / 2 + 0.035, 0.55, d * 0.1));
    const fabric = this.m(C.fabric);
    const linen = this.m(0xf1ece2);
    const dark = this.m(C.dark);
    const accentWood = this.m(spec.style === "terrazzo" ? 0xb08d57 : C.wood);
    const cw = w / cols;
    const rd = d / rows;
    for (let r = 0; r < spec.rooms; r++) {
      const cx = -w / 2 + cw * (r % cols) + cw / 2;
      const cz = -d / 2 + rd * Math.floor(r / cols) + rd / 2;
      if (r === 0) {
        det.add(box(cw * 0.55, 0.22, 0.32, fabric, cx, 0.11, cz - rd * 0.25));
        det.add(box(cw * 0.32, 0.12, rd * 0.18, accentWood, cx, 0.06, cz + rd * 0.05));
      } else if (r === 1 && spec.rooms > 2) {
        const table = new THREE.Mesh(new THREE.CylinderGeometry(Math.min(cw, rd) * 0.18, Math.min(cw, rd) * 0.18, 0.04, 24), accentWood);
        table.position.set(cx, 0.3, cz);
        table.castShadow = true;
        det.add(table, box(0.04, 0.28, 0.04, dark, cx, 0.14, cz));
      } else {
        det.add(box(cw * 0.5, 0.16, rd * 0.42, linen, cx, 0.08, cz - rd * 0.1));
        det.add(box(cw * 0.5, 0.05, rd * 0.12, fabric, cx, 0.18, cz - rd * 0.28));
      }
    }
    if (spec.garden) {
      const leaf = this.m(C.leaf, { flatShading: true });
      const pot = this.m(0xb9a58b);
      for (const [x, z] of [[w / 2 - 0.25, -d / 2 + 0.3], [-w / 2 + 0.3, d / 2 - 0.3], [w / 2 - 0.25, d / 2 - 0.3]]) {
        const p = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.08, 0.16, 10), pot);
        p.position.set(x, 0.08, z);
        const l = new THREE.Mesh(new THREE.IcosahedronGeometry(0.2, 1), leaf);
        l.position.set(x, 0.32, z);
        p.castShadow = l.castShadow = true;
        det.add(p, l);
      }
    }
    this.layers.detail.add(det);
  }

  private buildGarden(spec: PlotSpec) {
    const w = spec.widthFt * S;
    const d = spec.depthFt * S;
    const ground = spec.style === "native" ? C.earth : spec.style === "shade" ? C.stone : C.lawn;
    this.plotBase(w, d, ground);

    const rand = seeded(spec.widthFt * 131 + spec.depthFt * 17 + spec.rooms);
    const stone = this.m(C.stone);
    const steps = Math.max(5, Math.round(d / 0.45));
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      this.layers.plan.add(box(0.34, 0.06, 0.24, stone, Math.sin(t * Math.PI * 1.2) * w * 0.12, 0.03, d / 2 - t * d));
    }
    const lawn = this.m(spec.style === "native" ? 0x9aa476 : C.lawn);
    if (spec.style === "kitchen") {
      const bed = this.m(0x7a5a40);
      const green = this.m(0x5f8a4f, { flatShading: true });
      const beds = Math.max(2, Math.floor(w / 1.2));
      for (let i = 0; i < beds; i++) {
        const x = -w / 2 + (w / beds) * (i + 0.5);
        if (Math.abs(x) < 0.4) continue;
        this.layers.plan.add(box((w / beds) * 0.6, 0.18, d * 0.35, bed, x, 0.09, -d * 0.15));
        this.layers.plan.add(box((w / beds) * 0.5, 0.06, d * 0.3, green, x, 0.21, -d * 0.15));
      }
    } else {
      this.layers.plan.add(box(w * 0.32, 0.03, d * 0.42, lawn, -w * 0.26, 0.015, -d * 0.12));
      this.layers.plan.add(box(w * 0.26, 0.03, d * 0.3, lawn, w * 0.28, 0.015, d * 0.18));
    }

    // Mass: a low boundary wall on three sides, and the house edge as a ghost.
    const g = new THREE.Group();
    const wall = this.m(C.plaster);
    g.add(box(w, 0.36, 0.06, wall, 0, 0.18, -d / 2));
    g.add(box(0.06, 0.36, d, wall, -w / 2, 0.18, 0));
    g.add(box(0.06, 0.36, d, wall, w / 2, 0.18, 0));
    g.add(box(w * 0.7, 0.9, 0.5, this.m(C.plaster, { transparent: true, opacity: 0.5 }), 0, 0.45, -d / 2 - 0.3));
    this.layers.mass.add(g);

    const det = new THREE.Group();
    const leaf = this.m(C.leaf, { flatShading: true });
    const leaf2 = this.m(C.leaf2, { flatShading: true });
    const trunk = this.m(C.trunk);
    const big = spec.style === "shade" ? 1.35 : 1;
    for (let i = 0; i < spec.rooms; i++) {
      const a = i * 2.39996;
      const rr = 0.35 + 0.6 * Math.sqrt((i + 0.5) / Math.max(1, spec.rooms));
      det.add(tree(Math.cos(a) * rr * w * 0.45, Math.sin(a) * rr * d * 0.42, big * (0.8 + rand() * 0.4), i % 2 ? leaf : leaf2, trunk));
    }
    const clumps = Math.round((w * d) / 3);
    for (let i = 0; i < clumps; i++) {
      const c = new THREE.Mesh(new THREE.IcosahedronGeometry(0.08 + rand() * 0.08, 0), rand() > 0.5 ? leaf : leaf2);
      const x = (rand() - 0.5) * (w - 0.3);
      const z = (rand() - 0.5) * (d - 0.3);
      if (Math.abs(x - Math.sin((0.5 - z / d) * Math.PI * 1.2) * w * 0.12) < 0.3) continue;
      c.position.set(x, 0.07, z);
      c.castShadow = true;
      det.add(c);
    }
    if (spec.garden) {
      const wood = this.m(C.wood);
      const sx = w * 0.28;
      const sz = -d * 0.28;
      det.add(box(0.7, 0.08, 0.22, wood, sx, 0.2, sz), box(0.05, 0.18, 0.18, wood, sx - 0.3, 0.09, sz), box(0.05, 0.18, 0.18, wood, sx + 0.3, 0.09, sz));
      const lamp = this.glass();
      det.add(box(0.06, 0.06, 0.06, lamp, sx + 0.5, 0.32, sz), box(0.02, 0.3, 0.02, this.m(C.dark), sx + 0.5, 0.15, sz));
    }
    this.layers.detail.add(det);
  }
}
