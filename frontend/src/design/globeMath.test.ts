import { describe, expect, it } from 'vitest';
import {
  GEAR,
  MAX_POINT_COUNT,
  MIN_POINT_COUNT,
  ORBITS,
  VIEW_PITCH,
  gearDepth,
  gearProfileRadius,
  generateGlobePoints,
  orbitPoint,
  pointCountForSize,
  projectGearPoint,
  transformGearPoint,
  transformPoint,
  twinkle,
} from './globeMath';

describe('globeMath', () => {
  it('clamps point count to sane bounds', () => {
    expect(pointCountForSize(10)).toBe(MIN_POINT_COUNT);
    expect(pointCountForSize(5000)).toBe(MAX_POINT_COUNT);
  });

  it('generates deterministic gear points close to the requested count', () => {
    const a = generateGlobePoints(600);
    const b = generateGlobePoints(600);
    expect(a).toEqual(b);
    expect(Math.abs(a.length - 600)).toBeLessThanOrEqual(600 * 0.05);
    expect(generateGlobePoints(0)).toEqual([]);
  });

  it('keeps every point inside the gear envelope', () => {
    for (const p of generateGlobePoints(900)) {
      const theta = Math.atan2(p.y, p.x);
      // Edge dots sit on chords of the sampled outline: sub-pixel tolerance.
      expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(
        gearProfileRadius(theta) + 1e-3,
      );
      expect(Math.abs(p.z)).toBeLessThanOrEqual(GEAR.halfThickness + 1e-9);
      expect(p.weight).toBeGreaterThan(0);
      expect(p.weight).toBeLessThanOrEqual(1);
    }
  });

  it('leaves the bore and spoke windows empty', () => {
    const spacing = (Math.PI * 2) / GEAR.spokes;
    const midRadius = (GEAR.webInnerRadius + GEAR.webOuterRadius) / 2;
    for (const p of generateGlobePoints(900)) {
      const r = Math.hypot(p.x, p.y);
      // Edge dots sit exactly on the bore; nothing may fall inside it.
      expect(r).toBeGreaterThanOrEqual(GEAR.boreRadius - 1e-3);
      if (Math.abs(r - midRadius) < 0.05) {
        const t =
          (((Math.atan2(p.y, p.x) - GEAR.spokeStartAngle) % spacing) +
            spacing) %
          spacing;
        const toSpoke = Math.min(t, spacing - t);
        // Mid-web material only exists along a spoke (or its edge dots).
        expect(r * Math.sin(toSpoke)).toBeLessThanOrEqual(
          GEAR.spokeHalfWidth + 1e-3,
        );
      }
    }
  });

  it('shapes the silhouette as evenly repeating teeth', () => {
    const pitch = (Math.PI * 2) / GEAR.teeth;
    expect(gearProfileRadius(0)).toBeCloseTo(GEAR.tipRadius, 9);
    expect(gearProfileRadius(pitch / 2)).toBeCloseTo(GEAR.rootRadius, 9);
    expect(gearProfileRadius(0.123)).toBeCloseTo(
      gearProfileRadius(0.123 + pitch * 5),
      9,
    );
    for (let a = 0; a < Math.PI * 2; a += 0.01) {
      const r = gearProfileRadius(a);
      expect(r).toBeGreaterThanOrEqual(GEAR.rootRadius - 1e-9);
      expect(r).toBeLessThanOrEqual(GEAR.tipRadius + 1e-9);
    }
  });

  it('preserves distance from the origin when transforming', () => {
    const t = transformPoint({ x: 0.3, y: -0.5, z: 0.8 }, 1.1, 0.42);
    expect(Math.hypot(t.x, t.y, t.z)).toBeCloseTo(Math.hypot(0.3, 0.5, 0.8), 6);
    const g = transformGearPoint({ x: 0.3, y: -0.5, z: 0.05 }, 2.3, 0.42);
    expect(Math.hypot(g.x, g.y, g.z)).toBeCloseTo(
      Math.hypot(0.3, 0.5, 0.05),
      6,
    );
  });

  it('spins the gear about its own axis and returns after a full turn', () => {
    const p = { x: 0.6, y: -0.2, z: 0.05 };
    const start = transformGearPoint(p, 0, VIEW_PITCH);
    const quarter = transformGearPoint(p, Math.PI / 2, VIEW_PITCH);
    const full = transformGearPoint(p, Math.PI * 2, VIEW_PITCH);
    expect(quarter.x).not.toBeCloseTo(start.x, 3);
    expect(full.x).toBeCloseTo(start.x, 9);
    expect(full.y).toBeCloseTo(start.y, 9);
    expect(full.z).toBeCloseTo(start.z, 9);
  });

  it('projects gear points identically to the reference rotation maths', () => {
    const out = new Float64Array(3);
    for (const [x, y, z, spin] of [
      [0.6, -0.2, 0.05, 0.7],
      [-0.9, 0.4, -0.05, 3.1],
      [0.1, 0.95, 0.05, 5.9],
    ]) {
      projectGearPoint(
        x,
        y,
        z,
        Math.cos(spin),
        Math.sin(spin),
        Math.cos(VIEW_PITCH),
        Math.sin(VIEW_PITCH),
        out,
      );
      const rotated = {
        x: x * Math.cos(spin) - y * Math.sin(spin),
        y: x * Math.sin(spin) + y * Math.cos(spin),
        z,
      };
      const ref = transformPoint(rotated, 0, VIEW_PITCH);
      expect(out[0]).toBeCloseTo(ref.x, 9);
      expect(out[1]).toBeCloseTo(ref.y, 9);
      expect(out[2]).toBeCloseTo(ref.z, 9);
    }
  });

  it('keeps gear shading depth within the 0..1 curve', () => {
    for (const z of [-2, -0.4, 0, 0.4, 2]) {
      const d = gearDepth(z);
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(1);
    }
    expect(gearDepth(0.3)).toBeGreaterThan(gearDepth(-0.3));
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
