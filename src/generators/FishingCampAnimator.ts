/**
 * FishingCampAnimator — per-frame animation for fishing camps.
 *
 * Animates:
 *  - Chimney smoke puffs (both variants)
 *  - Ocean: boat sails out to fishing spot, fishes, returns (continuous cycle)
 *  - River: no additional animation (fishermen are static in renderer)
 *
 * Uses dirty-pixel save/restore pattern.
 * Run AFTER _buildingPixels restoration so boat appears over dock structure.
 */

import { packABGR } from './TerrainPalettes';
import type { FishingCampRenderData } from './FishingCampRenderer';

// ── Boat cycle phases (as fractions of BOAT_CYCLE) ───────────────────────────
const BOAT_CYCLE       = 18000; // 18s full cycle
const DEPART_START     = 0.12;  // boat visible leaving dock
const FISHING_START    = 0.38;  // boat at fishing spot
const RETURN_START     = 0.72;  // boat heading home
const ARRIVE_END       = 0.90;  // boat back at dock

// ── Smoke ────────────────────────────────────────────────────────────────────
const SMOKE_SPAWN_MS  = 800;
const SMOKE_RISE      = 0.0035;
const SMOKE_MAX_AGE   = 2200;

interface SmokeParticle {
  x: number;
  y: number;
  age: number;
}

// ── Per-camp state ────────────────────────────────────────────────────────────
interface CampState {
  data: FishingCampRenderData;
  smoke: SmokeParticle[];
  lastSmoke: number;
}

// ── Boat colors ───────────────────────────────────────────────────────────────
const BOAT_DARK  = packABGR(0x3a, 0x28, 0x10);
const BOAT_MID   = packABGR(0x5a, 0x40, 0x30);
const BOAT_LIGHT = packABGR(0x7a, 0x58, 0x40);
const LINE_COLOR = packABGR(0x40, 0x38, 0x30);

export class FishingCampAnimator {
  extrusionMap: Int16Array | null = null;

  private _camps: CampState[] = [];
  private _N: number;
  private _dirty: { screenIdx: number; color: number }[] = [];
  private _savedThisFrame = new Set<number>();

  constructor(renderData: FishingCampRenderData[], N: number) {
    this._N = N;
    for (const data of renderData) {
      this._camps.push({ data, smoke: [], lastSmoke: 0 });
    }
  }

  animate(pixels: Uint32Array, timeMs: number): void {
    const N = this._N;
    const ext = this.extrusionMap;

    // Restore dirty pixels from last frame
    for (const d of this._dirty) pixels[d.screenIdx] = d.color;
    this._dirty = [];
    this._savedThisFrame = new Set<number>();

    for (const camp of this._camps) {
      this._animateSmoke(pixels, camp, timeMs, N, ext);
      if (camp.data.variant === 'ocean') {
        this._animateBoat(pixels, camp, timeMs, N, ext);
      }
    }
  }

  // ── Chimney smoke ─────────────────────────────────────────────────────────
  private _animateSmoke(
    pixels: Uint32Array, camp: CampState,
    timeMs: number, N: number, ext: Int16Array | null,
  ): void {
    if (timeMs - camp.lastSmoke > SMOKE_SPAWN_MS) {
      camp.smoke.push({
        x: camp.data.chimneyPx + (Math.random() < 0.5 ? 0 : 1),
        y: camp.data.chimneyPy,
        age: 0,
      });
      camp.lastSmoke = timeMs;
      if (camp.smoke.length > 5) camp.smoke.shift();
    }

    for (let i = camp.smoke.length - 1; i >= 0; i--) {
      const p = camp.smoke[i];
      p.age += 16;
      if (p.age > SMOKE_MAX_AGE) { camp.smoke.splice(i, 1); continue; }
      const py = Math.round(p.y - p.age * SMOKE_RISE);
      const px = Math.round(p.x + Math.sin(p.age * 0.004) * 0.7);
      if (px < 0 || px >= N || py < 0 || py >= N) continue;
      const srcIdx = py * N + px;
      const screenIdx = this._screenIdx(srcIdx, N, ext);
      if (screenIdx < 0) continue;
      this._saveDirty(pixels, screenIdx);
      const existing = pixels[screenIdx];
      const alpha = Math.max(0.08, 0.50 * (1 - p.age / SMOKE_MAX_AGE));
      const nr = Math.round((existing & 0xff) + (0xe8 - (existing & 0xff)) * alpha);
      const ng = Math.round(((existing >> 8) & 0xff) + (0xe4 - ((existing >> 8) & 0xff)) * alpha);
      const nb = Math.round(((existing >> 16) & 0xff) + (0xe0 - ((existing >> 16) & 0xff)) * alpha);
      pixels[screenIdx] = (255 << 24) | (nb << 16) | (ng << 8) | nr;
    }
  }

