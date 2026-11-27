import { useEffect, useRef, useState } from 'react';
import {
  GEAR_SPIN_RATE,
  GLOBE_COLORS,
  GLOBE_RADIUS_RATIO,
  ORBITS,
  ORBIT_SEGMENTS,
  SPIN_RATE,
  TRAIL_STEPS,
  VIEW_PITCH,
  gearDepth,
  generateGlobePoints,
  orbitPoint,
  pointCountForSize,
  projectGearPoint,
  transformPoint,
  twinkle,
  type GlobePoint,
} from './globeMath';

export interface IndustrialGlobeProps {
  animated?: boolean;
  className?: string;
}

const MAX_DPR = 2;
const STILL_TIME_MS = 4000;
const ALPHA_LEVELS = 48;
const TAU = Math.PI * 2;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function createGlowSprite(): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const sprite = document.createElement('canvas');
  sprite.width = 64;
  sprite.height = 64;
  const g = sprite.getContext('2d');
  if (!g) return null;
  const gradient = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, `rgba(${GLOBE_COLORS.white}, 1)`);
  gradient.addColorStop(0.18, `rgba(${GLOBE_COLORS.cyan}, 0.85)`);
  gradient.addColorStop(0.5, `rgba(${GLOBE_COLORS.teal}, 0.22)`);
  gradient.addColorStop(1, `rgba(${GLOBE_COLORS.teal}, 0)`);
  g.fillStyle = gradient;
  g.fillRect(0, 0, 64, 64);
  return sprite;
}

