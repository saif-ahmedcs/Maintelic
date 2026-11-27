const TAU = Math.PI * 2;

export const GLOBE_RADIUS_RATIO = 0.64;
export const BASE_POINT_COUNT = 1000;
export const MIN_POINT_COUNT = 320;
export const MAX_POINT_COUNT = 1700;
export const BASELINE_SIZE_PX = 560;
export const SPIN_RATE = 0.0001;
export const GEAR_SPIN_RATE = 0.00004;
export const VIEW_PITCH = 0.42;
export const ORBIT_SEGMENTS = 120;
export const TRAIL_STEPS = 9;

export const GLOBE_COLORS = {
  teal: '28, 196, 184',
  white: '237, 255, 254',
  cyan: '203, 255, 252',
} as const;

export const GEAR = {
  teeth: 24,
  tipRadius: 1,
  rootRadius: 0.865,
  tipLand: 0.3,
  rootLand: 0.62,
  halfThickness: 0.05,
  boreRadius: 0.14,
  spokes: 6,
  spokeHalfWidth: 0.07,
  spokeStartAngle: Math.PI / 6,
  webInnerRadius: 0.36,
  webOuterRadius: 0.7,
} as const;

const GEAR_DEPTH_FLOOR = 0.6;

export interface GlobePoint {
  x: number;
  y: number;
  z: number;
  isWhite: boolean;
  phase: number;
  speed: number;
  weight: number;
}

export interface OrbitNode {
  offset: number;
  speed: number;
}

export interface Orbit {
  radius: number;
  tiltX: number;
  tiltZ: number;
  nodes: OrbitNode[];
}

export const ORBITS: readonly Orbit[] = [
  {
    radius: 1.2,
    tiltX: 1.18,
    tiltZ: 0.28,
    nodes: [
      { offset: 0.4, speed: 0.00042 },
      { offset: 3.5, speed: 0.00042 },
    ],
  },
  {
    radius: 1.34,
    tiltX: 0.72,
    tiltZ: -0.62,
    nodes: [{ offset: 2.2, speed: -0.00034 }],
  },
  {
    radius: 1.48,
    tiltX: 1.42,
    tiltZ: 0.95,
    nodes: [
      { offset: 5.1, speed: 0.00026 },
      { offset: 1.6, speed: 0.00026 },
    ],
  },
];

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface Vec2 {
  x: number;
  y: number;
}

export function pointCountForSize(sizePx: number): number {
  const scaled = Math.round(
    BASE_POINT_COUNT * (sizePx / BASELINE_SIZE_PX) ** 2,
  );
  return Math.min(MAX_POINT_COUNT, Math.max(MIN_POINT_COUNT, scaled));
}

function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function smoothstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

