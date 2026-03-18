/**
 * WoodcutterAnimator — per-frame animation for woodcutter buildings.
 *
 * Each woodcutter has:
 *  - A lumberjack who walks to a tree, chops it, the tree falls over,
 *    workers process the downed tree, then carry the log back
 *  - Chimney smoke puffs rising
 *  - (Sawmill) Water wheel always spinning
 *
 * Workers never walk through rivers — targets are pre-filtered to same
 * side of the river as the hut.
 *
 * Follows the dirty-pixel save/restore pattern of GardenWorkerAnimator.
 */

import { mulberry32 } from './TopographyGenerator';
import { packABGR } from './TerrainPalettes';
import { Season } from '../state/Season';
import type { WoodcutterRenderData } from './WoodcutterRenderer';
import { WHEEL_FRAMES, WHEEL_SIZE, WH } from './WoodcutterRenderer';
import type { GameState } from '../state/GameState';
import type { PlacedTree } from './TreeRenderer';

// ── Person sprite (same as GardenWorkerAnimator) ───────────────────────────
const PERSON_HEAD = packABGR(0xc8, 0xa8, 0x80);
const PERSON_LEG  = packABGR(0x5a, 0x48, 0x38);
const LOG_COLOR   = packABGR(0x6e, 0x53, 0x40);
const TRUNK_COLOR = packABGR(0x8a, 0x78, 0x60);
const TRUNK_DARK  = packABGR(0x5a, 0x4a, 0x38);

const _  = -1;
const PERSON_RIGHT = { w: 2, h: 3, cells: [[0, _], [1, 1], [_, 2]] };
const PERSON_LEFT  = { w: 2, h: 3, cells: [[_, 0], [1, 1], [2, _]] };

// ── Timing (milliseconds) ──────────────────────────────────────────────────
const CYCLE_DURATION = 16000;  // 16s per chop cycle for manual
const SAWMILL_CYCLE  = 7000;   // 7s per cycle for sawmill

// Phase breakdown within a cycle (as fractions)
const WALK_OUT_END   = 0.20;
const CHOP_END       = 0.30;
const TREE_FALL_END  = 0.38;
const WORK_TREE_END  = 0.55;
const CARRY_END      = 0.80;
// 0.80-1.0 = idle at hut

// ── Smoke particle ─────────────────────────────────────────────────────────
interface SmokeParticle {
  x: number;
  y: number;
  age: number;
}

const SMOKE_SPAWN_INTERVAL = 900;
const SMOKE_RISE_SPEED = 0.003;
const SMOKE_MAX_AGE = 2500;

// ── Wheel colors ───────────────────────────────────────────────────────────
const WHEEL_COLORS = [
  packABGR(0x5a, 0x48, 0x30),
  packABGR(0x6e, 0x5c, 0x3e),
];

// ── Captured ground pixels behind a tree (for erasing the standing tree) ───
interface TreeFootprint {
  // screen pixel index → original ground color (before tree was drawn)
  pixels: Map<number, number>;
}

// ── Per-woodcutter state ───────────────────────────────────────────────────
interface LumberjackState {
  data: WoodcutterRenderData;
  bodyColor: number;
  // Current target (cycles through data.targets)
  currentTarget: number;
  // Per-target tree footprint for erasing the standing tree during fall
  treeFootprints: TreeFootprint[];
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

      // Capture the ground pixels behind each target tree so we can erase
      // the standing tree during the fall animation
      const treeFootprints: TreeFootprint[] = [];
      for (const tree of rd.targets) {
        const fp: TreeFootprint = { pixels: new Map() };
        const { w, h, data, flipped } = tree;
        const startX = tree.px - Math.floor(w / 2);
        const startY = tree.py - h + 1;

        // First pass: read what's behind the tree sprite right now (tree pixels on top of ground).
        // We need the ground color, so we'll re-stamp it from the ground layer.
        // Since we can't easily get the ground, we snapshot the tree footprint as-is,
        // then when we erase, we draw the tree sprite's shadow footprint area with
        // the surrounding average ground color.
        // Simpler approach: snapshot pixels in a ring around the tree and use median
        // as the ground color for erasure.

        // Sample ground color from pixels just outside the tree footprint
        let groundR = 0, groundG = 0, groundB = 0, groundCount = 0;
        for (let sy = -1; sy <= h; sy++) {
          for (let sx = -1; sx <= w; sx++) {
            // Only sample the border pixels (just outside the sprite)
            if (sx >= 0 && sx < w && sy >= 0 && sy < h) {
              const srcX = flipped ? (w - 1 - sx) : sx;
              if (data[sy * w + srcX] !== 0) continue; // skip non-transparent tree pixels
            }
            const px = startX + sx;
            const py = startY + sy;
            if (px < 0 || px >= N || py < 0 || py >= N) continue;
            const c = pixels[py * N + px];
            groundR += c & 0xff;
            groundG += (c >> 8) & 0xff;
            groundB += (c >> 16) & 0xff;
            groundCount++;
          }
        }
        const avgGround = groundCount > 0
          ? (255 << 24)
            | (Math.round(groundB / groundCount) << 16)
            | (Math.round(groundG / groundCount) << 8)
            | Math.round(groundR / groundCount)
          : pixels[tree.py * N + tree.px]; // fallback

        // Record all non-transparent tree pixels → ground color
        for (let sy = 0; sy < h; sy++) {
          for (let sx = 0; sx < w; sx++) {
            const srcX = flipped ? (w - 1 - sx) : sx;
            if (data[sy * w + srcX] === 0) continue;
            const px = startX + sx;
            const py = startY + sy;
            if (px < 0 || px >= N || py < 0 || py >= N) continue;
            const screenIdx = py * N + px;
            fp.pixels.set(screenIdx, avgGround);
          }
        }

        treeFootprints.push(fp);
      }

