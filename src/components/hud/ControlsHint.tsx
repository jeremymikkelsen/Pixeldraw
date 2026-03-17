export function ControlsHint() {
  const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  if (isTouchDevice) return null;

  return (
    <div className="hud-controls-hint">
      WASD/Arrows pan &middot; Scroll zoom &middot; Hold SPACE drag pan &middot; ENTER new game &middot; 8/9/0 overlays
    </div>
  );
}
