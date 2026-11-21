import { useEffect, useRef, useState } from 'react';
import {
  GLOBE_COLORS,
  GLOBE_RADIUS_RATIO,
  ORBITS,
  ORBIT_SEGMENTS,
  SPIN_RATE,
  TRAIL_STEPS,
  VIEW_PITCH,
  generateGlobePoints,
  orbitPoint,
  pointCountForSize,
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
      const yaw = timeMs * SPIN_RATE;

      drawOrbits(timeMs, false);
      drawNodes(timeMs, false);

      for (const point of points) {
        const breathe = 1 + 0.012 * Math.sin(point.phase + timeMs * 0.0005);
        const p = transformPoint(
          { x: point.x * breathe, y: point.y * breathe, z: point.z * breathe },
          yaw,
          VIEW_PITCH,
        );
        const depth = (p.z + 1) / 2;
        const alpha =
          (0.12 + 0.88 * depth ** 1.5) *
          twinkle(point.phase, point.speed, timeMs);
        const r = unit * (0.5 + depth * 1.05);
        ctx.fillStyle = `rgba(${point.isWhite ? GLOBE_COLORS.white : GLOBE_COLORS.teal}, ${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(
          center + p.x * radius,
          center + p.y * radius,
          r,
          0,
          Math.PI * 2,
        );
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
