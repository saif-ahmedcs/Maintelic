import { describe, expect, it } from 'vitest';
import {
  MAX_POINT_COUNT,
  MIN_POINT_COUNT,
  ORBITS,
  generateGlobePoints,
  orbitPoint,
  pointCountForSize,
  transformPoint,
  twinkle,
} from './globeMath';

describe('globeMath', () => {
  it('clamps point count to sane bounds', () => {
    expect(pointCountForSize(10)).toBe(MIN_POINT_COUNT);
    expect(pointCountForSize(5000)).toBe(MAX_POINT_COUNT);
  });

  it('generates deterministic unit-sphere points', () => {
    const a = generateGlobePoints(300);
    const b = generateGlobePoints(300);
    expect(a).toEqual(b);
    for (const p of a) {
      expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(1, 5);
    }
  });

  it('preserves distance from the origin when transforming', () => {
    const t = transformPoint({ x: 0.3, y: -0.5, z: 0.8 }, 1.1, 0.42);
    expect(Math.hypot(t.x, t.y, t.z)).toBeCloseTo(Math.hypot(0.3, 0.5, 0.8), 6);
  });

  it('keeps orbit points on their ring radius', () => {
    for (const orbit of ORBITS) {
      for (const angle of [0, 1, 2.5, 4]) {
        const p = orbitPoint(orbit, angle);
        expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(orbit.radius, 6);
      }
    }
  });

  it('keeps twinkle brightness in a restrained range', () => {
    for (let t = 0; t < 10000; t += 137) {
      const v = twinkle(1.2, 0.001, t);
      expect(v).toBeGreaterThanOrEqual(0.72);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