      this._workers.push({
        data: rd,
        bodyColor,
        currentTarget: Math.floor(rng() * Math.max(1, rd.targets.length)),
        treeFootprints,
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
      // Smoke always animates
      this._animateSmoke(pixels, w, timeMs, N, ext);

      // Water wheel always spins (sawmill)
      if (w.data.variant === 'sawmill') {
        this._animateWheel(pixels, w, timeMs, N, ext);
      }

      // Workers rest in winter
      if (this._season === Season.Winter) continue;

      // Worker + tree animation
      if (w.data.targets.length > 0) {
        this._animateWorkerAndTree(pixels, w, timeMs, N, ext);
      }
    }
  }

  // ── Smoke animation ──────────────────────────────────────────────────────
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

      this._saveDirty(pixels, screenIdx);

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

        this._saveDirty(pixels, screenIdx);
        pixels[screenIdx] = WHEEL_COLORS[(sx + sy) & 1];
      }
    }
  }

  // ── Worker + tree falling animation ──────────────────────────────────────
  private _animateWorkerAndTree(
    pixels: Uint32Array, w: LumberjackState,
    timeMs: number, N: number, ext: Int16Array | null,
  ): void {
    const cycleDur = w.data.variant === 'sawmill' ? SAWMILL_CYCLE : CYCLE_DURATION;
    // Each target gets its own cycle offset for sawmill (staggered)
    const numTargets = w.data.targets.length;
    const totalDur = cycleDur * numTargets;
    const globalT = timeMs % totalDur;
    const cycleIdx = Math.floor(globalT / cycleDur) % numTargets;
    const t = (globalT % cycleDur) / cycleDur;

    const targetIdx = cycleIdx % numTargets;
    const tree = w.data.targets[targetIdx];
    const footprint = w.treeFootprints[targetIdx];
    const hx = w.data.hutPx;
    const hy = w.data.hutPy;
    const tx = tree.px;
    const ty = tree.py;

    // Erase the standing tree once chopping begins (replace with ground color)
    const treeIsDown = t >= CHOP_END;
    if (treeIsDown && footprint) {
      for (const [screenIdx, groundColor] of footprint.pixels) {
        this._saveDirty(pixels, screenIdx);
        pixels[screenIdx] = groundColor;
      }
    }

    let wx: number, wy: number;
    let facingRight: boolean;
    let carryingLog = false;

    if (t < WALK_OUT_END) {
      // Walk to tree
      const progress = t / WALK_OUT_END;
      wx = Math.round(hx + (tx - hx) * progress);
      wy = Math.round(hy + (ty - hy) * progress);
      facingRight = tx > hx;
    } else if (t < CHOP_END) {
      // Chopping at tree — stand next to it
      wx = tx + (tx > hx ? -2 : 2);
      wy = ty;
      facingRight = tx > hx;

      // Axe flash
      const chopPhase = ((t - WALK_OUT_END) / (CHOP_END - WALK_OUT_END)) * 8;
      if (Math.floor(chopPhase) % 2 === 0) {
        const flashX = tx;
        const flashY = ty - 2;
        if (flashX >= 0 && flashX < N && flashY >= 0 && flashY < N) {
          const fIdx = flashY * N + flashX;
          const fScreen = this._screenIdx(fIdx, N, ext);
          if (fScreen >= 0) {
            this._saveDirty(pixels, fScreen);
            pixels[fScreen] = packABGR(0xff, 0xff, 0xe0);
          }
        }
      }
    } else if (t < TREE_FALL_END) {
      // Tree falls over! Worker steps back and watches
      wx = tx + (tx > hx ? -3 : 3);
      wy = ty;
      facingRight = tx > hx;

      // Animate the actual tree sprite falling (rotating from vertical to horizontal)
      const fallProgress = (t - CHOP_END) / (TREE_FALL_END - CHOP_END);
      this._drawFallingTree(pixels, N, ext, tree, fallProgress, tx > hx);
    } else if (t < WORK_TREE_END) {
      // Workers process the fallen tree (standing at downed trunk)
      const trunkX = tx + (tx > hx ? 3 : -3);
      wx = trunkX;
      wy = ty + 1;
      facingRight = tx > hx;

      // Draw the actual tree sprite lying on the ground
      this._drawDownedTree(pixels, N, ext, tree, tx > hx);

      // Second worker (offset slightly)
      this._stampPerson(pixels, N, ext, trunkX + (tx > hx ? 2 : -2), ty + 1,
        !facingRight, w.bodyColor);

      // Occasional chop flash on trunk
      const workPhase = ((t - TREE_FALL_END) / (WORK_TREE_END - TREE_FALL_END)) * 6;
      if (Math.floor(workPhase) % 3 === 0) {
        const fX = tx + (tx > hx ? 1 : -1);
        const fY = ty;
        if (fX >= 0 && fX < N && fY >= 0 && fY < N) {
          const fIdx = fY * N + fX;
          const fScreen = this._screenIdx(fIdx, N, ext);
          if (fScreen >= 0) {
            this._saveDirty(pixels, fScreen);
            pixels[fScreen] = packABGR(0xff, 0xee, 0xcc);
          }
        }
      }
    } else if (t < CARRY_END) {
      // Carry log back to hut
      const progress = (t - WORK_TREE_END) / (CARRY_END - WORK_TREE_END);
      wx = Math.round(tx + (hx - tx) * progress);
      wy = Math.round(ty + (hy - ty) * progress);
      facingRight = hx > tx;
      carryingLog = true;
    } else {
      // Idle at hut
      wx = hx + 1;
      wy = hy;
      facingRight = false;
    }

    // Clamp
    wx = Math.max(1, Math.min(N - 3, wx));
    wy = Math.max(3, Math.min(N - 1, wy));

    // Stamp main worker
    this._stampPerson(pixels, N, ext, wx, wy, facingRight, w.bodyColor);

    // Log above head when carrying
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

  // ── Draw actual tree sprite falling from vertical to horizontal ──────────
  private _drawFallingTree(
    pixels: Uint32Array, N: number, ext: Int16Array | null,
    tree: PlacedTree, progress: number, fallsRight: boolean,
  ): void {
    const { w, h, data, flipped, canopyColors, trunkColors } = tree;
    const angle = progress * Math.PI / 2; // 0 = vertical, PI/2 = horizontal
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const dir = fallsRight ? 1 : -1;

    // Tree origin: trunk base at (tree.px, tree.py), sprite extends upward
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const srcX = flipped ? (w - 1 - sx) : sx;
        const cell = data[sy * w + srcX];
        if (cell === 0) continue;

        // Original offset from trunk base
        const ox = sx - Math.floor(w / 2);
        const oy = -(h - 1 - sy); // negative = upward

        // Rotate around trunk base: pivot at (0,0)
        const rx = Math.round(ox + oy * sinA * dir);
        const ry = Math.round(oy * cosA);

        const px = tree.px + rx;
        const py = tree.py + ry;
        if (px < 0 || px >= N || py < 0 || py >= N) continue;

        const srcIdx = py * N + px;
        const screenIdx = this._screenIdx(srcIdx, N, ext);
        if (screenIdx < 0) continue;

        this._saveDirty(pixels, screenIdx);

        // Use actual tree colors
        if (cell === 1) { // trunk
          pixels[screenIdx] = trunkColors[0] ?? TRUNK_COLOR;
        } else { // canopy
          pixels[screenIdx] = canopyColors[2] ?? canopyColors[0] ?? TRUNK_COLOR;
        }
      }
    }
  }

  // ── Draw actual tree sprite lying on the ground (90° rotated) ────────────
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

        // Fully rotated 90°: vertical becomes horizontal
        const rx = Math.round(oy * dir);
        const ry = Math.round(ox);

        const px = tree.px + rx;
        const py = tree.py + ry;
        if (px < 0 || px >= N || py < 0 || py >= N) continue;

        const srcIdx = py * N + px;
        const screenIdx = this._screenIdx(srcIdx, N, ext);
        if (screenIdx < 0) continue;

        this._saveDirty(pixels, screenIdx);

        if (cell === 1) {
          pixels[screenIdx] = trunkColors[0] ?? TRUNK_COLOR;
        } else {
          pixels[screenIdx] = canopyColors[2] ?? canopyColors[0] ?? TRUNK_COLOR;
        }
      }
    }
  }

  // ── Stamp a person sprite at position ────────────────────────────────────
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
