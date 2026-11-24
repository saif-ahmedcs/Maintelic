import dashboardBackground from '../assets/dashboard-background.png';

/**
 * Persistent backdrop for the authenticated console.
 *
 * Rendered once by AppShell, the layout route shared by every dashboard page,
 * so it stays mounted while <Outlet /> swaps pages and never reloads or resets.
 *
 * - `fixed inset-0`: pinned to the viewport, so page scroll never moves it.
 * - `-z-10`: sits behind the shell content. AppShell's root is `isolate`, which
 *   keeps this layer above the opaque <body> background but below everything else.
 * - `pointer-events-none`: never intercepts clicks, selection or scrolling.
 * - `bg-cover bg-bottom bg-no-repeat`: fills the viewport without stretching or
 *   tiling, anchored to the bottom so the lit floor and horizon stay in view.
 * - `bg-surface-abyss`: the page canvas colour, shown while the image decodes.
 */
export function DashboardBackground() {
  return (
    <div
      aria-hidden="true"
      data-dashboard-background
      className="pointer-events-none fixed inset-0 -z-10 bg-surface-abyss bg-cover bg-bottom bg-no-repeat"
      style={{ backgroundImage: `url(${dashboardBackground})` }}
    />
  );
}