export function IndustrialGlobe({
  animated = true,
  className,
}: IndustrialGlobeProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [size, setSize] = useState(0);
  const [reduced, setReduced] = useState(prefersReducedMotion);
  const [tabVisible, setTabVisible] = useState(
    () =>
      typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );
  const [inViewport, setInViewport] = useState(true);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const onVisibility = () =>
      setTabVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(([entry]) =>
        setSize(Math.round(entry.contentRect.width)),
      );
      ro.observe(el);
      return () => ro.disconnect();
    }
    setSize(Math.round(el.getBoundingClientRect().width));
  }, []);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      ([entry]) => setInViewport(entry.isIntersecting),
      { threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const shouldAnimate = animated && !reduced && tabVisible && inViewport;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const points: GlobePoint[] = generateGlobePoints(pointCountForSize(size));
    const glow = createGlowSprite();
    const center = size / 2;
    const radius = center * GLOBE_RADIUS_RATIO;
    const unit = size / 560;

    const n = points.length;
    const baseX = new Float32Array(n);
    const baseY = new Float32Array(n);
    const baseZ = new Float32Array(n);
    const phases = new Float32Array(n);
    const speeds = new Float32Array(n);
    const weights = new Float32Array(n);
    const whites = new Uint8Array(n);
    points.forEach((point, i) => {
      baseX[i] = point.x;
      baseY[i] = point.y;
      baseZ[i] = point.z;
      phases[i] = point.phase;
      speeds[i] = point.speed;
      weights[i] = point.weight;
      whites[i] = point.isWhite ? 1 : 0;
    });
    const screenX = new Float32Array(n);
    const screenY = new Float32Array(n);
    const screenR = new Float32Array(n);
    const bucketOf = new Uint8Array(n);
    const order = new Uint16Array(n);
    const view = new Float64Array(3);
    const dotColors: string[] = [];
    for (const color of [GLOBE_COLORS.teal, GLOBE_COLORS.white]) {
      for (let level = 0; level <= ALPHA_LEVELS; level++) {
        dotColors.push(`rgba(${color}, ${(level / ALPHA_LEVELS).toFixed(3)})`);
      }
    }
    const bucketStart = new Int32Array(dotColors.length + 1);
    const cursor = new Int32Array(dotColors.length);
    const pitchCos = Math.cos(VIEW_PITCH);
    const pitchSin = Math.sin(VIEW_PITCH);

    function drawOrbits(timeMs: number, front: boolean) {
      if (!ctx) return;
      const precession = timeMs * SPIN_RATE * 0.6;
      ctx.lineWidth = Math.max(0.6, unit * 0.9);
      for (const orbit of ORBITS) {
        ctx.beginPath();
        let penDown = false;
        for (let i = 0; i <= ORBIT_SEGMENTS; i++) {
          const a = (i / ORBIT_SEGMENTS) * Math.PI * 2;
          const p = transformPoint(
            orbitPoint(orbit, a),
            precession * (orbit.tiltZ > 0 ? 1 : -1),
            VIEW_PITCH,
          );
          const isFront = p.z >= 0;
          if (isFront !== front) {
            penDown = false;
            continue;
          }
          const sx = center + p.x * radius;
          const sy = center + p.y * radius;
          if (penDown) ctx.lineTo(sx, sy);
          else ctx.moveTo(sx, sy);
          penDown = true;
        }
        ctx.strokeStyle = `rgba(${GLOBE_COLORS.cyan}, ${front ? 0.2 : 0.06})`;
        ctx.stroke();
      }
    }

    function drawNodes(timeMs: number, front: boolean) {
      if (!ctx || !glow) return;
      const precession = timeMs * SPIN_RATE * 0.6;
      for (const orbit of ORBITS) {
        const yaw = precession * (orbit.tiltZ > 0 ? 1 : -1);
        for (const node of orbit.nodes) {
          for (let step = TRAIL_STEPS; step >= 0; step--) {
            const angle =
              node.offset + node.speed * timeMs - step * node.speed * 38;
            const p = transformPoint(orbitPoint(orbit, angle), yaw, VIEW_PITCH);
            if (p.z >= 0 !== front) continue;
            const depth = (p.z / orbit.radius + 1) / 2;
            const head = step === 0;
            const fade = head ? 1 : (1 - step / (TRAIL_STEPS + 1)) * 0.45;
            const d = (head ? 15 : 7) * unit * (0.7 + depth * 0.5);
            ctx.globalAlpha = fade * (0.45 + depth * 0.55);
            ctx.drawImage(
              glow,
              center + p.x * radius - d / 2,
              center + p.y * radius - d / 2,
              d,
              d,
            );
          }
        }
      }
      ctx.globalAlpha = 1;
    }

    function draw(timeMs: number) {
      if (!ctx) return;
      ctx.clearRect(0, 0, size, size);

      const spin = timeMs * GEAR_SPIN_RATE;
      const spinCos = Math.cos(spin);
      const spinSin = Math.sin(spin);

      drawOrbits(timeMs, false);
      drawNodes(timeMs, false);

      bucketStart.fill(0);
      for (let i = 0; i < n; i++) {
        const breathe = 1 + 0.012 * Math.sin(phases[i] + timeMs * 0.0005);
        projectGearPoint(
          baseX[i] * breathe,
          baseY[i] * breathe,
          baseZ[i] * breathe,
          spinCos,
          spinSin,
          pitchCos,
          pitchSin,
          view,
        );
        const depth = gearDepth(view[2]);
        const alpha =
          (0.12 + 0.88 * depth ** 1.5) *
          weights[i] *
          twinkle(phases[i], speeds[i], timeMs);
        const level = Math.min(ALPHA_LEVELS, Math.round(alpha * ALPHA_LEVELS));
        const bucket = whites[i] * (ALPHA_LEVELS + 1) + level;
        bucketOf[i] = bucket;
        bucketStart[bucket + 1]++;
        screenX[i] = center + view[0] * radius;
        screenY[i] = center + view[1] * radius;
        screenR[i] = unit * (0.5 + depth * 1.05);
      }
      for (let k = 0; k < dotColors.length; k++) {
        bucketStart[k + 1] += bucketStart[k];
        cursor[k] = bucketStart[k];
      }
      for (let i = 0; i < n; i++) {
        order[cursor[bucketOf[i]]++] = i;
      }
      for (let k = 0; k < dotColors.length; k++) {
        const from = bucketStart[k];
        const to = bucketStart[k + 1];
        if (from === to) continue;
        ctx.fillStyle = dotColors[k];
        ctx.beginPath();
        for (let j = from; j < to; j++) {
          const i = order[j];
          ctx.moveTo(screenX[i] + screenR[i], screenY[i]);
          ctx.arc(screenX[i], screenY[i], screenR[i], 0, TAU);
        }
        ctx.fill();
      }

      drawOrbits(timeMs, true);
      drawNodes(timeMs, true);
    }

    if (!shouldAnimate) {
      draw(STILL_TIME_MS);
      return;
    }

    let frame = 0;
    let last = performance.now();
    let clock = STILL_TIME_MS;
    function tick(now: number) {
      clock += Math.min(now - last, 64);
      last = now;
      draw(clock);
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [size, shouldAnimate]);

  return (
    <div
      ref={wrapperRef}
      aria-hidden="true"
      data-testid="industrial-globe"
      className={['pointer-events-none relative aspect-square', className]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="absolute inset-[14%] rounded-full bg-[radial-gradient(circle,color-mix(in_srgb,var(--color-accent-teal-signal)_16%,transparent)_0%,color-mix(in_srgb,var(--color-accent-teal-signal)_5%,transparent)_45%,transparent_70%)] blur-2xl" />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        data-testid="industrial-globe-canvas"
      />
    </div>
  );
}
