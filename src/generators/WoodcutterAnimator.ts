/**
 * WoodcutterAnimator — per-frame animation for woodcutter buildings.
 *
 * Season flow per target tree:
 *  1. Walk to tree, chop it, tree falls (with full sprite), process into log
 *     — this happens ONCE at the start
 *  2. Log remains on ground for the rest of the season
 *  3. Worker makes repeated trips: walk to log → pick up lumber → carry back
 *
 * Sawmill: 3 targets, staggered — each gets its own fell-then-haul sequence.
 *
 * Chimney smoke puffs always. Water wheel always spins (sawmill).
 */

import { mulberry32 } from './TopographyGenerator';
import { packABGR } from './TerrainPalettes';
import { Season } from '../state/Season';
import type { WoodcutterRenderData } from './WoodcutterRenderer';
import { WHEEL_FRAMES, WHEEL_SIZE, WH } from './WoodcutterRenderer';
import type { GameState } from '../state/GameState';
import type { PlacedTree } from './TreeRenderer';

// ── Person sprite ──────────────────────────────────────────────────────────
const PERSON_HEAD = packABGR(0xc8, 0xa8, 0x80);
const PERSON_LEG  = packABGR(0x5a, 0x48, 0x38);
const LOG_COLOR   = packABGR(0x6e, 0x53, 0x40);
const TRUNK_COLOR = packABGR(0x8a, 0x78, 0x60);

const _  = -1;
const PERSON_RIGHT = { w: 2, h: 3, cells: [[0, _], [1, 1], [_, 2]] };
const PERSON_LEFT  = { w: 2, h: 3, cells: [[_, 0], [1, 1], [2, _]] };

// ── Timing ─────────────────────────────────────────────────────────────────
// Total season animation = FELL_DURATION + N × HAUL_DURATION
// The felling happens once, then hauling loops for the remainder.
const FELL_DURATION  = 12000;  // 12s: walk + chop + fall + process
const HAUL_DURATION  = 8000;   // 8s per haul trip

// Felling sub-phases (fractions of FELL_DURATION)
const FELL_WALK     = 0.25;  // walk to tree
const FELL_CHOP     = 0.40;  // chopping
const FELL_FALL     = 0.55;  // tree falls over
const FELL_WORK     = 0.80;  // process into log (strip branches)
// 0.80-1.0 = first haul pickup (grab log, transition to haul loop)

// Haul sub-phases (fractions of HAUL_DURATION)
const HAUL_WALK_OUT = 0.25;  // walk to log
const HAUL_PICKUP   = 0.35;  // bend down, grab
const HAUL_CARRY    = 0.75;  // carry back
// 0.75-1.0 = drop at hut, idle

// ── Smoke ──────────────────────────────────────────────────────────────────
interface SmokeParticle { x: number; y: number; age: number; }
const SMOKE_SPAWN_INTERVAL = 900;
const SMOKE_RISE_SPEED = 0.003;
const SMOKE_MAX_AGE = 2500;

// ── Wheel colors ───────────────────────────────────────────────────────────
const WHEEL_COLORS = [
  packABGR(0x5a, 0x48, 0x30),
  packABGR(0x6e, 0x5c, 0x3e),
];

// ── Ground behind tree (for erasing standing tree) ─────────────────────────
interface TreeFootprint {
  pixels: Map<number, number>; // screenIdx → ground color
}

