import { generateSpherePoints } from './sphereMath';

export const GLOBE_RADIUS_RATIO = 0.64;
export const BASE_POINT_COUNT = 820;
export const MIN_POINT_COUNT = 260;
export const MAX_POINT_COUNT = 1300;
export const BASELINE_SIZE_PX = 560;
export const SPIN_RATE = 0.0001;
export const VIEW_PITCH = 0.42;
export const ORBIT_SEGMENTS = 120;
export const TRAIL_STEPS = 9;

export const GLOBE_COLORS = {
  teal: '28, 196, 184',
  white: '237, 255, 254',
  cyan: '203, 255, 252',
} as const;

export interface GlobePoint {
  x: number;
  y: number;
  z: number;
  isWhite: boolean;
  phase: number;
  speed: number;
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

export function generateGlobePoints(count: number): GlobePoint[] {
  return generateSpherePoints(count).map((p, i) => ({
    x: p.x,
    y: p.y,
    z: p.z,
    isWhite: hash01(i + 1) < 0.14,
    phase: hash01(i + 101) * Math.PI * 2,
    speed: 0.0004 + hash01(i + 211) * 0.0011,
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
