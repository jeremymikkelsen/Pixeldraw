/**
 * WoodcutterAnimator — per-frame animation for woodcutter buildings.
 *
 * Each woodcutter has:
 *  - A lumberjack who walks to a tree, chops it, carries the log back
 *  - Chimney smoke puffs rising
 *  - (Sawmill) Water wheel always spinning
 *  - (Sawmill) Logs floating downstream after cutting
 *
 * Follows the dirty-pixel save/restore pattern of GardenWorkerAnimator.
 */

import { mulberry32 } from './TopographyGenerator';
import { packABGR } from './TerrainPalettes';
import { Season } from '../state/Season';
import type { WoodcutterRenderData } from './WoodcutterRenderer';
import { WHEEL_FRAMES, WHEEL_SIZE, WH } from './WoodcutterRenderer';
import type { GameState } from '../state/GameState';

// ── Person sprite (same as RoadTravelerAnimator / GardenWorkerAnimator) ────
const PERSON_HEAD = packABGR(0xc8, 0xa8, 0x80);
const PERSON_LEG  = packABGR(0x5a, 0x48, 0x38);
const LOG_COLOR   = packABGR(0x6e, 0x53, 0x40);

const _  = -1;
const PERSON_RIGHT = { w: 2, h: 3, cells: [[0, _], [1, 1], [_, 2]] };
const PERSON_LEFT  = { w: 2, h: 3, cells: [[_, 0], [1, 1], [2, _]] };
// cell 0 = head, 1 = body (duchy color), 2 = legs

// ── Timing (milliseconds) ──────────────────────────────────────────────────
const CYCLE_DURATION = 12000;  // 12s per chop cycle for manual
const SAWMILL_CYCLE  = 5000;   // 5s per cycle for sawmill (3 cycles visible)

// Phase breakdown within a cycle (as fractions)
const IDLE_END      = 0.15;
const WALK_OUT_END  = 0.40;
const CHOP_END      = 0.55;
const CARRY_END     = 0.85;
// 0.85-1.0 = stacking

// ── Smoke particle ─────────────────────────────────────────────────────────
interface SmokeParticle {
  x: number;
  y: number;
  age: number; // ms since spawn
}

const SMOKE_SPAWN_INTERVAL = 900;  // ms between puffs
const SMOKE_RISE_SPEED = 0.003;    // pixels per ms
const SMOKE_MAX_AGE = 2500;        // ms before particle dies

// ── Wheel color ────────────────────────────────────────────────────────────
const WHEEL_COLORS = [
  packABGR(0x5a, 0x48, 0x30),
  packABGR(0x6e, 0x5c, 0x3e),
];

// ── Per-woodcutter state ───────────────────────────────────────────────────
interface LumberjackState {
  data: WoodcutterRenderData;
  bodyColor: number;
  // Target tree position
  targetPx: number;
  targetPy: number;
  hasTarget: boolean;
  // Smoke
  smokeParticles: SmokeParticle[];
  lastSmokeSpawn: number;
}

export class WoodcutterAnimator {
  extrusionMap: Int16Array | null = null;

  private _workers: LumberjackState[] = [];
  private _N: number;
  private _season: Season;
  private _dirty: { screenIdx: number; color: number }[] = [];
  private _savedThisFrame = new Set<number>();
  private _state: GameState;

  constructor(
    renderData: WoodcutterRenderData[],
    treeMask: Uint8Array,
    N: number,
    seed: number,
    season: Season,
    duchyColors: number[],  // ABGR packed per duchy
    state: GameState,
  ) {
    this._N = N;
    this._season = season;
    this._state = state;

    for (const rd of renderData) {
      const rng = mulberry32(seed ^ (rd.duchyIndex * 0x4c3b + 0xface));
      const bodyColor = duchyColors[rd.duchyIndex] ?? packABGR(0x80, 0x60, 0x40);

      // Find nearest tree to the hut
      let targetPx = 0, targetPy = 0, hasTarget = false;
      let bestDist = Infinity;
      const searchRadius = 40;

      for (let dy = -searchRadius; dy <= searchRadius; dy++) {
        for (let dx = -searchRadius; dx <= searchRadius; dx++) {
          const tx = rd.hutPx + dx;
          const ty = rd.hutPy + dy;
          if (tx < 0 || tx >= N || ty < 0 || ty >= N) continue;
          const tIdx = ty * N + tx;
          if (!treeMask[tIdx]) continue;
          if (state.removedTrees.has(tIdx)) continue;
          const dist = dx * dx + dy * dy;
          // Don't pick trees too close to hut
          if (dist < 10 * 10) continue;
          if (dist < bestDist) {
            bestDist = dist;
            targetPx = tx;
            targetPy = ty;
            hasTarget = true;
          }
        }
      }

      this._workers.push({
        data: rd,
        bodyColor,
        targetPx,
        targetPy,
        hasTarget,
        smokeParticles: [],
        lastSmokeSpawn: 0,
      });
    }
  }