function polar(radius: number, angle: number): Vec2 {
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

export function gearProfileRadius(theta: number): number {
  const pitch = TAU / GEAR.teeth;
  const local = ((theta % pitch) + pitch) % pitch;
  const v = Math.min(local, pitch - local) / (pitch / 2);
  const s = smoothstep((v - GEAR.tipLand) / (GEAR.rootLand - GEAR.tipLand));
  return GEAR.tipRadius - (GEAR.tipRadius - GEAR.rootRadius) * s;
}

function polygonArea(poly: Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function polygonLength(poly: Vec2[]): number {
  let total = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

function resampleClosed(poly: Vec2[], count: number, phase: number): Vec2[] {
  const total = polygonLength(poly);
  const out: Vec2[] = [];
  let seg = 0;
  let segStart = 0;
  for (let k = 0; k < count; k++) {
    const target = ((k + phase) / count) * total;
    for (;;) {
      const a = poly[seg % poly.length];
      const b = poly[(seg + 1) % poly.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (segStart + len >= target || seg >= poly.length * 2) {
        const t = len > 0 ? (target - segStart) / len : 0;
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        break;
      }
      segStart += len;
      seg++;
    }
  }
  return out;
}

function outerOutline(): Vec2[] {
  const steps = GEAR.teeth * 160;
  const poly: Vec2[] = [];
  for (let i = 0; i < steps; i++) {
    const theta = (i / steps) * TAU;
    poly.push(polar(gearProfileRadius(theta), theta));
  }
  return poly;
}

function boreOutline(): Vec2[] {
  const poly: Vec2[] = [];
  for (let i = 0; i < 96; i++) {
    poly.push(polar(GEAR.boreRadius, (i / 96) * TAU));
  }
  return poly;
}

function windowOutline(index: number): Vec2[] {
  const spacing = TAU / GEAR.spokes;
  const a0 = GEAR.spokeStartAngle + index * spacing;
  const a1 = a0 + spacing;
  const w = GEAR.spokeHalfWidth;
  const rIn = GEAR.webInnerRadius;
  const rOut = GEAR.webOuterRadius;
  const dIn = Math.asin(w / rIn);
  const dOut = Math.asin(w / rOut);
  const sIn = Math.sqrt(rIn * rIn - w * w);
  const sOut = Math.sqrt(rOut * rOut - w * w);
  const arcSteps = 40;
  const lineSteps = 20;
  const poly: Vec2[] = [];

  for (let i = 0; i <= arcSteps; i++) {
    const a = a0 + dIn + ((a1 - a0 - 2 * dIn) * i) / arcSteps;
    poly.push(polar(rIn, a));
  }
  for (let i = 1; i <= lineSteps; i++) {
    const s = sIn + ((sOut - sIn) * i) / lineSteps;
    poly.push({
      x: s * Math.cos(a1) + w * Math.sin(a1),
      y: s * Math.sin(a1) - w * Math.cos(a1),
    });
  }
  for (let i = 1; i <= arcSteps; i++) {
    const a = a1 - dOut - ((a1 - a0 - 2 * dOut) * i) / arcSteps;
    poly.push(polar(rOut, a));
  }
  for (let i = 1; i < lineSteps; i++) {
    const s = sOut - ((sOut - sIn) * i) / lineSteps;
    poly.push({
      x: s * Math.cos(a0) - w * Math.sin(a0),
      y: s * Math.sin(a0) + w * Math.cos(a0),
    });
  }
  return poly;
}

function onGearBody(x: number, y: number, margin: number): boolean {
  const r = Math.hypot(x, y);
  const theta = Math.atan2(y, x);
  if (r > gearProfileRadius(theta) - margin) return false;
  if (r < GEAR.boreRadius + margin) return false;
  if (r > GEAR.webInnerRadius - margin && r < GEAR.webOuterRadius + margin) {
    const spacing = TAU / GEAR.spokes;
    const t = (((theta - GEAR.spokeStartAngle) % spacing) + spacing) % spacing;
    const toSpoke = Math.min(t, spacing - t);
    if (r * Math.sin(toSpoke) > GEAR.spokeHalfWidth - margin) return false;
  }
  return true;
}

interface EdgeRow {
  z: number;
  density: number;
  phase: number;
  weight: number;
}

const FRONT_ROW: EdgeRow = {
  z: GEAR.halfThickness,
  density: 1,
  phase: 0,
  weight: 1,
};

const FILL_SPACING_RATIO = 2.3;
const BACK_FILL_DENSITY = 0.3;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

interface RawPoint {
  x: number;
  y: number;
  z: number;
  weight: number;
}

function vogelFill(
  count: number,
  angleOffset: number,
  z: number,
  weight: number,
  margin: number,
): RawPoint[] {
  const out: RawPoint[] = [];
  for (let i = 0; i < count; i++) {
    const r = GEAR.tipRadius * Math.sqrt((i + 0.5) / count);
    const a = i * GOLDEN_ANGLE + angleOffset;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (onGearBody(x, y, margin)) out.push({ x, y, z, weight });
  }
  return out;
}

function buildGearPoints(target: number): RawPoint[] {
  const outer = outerOutline();
  const bore = boreOutline();
  const windows = Array.from({ length: GEAR.spokes }, (_, i) =>
    windowOutline(i),
  );

  const outlines: { poly: Vec2[]; rows: EdgeRow[] }[] = [
    { poly: outer, rows: [FRONT_ROW] },
    ...windows.map((poly) => ({ poly, rows: [FRONT_ROW] })),
    { poly: bore, rows: [FRONT_ROW] },
  ];

  const bodyArea =
    polygonArea(outer) -
    windows.reduce((sum, w) => sum + polygonArea(w), 0) -
    polygonArea(bore);

  const fillA = (bodyArea * (1 + BACK_FILL_DENSITY)) / FILL_SPACING_RATIO ** 2;
  const edgeB = outlines.reduce(
    (sum, o) =>
      sum + polygonLength(o.poly) * o.rows.reduce((s, r) => s + r.density, 0),
    0,
  );
  const lambda =
    (-edgeB + Math.sqrt(edgeB * edgeB + 4 * fillA * target)) / (2 * fillA);

  const raw: RawPoint[] = [];

  for (const { poly, rows } of outlines) {
    const length = polygonLength(poly);
    for (const row of rows) {
      const n = Math.max(3, Math.round(length * lambda * row.density));
      for (const p of resampleClosed(poly, n, row.phase)) {
        raw.push({ x: p.x, y: p.y, z: row.z, weight: row.weight });
      }
    }
  }

  const fillSpacing = FILL_SPACING_RATIO / lambda;
  const margin = fillSpacing * 0.85;
  const discArea = Math.PI * GEAR.tipRadius ** 2;
  const frontFill = Math.ceil(
    (discArea * lambda ** 2) / FILL_SPACING_RATIO ** 2,
  );
  raw.push(...vogelFill(frontFill, 0, GEAR.halfThickness, 0.75, margin));
  raw.push(
    ...vogelFill(
      Math.ceil(frontFill * BACK_FILL_DENSITY),
      1.3,
      -GEAR.halfThickness,
      0.5,
      margin * 1.7,
    ),
  );

  return raw;
}

export function generateGlobePoints(count: number): GlobePoint[] {
  const target = Math.max(0, Math.floor(count));
  if (target === 0) return [];

  let raw = buildGearPoints(target);
  if (Math.abs(raw.length - target) > target * 0.02) {
    raw = buildGearPoints(Math.round((target * target) / raw.length));
  }

  return raw.map((p, i) => ({
    x: p.x,
    y: p.y,
    z: p.z,
    isWhite: hash01(i + 1) < 0.14,
    phase: hash01(i + 101) * TAU,
    speed: 0.0004 + hash01(i + 211) * 0.0011,
    weight: p.weight,
  }));
}

export function transformPoint(p: Vec3, yaw: number, pitch: number): Vec3 {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x1 = p.x * cy + p.z * sy;
  const z1 = -p.x * sy + p.z * cy;

  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return {
    x: x1,
    y: p.y * cp - z1 * sp,
    z: p.y * sp + z1 * cp,
  };
}

export function projectGearPoint(
  x: number,
  y: number,
  z: number,
  spinCos: number,
  spinSin: number,
  pitchCos: number,
  pitchSin: number,
  out: Float64Array,
): void {
  const gx = x * spinCos - y * spinSin;
  const gy = x * spinSin + y * spinCos;
  out[0] = gx;
  out[1] = gy * pitchCos - z * pitchSin;
  out[2] = gy * pitchSin + z * pitchCos;
}

export function transformGearPoint(p: Vec3, spin: number, pitch: number): Vec3 {
  const out = new Float64Array(3);
  projectGearPoint(
    p.x,
    p.y,
    p.z,
    Math.cos(spin),
    Math.sin(spin),
    Math.cos(pitch),
    Math.sin(pitch),
    out,
  );
  return { x: out[0], y: out[1], z: out[2] };
}

const GEAR_VIEW_Z_RANGE =
  Math.sin(VIEW_PITCH) * GEAR.tipRadius +
  Math.cos(VIEW_PITCH) * GEAR.halfThickness;

export function gearDepth(viewZ: number): number {
  const t = Math.min(1, Math.max(0, (viewZ / GEAR_VIEW_Z_RANGE + 1) / 2));
  return GEAR_DEPTH_FLOOR + (1 - GEAR_DEPTH_FLOOR) * t;
}

export function orbitPoint(orbit: Orbit, angle: number): Vec3 {
  const x0 = Math.cos(angle) * orbit.radius;
  const z0 = Math.sin(angle) * orbit.radius;

  const cx = Math.cos(orbit.tiltX);
  const sx = Math.sin(orbit.tiltX);
  const y1 = -z0 * sx;
  const z1 = z0 * cx;

  const cz = Math.cos(orbit.tiltZ);
  const sz = Math.sin(orbit.tiltZ);
  return { x: x0 * cz - y1 * sz, y: x0 * sz + y1 * cz, z: z1 };
}

export function twinkle(phase: number, speed: number, timeMs: number): number {
  return 0.86 + 0.14 * Math.sin(phase + speed * timeMs);
}
