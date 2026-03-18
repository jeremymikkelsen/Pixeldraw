/**
 * FishingCampAnimator — per-frame animation for fishing camps.
 *
 * Animates:
 *  - Chimney smoke puffs (both variants)
 *  - Boat cycle: sails out to fishing spot, fishes with net, returns (continuous)
 *    Ocean: goes to open sea. River: travels down river to fish in ocean.
 *  - Worker: walks from hut to drying rack and back carrying fish
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
const ARRIVE_END       = 0.90;  // boat back at dock (hides behind static moored boat)

// ── Worker cycle ──────────────────────────────────────────────────────────────
const WORKER_CYCLE     = 8000;  // 8s full cycle
const WORKER_WALK_OUT  = 0.30;  // walk hut → rack ends
const WORKER_AT_RACK   = 0.50;  // pause at rack ends
const WORKER_WALK_BACK = 0.75;  // walk rack → hut ends (carrying fish)
// 0.75–1.0: pause at hut

// ── Smoke ─────────────────────────────────────────────────────────────────────
const SMOKE_SPAWN_MS  = 800;
const SMOKE_RISE      = 0.0035;
const SMOKE_MAX_AGE   = 2200;

interface SmokeParticle { x: number; y: number; age: number; }

// ── Per-camp state ─────────────────────────────────────────────────────────────
interface CampState {
  data: FishingCampRenderData;
  smoke: SmokeParticle[];
  lastSmoke: number;
  cycleNum: number;  // increments each time boat completes a cycle (for random fishing spots)
  fishingPx: number; // per-cycle fishing spot
  fishingPy: number;
}

// ── Colors ────────────────────────────────────────────────────────────────────
const BOAT_DARK   = packABGR(0x3a, 0x28, 0x10);
const BOAT_MID    = packABGR(0x5a, 0x40, 0x30);
const BOAT_LIGHT  = packABGR(0x7a, 0x58, 0x40);
const NET_COLOR   = packABGR(0xb0, 0xa0, 0x80);
const HEAD_COLOR  = packABGR(0xc8, 0xa8, 0x80);
const BODY_COLOR  = packABGR(0x5c, 0x78, 0x40);
const LEG_COLOR   = packABGR(0x5a, 0x48, 0x38);
const FISH_COLOR  = packABGR(0xc0, 0x78, 0x5c);

// Simple mulberry32 for per-cycle randomization
function _rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

export class FishingCampAnimator {
  extrusionMap: Int16Array | null = null;

  private _camps: CampState[] = [];
  private _N: number;
  private _dirty: { screenIdx: number; color: number }[] = [];
  private _savedThisFrame = new Set<number>();

  constructor(renderData: FishingCampRenderData[], N: number) {
    this._N = N;
    for (const data of renderData) {
      this._camps.push({
        data,
        smoke: [],
        lastSmoke: 0,
        cycleNum: 0,
        fishingPx: data.fishingPx,
        fishingPy: data.fishingPy,
      });
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
      this._animateBoat(pixels, camp, timeMs, N, ext);
      this._animateWorker(pixels, camp, timeMs, N, ext);
    }
  }

  // ── Chimney smoke ──────────────────────────────────────────────────────────
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

  // ── Boat cycle (both ocean and river) ─────────────────────────────────────
  private _animateBoat(
    pixels: Uint32Array, camp: CampState,
    timeMs: number, N: number, ext: Int16Array | null,
  ): void {
    const t = (timeMs % BOAT_CYCLE) / BOAT_CYCLE;
    const { mooredPx, mooredPy, waterDirX, waterDirY, duchyIndex } = camp.data;

    // Detect cycle rollover to pick new fishing spot
    const newCycleNum = Math.floor(timeMs / BOAT_CYCLE);
    if (newCycleNum !== camp.cycleNum) {
      camp.cycleNum = newCycleNum;
      // Randomize fishing destination: ±40° rotation of waterDir, distance 35–60px
      const rng = _rng(duchyIndex * 0x3a7f5c + newCycleNum * 0x1d3c7);
      const baseDist  = camp.data.variant === 'ocean' ? 45 : 55;
      const dist = baseDist + Math.floor(rng() * 20) - 10;
      const angle = (rng() - 0.5) * (Math.PI / 4.5); // ±40°
      const cosA = Math.cos(angle), sinA = Math.sin(angle);
      const rdx = waterDirX * cosA - waterDirY * sinA;
      const rdy = waterDirX * sinA + waterDirY * cosA;
      camp.fishingPx = Math.round(camp.data.dockPx + rdx * dist);
      camp.fishingPy = Math.round(camp.data.dockPy + rdy * dist);
    }

    const { fishingPx, fishingPy } = camp;

    let bx: number, by: number;
    let showNet = false;

    if (t < DEPART_START) {
      // Hidden at dock behind static moored boat
      return;
    } else if (t < FISHING_START) {
      // Sailing out
      const progress = (t - DEPART_START) / (FISHING_START - DEPART_START);
      bx = Math.round(mooredPx + (fishingPx - mooredPx) * progress);
      by = Math.round(mooredPy + (fishingPy - mooredPy) * progress);
    } else if (t < RETURN_START) {
      // At fishing spot
      bx = fishingPx + Math.round(Math.sin(timeMs * 0.002) * 0.5);
      by = fishingPy + Math.round(Math.sin(timeMs * 0.0015) * 0.5);
      showNet = true;
    } else if (t < ARRIVE_END) {
      // Sailing back toward moored position
      const progress = (t - RETURN_START) / (ARRIVE_END - RETURN_START);
      bx = Math.round(fishingPx + (mooredPx - fishingPx) * progress);
      by = Math.round(fishingPy + (mooredPy - fishingPy) * progress);
    } else {
      // Arrived — hidden behind static moored boat
      return;
    }

    bx = Math.max(2, Math.min(N - 4, bx));
    by = Math.max(2, Math.min(N - 4, by));

    this._drawBoatAt(pixels, N, ext, bx, by, waterDirX, waterDirY);

    // Net shape when fishing: arc of pixels spread perpendicular ahead of boat
    if (showNet) {
      const perpX = -waterDirY, perpY = waterDirX;
      for (let side = -3; side <= 3; side++) {
        const nx = Math.round(bx + waterDirX * (3 + Math.abs(side) / 2) + perpX * side);
        const ny = Math.round(by + waterDirY * (3 + Math.abs(side) / 2) + perpY * side);
        if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
        const srcIdx = ny * N + nx;
        const screenIdx = this._screenIdx(srcIdx, N, ext);
        if (screenIdx < 0) continue;
        this._saveDirty(pixels, screenIdx);
        pixels[screenIdx] = NET_COLOR;
      }
    }
  }

  // ── Draw moving boat at position ───────────────────────────────────────────
  private _drawBoatAt(
    pixels: Uint32Array, N: number, ext: Int16Array | null,
    cx: number, cy: number,
    waterDirX: number, waterDirY: number,
  ): void {
    const perpX = -waterDirY, perpY = waterDirX;
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
        pixels[screenIdx] = [BOAT_DARK, BOAT_MID, BOAT_LIGHT][shade];
      }
    }
  }

  // ── Worker walks hut ↔ drying rack carrying fish ───────────────────────────
  private _animateWorker(
    pixels: Uint32Array, camp: CampState,
    timeMs: number, N: number, ext: Int16Array | null,
  ): void {
    const { rackPositions } = camp.data;
    if (!rackPositions || rackPositions.length === 0) return;

    const t = (timeMs % WORKER_CYCLE) / WORKER_CYCLE;

    // Alternate between two racks each cycle
    const whichRack = Math.floor(timeMs / WORKER_CYCLE) % rackPositions.length;
    const rack = rackPositions[whichRack];
    const { hutPx, hutPy } = camp.data;

    let wx: number, wy: number;
    let carrying = false;

    if (t < WORKER_WALK_OUT) {
      // Walking to rack
      const p = t / WORKER_WALK_OUT;
      wx = Math.round(hutPx + (rack.px - hutPx) * p);
      wy = Math.round(hutPy + (rack.py - hutPy) * p);
    } else if (t < WORKER_AT_RACK) {
      // At rack (loading fish)
      wx = rack.px;
      wy = rack.py;
    } else if (t < WORKER_WALK_BACK) {
      // Walking back to hut (carrying fish)
      const p = (t - WORKER_AT_RACK) / (WORKER_WALK_BACK - WORKER_AT_RACK);
      wx = Math.round(rack.px + (hutPx - rack.px) * p);
      wy = Math.round(rack.py + (hutPy - rack.py) * p);
      carrying = true;
    } else {
      // At hut (processing/resting)
      wx = hutPx;
      wy = hutPy;
    }

    // Draw 3-pixel person: head, body, legs
    const personPixels: [number, number, number][] = [
      [wx, wy - 2, HEAD_COLOR],
      [wx, wy - 1, BODY_COLOR],
      [wx, wy,     LEG_COLOR],
    ];
    // Carried fish: pixel above/right of head when walking back
    if (carrying) {
      personPixels.push([wx + 1, wy - 3, FISH_COLOR]);
    }

    for (const [px, py, color] of personPixels) {
      if (px < 0 || px >= N || py < 0 || py >= N) continue;
      const srcIdx = py * N + px;
      const screenIdx = this._screenIdx(srcIdx, N, ext);
      if (screenIdx < 0) continue;
      this._saveDirty(pixels, screenIdx);
      pixels[screenIdx] = color;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
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