  animate(pixels: Uint32Array, timeMs: number): void {
    const N = this._N;
    const ext = this.extrusionMap;

    // 1. Restore dirty pixels from last frame
    for (const d of this._dirty) {
      pixels[d.screenIdx] = d.color;
    }
    this._dirty = [];
    this._savedThisFrame = new Set<number>();

    // 2. Animate each woodcutter
    for (const w of this._workers) {
      // Smoke always animates (even in winter)
      this._animateSmoke(pixels, w, timeMs, N, ext);

      // Water wheel always spins (sawmill only)
      if (w.data.variant === 'sawmill') {
        this._animateWheel(pixels, w, timeMs, N, ext);
      }

      // Worker rests in winter
      if (this._season === Season.Winter) continue;

      // Worker animation
      if (w.hasTarget) {
        this._animateWorker(pixels, w, timeMs, N, ext);
      }
    }
  }

  // ── Smoke animation ──────────────────────────────────────────────────────
  private _animateSmoke(
    pixels: Uint32Array, w: LumberjackState,
    timeMs: number, N: number, ext: Int16Array | null,
  ): void {
    // Spawn new particles
    if (timeMs - w.lastSmokeSpawn > SMOKE_SPAWN_INTERVAL) {
      w.smokeParticles.push({
        x: w.data.chimneyPx + (Math.random() < 0.5 ? 0 : 1),
        y: w.data.chimneyPy,
        age: 0,
      });
      w.lastSmokeSpawn = timeMs;
      // Limit particles
      if (w.smokeParticles.length > 5) w.smokeParticles.shift();
    }

    // Update and render particles
    for (let i = w.smokeParticles.length - 1; i >= 0; i--) {
      const p = w.smokeParticles[i];
      p.age += 16; // ~60fps
      if (p.age > SMOKE_MAX_AGE) {
        w.smokeParticles.splice(i, 1);
        continue;
      }

      const py = Math.round(p.y - p.age * SMOKE_RISE_SPEED);
      const px = Math.round(p.x + Math.sin(p.age * 0.003) * 0.8);
      if (px < 0 || px >= N || py < 0 || py >= N) continue;

      const srcIdx = py * N + px;
      const screenIdx = this._screenIdx(srcIdx, N, ext);
      if (screenIdx < 0) continue;

      if (!this._savedThisFrame.has(screenIdx)) {
        this._dirty.push({ screenIdx, color: pixels[screenIdx] });
        this._savedThisFrame.add(screenIdx);
      }

      // Alpha-blend white smoke
      const existing = pixels[screenIdx];
      const alpha = Math.max(0.1, 0.55 * (1 - p.age / SMOKE_MAX_AGE));
      const er = existing & 0xff;
      const eg = (existing >> 8) & 0xff;
      const eb = (existing >> 16) & 0xff;
      const nr = Math.round(er + (0xe8 - er) * alpha);
      const ng = Math.round(eg + (0xe4 - eg) * alpha);
      const nb = Math.round(eb + (0xe0 - eb) * alpha);
      pixels[screenIdx] = (255 << 24) | (nb << 16) | (ng << 8) | nr;
    }
  }

  // ── Water wheel animation ────────────────────────────────────────────────
  private _animateWheel(
    pixels: Uint32Array, w: LumberjackState,
    timeMs: number, N: number, ext: Int16Array | null,
  ): void {
    const frame = Math.floor(timeMs / 200) % WHEEL_FRAMES.length;
    const data = WHEEL_FRAMES[frame];
    const cx = w.data.wheelPx;
    const cy = w.data.wheelPy;
    const startX = cx - Math.floor(WHEEL_SIZE / 2);
    const startY = cy - Math.floor(WHEEL_SIZE / 2);

    for (let sy = 0; sy < WHEEL_SIZE; sy++) {
      for (let sx = 0; sx < WHEEL_SIZE; sx++) {
        const cell = data[sy * WHEEL_SIZE + sx];
        if (cell !== WH) continue;

        const px = startX + sx;
        const py = startY + sy;
        if (px < 0 || px >= N || py < 0 || py >= N) continue;

        const srcIdx = py * N + px;
        const screenIdx = this._screenIdx(srcIdx, N, ext);
        if (screenIdx < 0) continue;

        if (!this._savedThisFrame.has(screenIdx)) {
          this._dirty.push({ screenIdx, color: pixels[screenIdx] });
          this._savedThisFrame.add(screenIdx);
        }

        pixels[screenIdx] = WHEEL_COLORS[(sx + sy) & 1];
      }
    }
  }