// ── Per-woodcutter ─────────────────────────────────────────────────────────
interface LumberjackState {
  data: WoodcutterRenderData;
  bodyColor: number;
  treeFootprints: TreeFootprint[];
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
    pixels: Uint32Array,
    N: number,
    seed: number,
    season: Season,
    duchyColors: number[],
    state: GameState,
  ) {
    this._N = N;
    this._season = season;
    this._state = state;

    for (const rd of renderData) {
      const rng = mulberry32(seed ^ (rd.duchyIndex * 0x4c3b + 0xface));
      const bodyColor = duchyColors[rd.duchyIndex] ?? packABGR(0x80, 0x60, 0x40);

      // Capture ground pixels behind each target tree
      const treeFootprints: TreeFootprint[] = [];
      for (const tree of rd.targets) {
        const fp: TreeFootprint = { pixels: new Map() };
        const { w, h, data, flipped } = tree;
        const startX = tree.px - Math.floor(w / 2);
        const startY = tree.py - h + 1;

        // Sample ground color from transparent/border pixels around the sprite
        let gR = 0, gG = 0, gB = 0, gN = 0;
        for (let sy = -1; sy <= h; sy++) {
          for (let sx = -1; sx <= w; sx++) {
            if (sx >= 0 && sx < w && sy >= 0 && sy < h) {
              const srcX = flipped ? (w - 1 - sx) : sx;
              if (data[sy * w + srcX] !== 0) continue;
            }
            const px = startX + sx;
            const py = startY + sy;
            if (px < 0 || px >= N || py < 0 || py >= N) continue;
            const c = pixels[py * N + px];
            gR += c & 0xff;
            gG += (c >> 8) & 0xff;
            gB += (c >> 16) & 0xff;
            gN++;
          }
        }
        const avg = gN > 0
          ? (255 << 24) | (Math.round(gB / gN) << 16) | (Math.round(gG / gN) << 8) | Math.round(gR / gN)
          : pixels[tree.py * N + tree.px];

        for (let sy = 0; sy < h; sy++) {
          for (let sx = 0; sx < w; sx++) {
            const srcX = flipped ? (w - 1 - sx) : sx;
            if (data[sy * w + srcX] === 0) continue;
            const px = startX + sx;
            const py = startY + sy;
            if (px < 0 || px >= N || py < 0 || py >= N) continue;
            fp.pixels.set(py * N + px, avg);
          }
        }
        treeFootprints.push(fp);
      }

      this._workers.push({
        data: rd,
        bodyColor,
        treeFootprints,
        smokeParticles: [],
        lastSmokeSpawn: 0,
      });
    }
  }

  animate(pixels: Uint32Array, timeMs: number): void {
    const N = this._N;
    const ext = this.extrusionMap;

    for (const d of this._dirty) pixels[d.screenIdx] = d.color;
    this._dirty = [];
    this._savedThisFrame = new Set<number>();

    for (const w of this._workers) {
      this._animateSmoke(pixels, w, timeMs, N, ext);
      if (w.data.variant === 'sawmill') this._animateWheel(pixels, w, timeMs, N, ext);
      if (this._season === Season.Winter) continue;
      if (w.data.targets.length > 0) this._animateTargets(pixels, w, timeMs, N, ext);
    }
  }

  // ── Main target animation — fell once, then haul loop ────────────────────
  private _animateTargets(
    pixels: Uint32Array, w: LumberjackState,
    timeMs: number, N: number, ext: Int16Array | null,
  ): void {
    const targets = w.data.targets;
    const numTargets = targets.length;

    // Each target gets a staggered slot: fell + multiple hauls
    // Total per-target time = FELL_DURATION + 3 × HAUL_DURATION
    const haulTripsPerTarget = 3;
    const targetDur = FELL_DURATION + haulTripsPerTarget * HAUL_DURATION;
    const totalDur = targetDur * numTargets;
    const globalT = timeMs % totalDur;

    const targetIdx = Math.min(Math.floor(globalT / targetDur), numTargets - 1);
    const localT = globalT - targetIdx * targetDur; // ms into this target's sequence

    const tree = targets[targetIdx];
    const footprint = w.treeFootprints[targetIdx];
    const hx = w.data.hutPx;
    const hy = w.data.hutPy;
    const tx = tree.px;
    const ty = tree.py;
    const fallsRight = tx > hx;

    // Once felling is past chop phase, erase the standing tree
    if (localT >= FELL_DURATION * FELL_CHOP && footprint) {
      for (const [screenIdx, groundColor] of footprint.pixels) {
        this._saveDirty(pixels, screenIdx);
        pixels[screenIdx] = groundColor;
      }
    }

    // After the tree is processed, always show the log on the ground
    if (localT >= FELL_DURATION * FELL_WORK) {
      this._drawLog(pixels, N, ext, tx, ty, fallsRight, tree);
    }

    let wx: number, wy: number;
    let facingRight: boolean;
    let carryingLog = false;

    if (localT < FELL_DURATION) {
      // ─── Felling phase ───────────────────────────────────────────────
      const ft = localT / FELL_DURATION;

      if (ft < FELL_WALK) {
        // Walk to tree
        const p = ft / FELL_WALK;
        wx = Math.round(hx + (tx - hx) * p);
        wy = Math.round(hy + (ty - hy) * p);
        facingRight = fallsRight;
      } else if (ft < FELL_CHOP) {
        // Chopping
        wx = tx + (fallsRight ? -2 : 2);
        wy = ty;
        facingRight = fallsRight;
        // Axe flash
        const phase = ((ft - FELL_WALK) / (FELL_CHOP - FELL_WALK)) * 8;
        if (Math.floor(phase) % 2 === 0) {
          this._flash(pixels, N, ext, tx, ty - 2);
        }
      } else if (ft < FELL_FALL) {
        // Tree falls
        wx = tx + (fallsRight ? -3 : 3);
        wy = ty;
        facingRight = fallsRight;
        const fallP = (ft - FELL_CHOP) / (FELL_FALL - FELL_CHOP);
        this._drawFallingTree(pixels, N, ext, tree, fallP, fallsRight);
      } else if (ft < FELL_WORK) {
        // Process downed tree — two workers at it
        wx = tx + (fallsRight ? 3 : -3);
        wy = ty + 1;
        facingRight = fallsRight;
        this._drawDownedTree(pixels, N, ext, tree, fallsRight);
        this._stampPerson(pixels, N, ext, wx + (fallsRight ? 2 : -2), ty + 1, !facingRight, w.bodyColor);
        // Work flashes
        const phase = ((ft - FELL_FALL) / (FELL_WORK - FELL_FALL)) * 6;
        if (Math.floor(phase) % 3 === 0) {
          this._flash(pixels, N, ext, tx + (fallsRight ? 1 : -1), ty);
        }
      } else {
        // First haul — pick up from log
        wx = tx + (fallsRight ? 2 : -2);
        wy = ty;
        facingRight = !fallsRight;
      }
    } else {
      // ─── Hauling loop ────────────────────────────────────────────────
      const haulT = localT - FELL_DURATION;
      const tripT = haulT % HAUL_DURATION;
      const ht = tripT / HAUL_DURATION;

      if (ht < HAUL_WALK_OUT) {
        // Walk to log
        const p = ht / HAUL_WALK_OUT;
        wx = Math.round(hx + (tx - hx) * p);
        wy = Math.round(hy + (ty - hy) * p);
        facingRight = fallsRight;
      } else if (ht < HAUL_PICKUP) {
        // At log, bending to pick up
        wx = tx + (fallsRight ? 2 : -2);
        wy = ty;
        facingRight = !fallsRight;
      } else if (ht < HAUL_CARRY) {
        // Carry lumber back
        const p = (ht - HAUL_PICKUP) / (HAUL_CARRY - HAUL_PICKUP);
        wx = Math.round(tx + (hx - tx) * p);
        wy = Math.round(ty + (hy - ty) * p);
        facingRight = hx > tx;
        carryingLog = true;
      } else {
        // Drop at hut, idle
        wx = hx + 1;
        wy = hy;
        facingRight = false;
      }
    }

    wx = Math.max(1, Math.min(N - 3, wx!));
    wy = Math.max(3, Math.min(N - 1, wy!));

    this._stampPerson(pixels, N, ext, wx, wy, facingRight!, w.bodyColor);

    if (carryingLog) {
      const logY = wy - 3;
      for (let lx = wx; lx < wx + 3; lx++) {
        if (lx < 0 || lx >= N || logY < 0 || logY >= N) continue;
        const srcIdx = logY * N + lx;
        const screenIdx = this._screenIdx(srcIdx, N, ext);
        if (screenIdx < 0) continue;
        this._saveDirty(pixels, screenIdx);
        pixels[screenIdx] = LOG_COLOR;
      }
    }
  }

  // ── Draw a persistent log on the ground (just trunk, no canopy) ──────────
  private _drawLog(
    pixels: Uint32Array, N: number, ext: Int16Array | null,
    tx: number, ty: number, liesRight: boolean, tree: PlacedTree,
  ): void {
    // Horizontal log: length based on tree height, but just the trunk portion
    const logLen = Math.min(6, Math.max(3, Math.floor(tree.h * 0.3)));
    const dir = liesRight ? 1 : -1;
    const colors = [tree.trunkColors[1] ?? TRUNK_COLOR, tree.trunkColors[0] ?? LOG_COLOR];

    for (let i = 0; i < logLen; i++) {
      const px = tx + i * dir;
      const py0 = ty;
      // Log is 1-2px tall
      for (let dy = 0; dy < 2; dy++) {
        const py = py0 + dy;
        if (px < 0 || px >= N || py < 0 || py >= N) continue;
        const srcIdx = py * N + px;
        const screenIdx = this._screenIdx(srcIdx, N, ext);
        if (screenIdx < 0) continue;
        this._saveDirty(pixels, screenIdx);
        pixels[screenIdx] = colors[(i + dy) & 1];
      }
    }
  }

  // ── Flash helper ─────────────────────────────────────────────────────────
  private _flash(
    pixels: Uint32Array, N: number, ext: Int16Array | null,
    fx: number, fy: number,
  ): void {
    if (fx < 0 || fx >= N || fy < 0 || fy >= N) return;
    const idx = fy * N + fx;
    const si = this._screenIdx(idx, N, ext);
    if (si < 0) return;
    this._saveDirty(pixels, si);
    pixels[si] = packABGR(0xff, 0xff, 0xe0);
  }

  // ── Falling tree (full sprite rotating) ──────────────────────────────────
  private _drawFallingTree(
    pixels: Uint32Array, N: number, ext: Int16Array | null,
    tree: PlacedTree, progress: number, fallsRight: boolean,
  ): void {
    const { w, h, data, flipped, canopyColors, trunkColors } = tree;
    const angle = progress * Math.PI / 2;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const dir = fallsRight ? 1 : -1;

    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const srcX = flipped ? (w - 1 - sx) : sx;
        const cell = data[sy * w + srcX];
        if (cell === 0) continue;
        const ox = sx - Math.floor(w / 2);
        const oy = -(h - 1 - sy);
        const rx = Math.round(ox + oy * sinA * dir);
        const ry = Math.round(oy * cosA);
        const px = tree.px + rx;
        const py = tree.py + ry;
        if (px < 0 || px >= N || py < 0 || py >= N) continue;
        const srcIdx = py * N + px;
        const screenIdx = this._screenIdx(srcIdx, N, ext);
        if (screenIdx < 0) continue;
        this._saveDirty(pixels, screenIdx);
        pixels[screenIdx] = cell === 1
          ? (trunkColors[0] ?? TRUNK_COLOR)
          : (canopyColors[2] ?? canopyColors[0] ?? TRUNK_COLOR);
      }
    }
  }

  // ── Downed tree (full sprite 90° rotated, shown briefly during processing)
  private _drawDownedTree(
    pixels: Uint32Array, N: number, ext: Int16Array | null,
    tree: PlacedTree, liesRight: boolean,
  ): void {
    const { w, h, data, flipped, canopyColors, trunkColors } = tree;
    const dir = liesRight ? 1 : -1;

    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const srcX = flipped ? (w - 1 - sx) : sx;
        const cell = data[sy * w + srcX];
        if (cell === 0) continue;
        const ox = sx - Math.floor(w / 2);
        const oy = -(h - 1 - sy);
        const rx = Math.round(oy * dir);
        const ry = Math.round(ox);
        const px = tree.px + rx;
        const py = tree.py + ry;
        if (px < 0 || px >= N || py < 0 || py >= N) continue;
        const srcIdx = py * N + px;
        const screenIdx = this._screenIdx(srcIdx, N, ext);
        if (screenIdx < 0) continue;
        this._saveDirty(pixels, screenIdx);
        pixels[screenIdx] = cell === 1
          ? (trunkColors[0] ?? TRUNK_COLOR)
          : (canopyColors[2] ?? canopyColors[0] ?? TRUNK_COLOR);
      }
    }
  }

  // ── Smoke ────────────────────────────────────────────────────────────────
  private _animateSmoke(
    pixels: Uint32Array, w: LumberjackState,
    timeMs: number, N: number, ext: Int16Array | null,
  ): void {
    if (timeMs - w.lastSmokeSpawn > SMOKE_SPAWN_INTERVAL) {
      w.smokeParticles.push({
        x: w.data.chimneyPx + (Math.random() < 0.5 ? 0 : 1),
        y: w.data.chimneyPy,
        age: 0,
      });
      w.lastSmokeSpawn = timeMs;
      if (w.smokeParticles.length > 5) w.smokeParticles.shift();
    }
    for (let i = w.smokeParticles.length - 1; i >= 0; i--) {
      const p = w.smokeParticles[i];
      p.age += 16;
      if (p.age > SMOKE_MAX_AGE) { w.smokeParticles.splice(i, 1); continue; }
      const py = Math.round(p.y - p.age * SMOKE_RISE_SPEED);
      const px = Math.round(p.x + Math.sin(p.age * 0.003) * 0.8);
      if (px < 0 || px >= N || py < 0 || py >= N) continue;
      const srcIdx = py * N + px;
      const screenIdx = this._screenIdx(srcIdx, N, ext);
      if (screenIdx < 0) continue;
      this._saveDirty(pixels, screenIdx);
      const existing = pixels[screenIdx];
      const alpha = Math.max(0.1, 0.55 * (1 - p.age / SMOKE_MAX_AGE));
      const er = existing & 0xff;
      const eg = (existing >> 8) & 0xff;
      const eb = (existing >> 16) & 0xff;
      pixels[screenIdx] = (255 << 24)
        | (Math.round(eb + (0xe0 - eb) * alpha) << 16)
        | (Math.round(eg + (0xe4 - eg) * alpha) << 8)
        | Math.round(er + (0xe8 - er) * alpha);
    }
  }

  // ── Wheel ────────────────────────────────────────────────────────────────
  private _animateWheel(
    pixels: Uint32Array, w: LumberjackState,
    timeMs: number, N: number, ext: Int16Array | null,
  ): void {
    const frame = Math.floor(timeMs / 200) % WHEEL_FRAMES.length;
    const frameData = WHEEL_FRAMES[frame];
    const cx = w.data.wheelPx;
    const cy = w.data.wheelPy;
    const startX = cx - Math.floor(WHEEL_SIZE / 2);
    const startY = cy - Math.floor(WHEEL_SIZE / 2);
    for (let sy = 0; sy < WHEEL_SIZE; sy++) {
      for (let sx = 0; sx < WHEEL_SIZE; sx++) {
        if (frameData[sy * WHEEL_SIZE + sx] !== WH) continue;
        const px = startX + sx;
        const py = startY + sy;
        if (px < 0 || px >= N || py < 0 || py >= N) continue;
        const srcIdx = py * N + px;
        const screenIdx = this._screenIdx(srcIdx, N, ext);
        if (screenIdx < 0) continue;
        this._saveDirty(pixels, screenIdx);
        pixels[screenIdx] = WHEEL_COLORS[(sx + sy) & 1];
      }
    }
  }

  // ── Person sprite ────────────────────────────────────────────────────────
  private _stampPerson(
    pixels: Uint32Array, N: number, ext: Int16Array | null,
    wx: number, wy: number, facingRight: boolean, bodyColor: number,
  ): void {
    const sprite = facingRight ? PERSON_RIGHT : PERSON_LEFT;
    const colors = [PERSON_HEAD, bodyColor, PERSON_LEG];
    for (let row = 0; row < sprite.h; row++) {
      for (let col = 0; col < sprite.w; col++) {
        const cell = sprite.cells[row][col];
        if (cell === _) continue;
        const px = wx + col;
        const py = wy - 2 + row;
        if (px < 0 || px >= N || py < 0 || py >= N) continue;
        const srcIdx = py * N + px;
        const screenIdx = this._screenIdx(srcIdx, N, ext);
        if (screenIdx < 0) continue;
        this._saveDirty(pixels, screenIdx);
        pixels[screenIdx] = colors[cell];
      }
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
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