  // ── Ocean boat cycle ──────────────────────────────────────────────────────
  private _animateBoat(
    pixels: Uint32Array, camp: CampState,
    timeMs: number, N: number, ext: Int16Array | null,
  ): void {
    const t = (timeMs % BOAT_CYCLE) / BOAT_CYCLE;
    const { dockPx, dockPy, fishingPx, fishingPy, waterDirX, waterDirY } = camp.data;

    let bx: number, by: number;
    let showLine = false;

    if (t < DEPART_START) {
      // Boat hidden (at dock, covered by static dock pixels)
      return;
    } else if (t < FISHING_START) {
      // Sailing out
      const progress = (t - DEPART_START) / (FISHING_START - DEPART_START);
      bx = Math.round(dockPx + (fishingPx - dockPx) * progress);
      by = Math.round(dockPy + (fishingPy - dockPy) * progress);
    } else if (t < RETURN_START) {
      // At fishing spot
      bx = fishingPx + Math.round(Math.sin(timeMs * 0.002) * 0.5);
      by = fishingPy + Math.round(Math.sin(timeMs * 0.0015) * 0.5);
      showLine = true;
    } else if (t < ARRIVE_END) {
      // Sailing back
      const progress = (t - RETURN_START) / (ARRIVE_END - RETURN_START);
      bx = Math.round(fishingPx + (dockPx - fishingPx) * progress);
      by = Math.round(fishingPy + (dockPy - fishingPy) * progress);
    } else {
      // Back at dock — hidden behind static moored boat
      return;
    }

    // Clamp boat position
    bx = Math.max(2, Math.min(N - 4, bx));
    by = Math.max(2, Math.min(N - 4, by));

    this._drawBoatAt(pixels, N, ext, bx, by, waterDirX, waterDirY);

    // Fishing line when stationary
    if (showLine) {
      for (let i = 1; i <= 6; i++) {
        const lpx = Math.round(bx + waterDirX * (2 + i));
        const lpy = Math.round(by + waterDirY * (2 + i));
        if (lpx < 0 || lpx >= N || lpy < 0 || lpy >= N) continue;
        const srcIdx = lpy * N + lpx;
        const screenIdx = this._screenIdx(srcIdx, N, ext);
        if (screenIdx < 0) continue;
        this._saveDirty(pixels, screenIdx);
        pixels[screenIdx] = LINE_COLOR;
      }
    }
  }

  // ── Draw moving boat at position ──────────────────────────────────────────
  private _drawBoatAt(
    pixels: Uint32Array, N: number, ext: Int16Array | null,
    cx: number, cy: number,
    waterDirX: number, waterDirY: number,
  ): void {
    const perpX = -waterDirY, perpY = waterDirX;

    // Boat is 7px long (waterDir) × 5px wide (perp)
    // Row layout: narrow tip, wide hull, narrow stern
    const rows = [
      { len: 1, fwd: 0 },
      { len: 2, fwd: 1 },
      { len: 2, fwd: 2 },
      { len: 2, fwd: 3 },
      { len: 1, fwd: 4 },
    ];

    for (const row of rows) {
      const { len, fwd } = row;
      for (let side = -len; side <= len; side++) {
        const px = Math.round(cx + perpX * side + waterDirX * fwd);
        const py = Math.round(cy + perpY * side + waterDirY * fwd);
        if (px < 0 || px >= N || py < 0 || py >= N) continue;
        const srcIdx = py * N + px;
        const screenIdx = this._screenIdx(srcIdx, N, ext);
        if (screenIdx < 0) continue;
        this._saveDirty(pixels, screenIdx);
        const shade = Math.abs(side) > 1 ? 0 : (Math.abs(side) === 0 ? 2 : 1);
        const colors = [BOAT_DARK, BOAT_MID, BOAT_LIGHT];
        pixels[screenIdx] = colors[shade];
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  private _saveDirty(pixels: Uint32Array, screenIdx: number): void {
    if (!this._savedThisFrame.has(screenIdx)) {
      this._dirty.push({ screenIdx, color: pixels[screenIdx] });
      this._savedThisFrame.add(screenIdx);
    }
  }

  private _screenIdx(srcIdx: number, N: number, ext: Int16Array | null): number {
    if (!ext) return srcIdx;
    const px = srcIdx % N;
    const py = (srcIdx - px) / N;
    const screenY = py - ext[srcIdx];
    if (screenY < 0 || screenY >= N) return -1;
    return screenY * N + px;
  }
}