  // ── Worker animation (walk out → chop → carry back → stack) ──────────────
  private _animateWorker(
    pixels: Uint32Array, w: LumberjackState,
    timeMs: number, N: number, ext: Int16Array | null,
  ): void {
    const cycleDur = w.data.variant === 'sawmill' ? SAWMILL_CYCLE : CYCLE_DURATION;
    const t = (timeMs % cycleDur) / cycleDur; // 0..1 within cycle

    let wx: number, wy: number;
    let facingRight: boolean;
    let carryingLog = false;

    const hx = w.data.hutPx;
    const hy = w.data.hutPy;
    const tx = w.targetPx;
    const ty = w.targetPy;

    if (t < IDLE_END) {
      // Idle at hut
      wx = hx + 1;
      wy = hy;
      facingRight = tx > hx;
    } else if (t < WALK_OUT_END) {
      // Walk to tree
      const progress = (t - IDLE_END) / (WALK_OUT_END - IDLE_END);
      wx = Math.round(hx + (tx - hx) * progress);
      wy = Math.round(hy + (ty - hy) * progress);
      facingRight = tx > hx;
    } else if (t < CHOP_END) {
      // Chopping at tree
      wx = tx;
      wy = ty;
      facingRight = hx > tx;
      // Flash effect at chop point
      const chopPhase = ((t - WALK_OUT_END) / (CHOP_END - WALK_OUT_END)) * 6;
      if (Math.floor(chopPhase) % 2 === 0) {
        // Flash white pixel at tree
        const flashX = tx + (facingRight ? -1 : 1);
        const flashY = ty - 1;
        if (flashX >= 0 && flashX < N && flashY >= 0 && flashY < N) {
          const fIdx = flashY * N + flashX;
          const fScreen = this._screenIdx(fIdx, N, ext);
          if (fScreen >= 0) {
            if (!this._savedThisFrame.has(fScreen)) {
              this._dirty.push({ screenIdx: fScreen, color: pixels[fScreen] });
              this._savedThisFrame.add(fScreen);
            }
            pixels[fScreen] = packABGR(0xff, 0xff, 0xe0);
          }
        }
      }
    } else if (t < CARRY_END) {
      // Carry log back
      const progress = (t - CHOP_END) / (CARRY_END - CHOP_END);
      wx = Math.round(tx + (hx - tx) * progress);
      wy = Math.round(ty + (hy - ty) * progress);
      facingRight = hx > tx;
      carryingLog = true;
    } else {
      // Stacking at hut
      wx = hx + 1;
      wy = hy;
      facingRight = false;
    }

    // Clamp to bounds
    wx = Math.max(1, Math.min(N - 3, wx));
    wy = Math.max(3, Math.min(N - 1, wy));

    // Stamp person sprite
    const sprite = facingRight ? PERSON_RIGHT : PERSON_LEFT;
    const colors = [PERSON_HEAD, w.bodyColor, PERSON_LEG];

    for (let row = 0; row < sprite.h; row++) {
      for (let col = 0; col < sprite.w; col++) {
        const cell = sprite.cells[row][col];
        if (cell === _) continue;

        const px = wx + col;
        const py = wy - 2 + row; // person is 3px tall, anchor at feet
        if (px < 0 || px >= N || py < 0 || py >= N) continue;

        const srcIdx = py * N + px;
        const screenIdx = this._screenIdx(srcIdx, N, ext);
        if (screenIdx < 0) continue;

        if (!this._savedThisFrame.has(screenIdx)) {
          this._dirty.push({ screenIdx, color: pixels[screenIdx] });
          this._savedThisFrame.add(screenIdx);
        }
        pixels[screenIdx] = colors[cell];
      }
    }

    // Log above head when carrying
    if (carryingLog) {
      const logY = wy - 3;
      for (let lx = wx; lx < wx + 2; lx++) {
        if (lx < 0 || lx >= N || logY < 0 || logY >= N) continue;
        const srcIdx = logY * N + lx;
        const screenIdx = this._screenIdx(srcIdx, N, ext);
        if (screenIdx < 0) continue;
        if (!this._savedThisFrame.has(screenIdx)) {
          this._dirty.push({ screenIdx, color: pixels[screenIdx] });
          this._savedThisFrame.add(screenIdx);
        }
        pixels[screenIdx] = LOG_COLOR;
      }
    }
  }

  // ── Screen index helper (accounts for mountain extrusion) ────────────────
  private _screenIdx(srcIdx: number, N: number, ext: Int16Array | null): number {
    if (!ext) return srcIdx;
    const px = srcIdx % N;
    const py = (srcIdx - px) / N;
    const screenY = py - ext[srcIdx];
    if (screenY < 0 || screenY >= N) return -1;
    return screenY * N + px;
  }
}
