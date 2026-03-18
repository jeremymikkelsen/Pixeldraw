/**
 * WoodcutterAnimator — per-frame animation for woodcutter buildings.
 *
 * Target trees stay in the static render (drawn by TreeRenderer).
 * On the first animate() call, the background behind each target tree
 * is captured. The animator then:
 *  1. Walk + chop phases — tree is already in static render, just animate worker
 *  2. Fall — erase standing tree (restore background), draw falling sprite
 *  3. Log/haul — erase standing tree, draw log + hauling worker
 *
 * Trees are added to removedTrees immediately after rendering so they
 * won't appear in the next season's static render.
 *
 * Chimney smoke always. Water wheel always spins (sawmill).
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
const FELL_DURATION  = 12000;  // 12s: walk + chop + fall + process
const HAUL_DURATION  = 8000;   // 8s per haul trip
const HAUL_TRIPS     = 3;

// Felling sub-phases (fractions of FELL_DURATION)
const FELL_WALK     = 0.25;
const FELL_CHOP     = 0.40;
const FELL_FALL     = 0.55;
const FELL_WORK     = 0.80;

// Haul sub-phases (fractions of HAUL_DURATION)
const HAUL_WALK_OUT = 0.25;
const HAUL_PICKUP   = 0.35;
const HAUL_CARRY    = 0.75;

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

// ── Per-woodcutter ─────────────────────────────────────────────────────────
interface LumberjackState {
  data: WoodcutterRenderData;
  bodyColor: number;
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

  /** Background pixels behind each target tree (captured once after static render). */
  private _treeBackgrounds = new Map<PlacedTree, { screenIdx: number; color: number }[]>();
  private _backgroundsCaptured = false;

  constructor(
    renderData: WoodcutterRenderData[],
    _pixels: Uint32Array,
    N: number,
    seed: number,
    season: Season,
    duchyColors: number[],
    _state: GameState,
  ) {
    this._N = N;
    this._season = season;

    for (const rd of renderData) {
      const bodyColor = duchyColors[rd.duchyIndex] ?? packABGR(0x80, 0x60, 0x40);
      this._workers.push({
        data: rd,
        bodyColor,
        smokeParticles: [],
        lastSmokeSpawn: 0,
      });
    }
  }

  animate(pixels: Uint32Array, timeMs: number): void {
    const N = this._N;
    const ext = this.extrusionMap;

    // Capture background behind each target tree once (after static render + extrusion)
    if (!this._backgroundsCaptured) {
      for (const w of this._workers) {
        for (const tree of w.data.targets) {
          this._captureTreeBackground(pixels, N, ext, tree);
        }
      }
      this._backgroundsCaptured = true;
    }

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

  // ── Main animation: fell once, then haul loop ────────────────────────────
  private _animateTargets(
    pixels: Uint32Array, w: LumberjackState,
    timeMs: number, N: number, ext: Int16Array | null,
  ): void {
    const targets = w.data.targets;
    const numTargets = targets.length;
    const targetDur = FELL_DURATION + HAUL_TRIPS * HAUL_DURATION;
    const totalDur = targetDur * numTargets;
    const globalT = timeMs % totalDur;

    const targetIdx = Math.min(Math.floor(globalT / targetDur), numTargets - 1);
    const localT = globalT - targetIdx * targetDur;

    // Previously felled targets in this cycle: erase standing tree, draw log
    for (let i = 0; i < targetIdx; i++) {
      const prev = targets[i];
      const prevFallsRight = prev.px > w.data.hutPx;
      this._eraseStandingTree(pixels, prev);
      this._drawLog(pixels, N, ext, prev.px, prev.py, prevFallsRight, prev);
    }

    const tree = targets[targetIdx];
    const hx = w.data.hutPx;
    const hy = w.data.hutPy;
    const tx = tree.px;
    const ty = tree.py;
    const fallsRight = tx > hx;

    let wx: number, wy: number;
    let facingRight: boolean;
    let carryingLog = false;

    if (localT < FELL_DURATION) {
      // ─── Felling phase ─────────────────────────────────────────────
      const ft = localT / FELL_DURATION;

      if (ft < FELL_WALK) {
        // Walking to tree — tree is in static render, no need to draw it
        const p = ft / FELL_WALK;
        wx = Math.round(hx + (tx - hx) * p);
        wy = Math.round(hy + (ty - hy) * p);
        facingRight = fallsRight;

      } else if (ft < FELL_CHOP) {
        // Chopping — tree still standing in static render
        wx = tx + (fallsRight ? -2 : 2);
        wy = ty;
        facingRight = fallsRight;
        const phase = ((ft - FELL_WALK) / (FELL_CHOP - FELL_WALK)) * 8;
        if (Math.floor(phase) % 2 === 0) {
          this._flash(pixels, N, ext, tx, ty - 2);
        }

      } else if (ft < FELL_FALL) {
        // Tree falls — erase standing tree, draw falling version
        this._eraseStandingTree(pixels, tree);
        wx = tx + (fallsRight ? -3 : 3);
        wy = ty;
        facingRight = fallsRight;
        const fallP = (ft - FELL_CHOP) / (FELL_FALL - FELL_CHOP);
        this._drawFallingTree(pixels, N, ext, tree, fallP, fallsRight);

      } else if (ft < FELL_WORK) {
        // Processing downed tree into log
        this._eraseStandingTree(pixels, tree);
        this._drawDownedTree(pixels, N, ext, tree, fallsRight);
        wx = tx + (fallsRight ? 3 : -3);
        wy = ty + 1;
        facingRight = fallsRight;
        this._stampPerson(pixels, N, ext, wx + (fallsRight ? 2 : -2), ty + 1, !facingRight, w.bodyColor);
        const phase = ((ft - FELL_FALL) / (FELL_WORK - FELL_FALL)) * 6;
        if (Math.floor(phase) % 3 === 0) {
          this._flash(pixels, N, ext, tx + (fallsRight ? 1 : -1), ty);
        }

      } else {
        // First pickup from fresh log
        this._eraseStandingTree(pixels, tree);
        this._drawLog(pixels, N, ext, tx, ty, fallsRight, tree);
        wx = tx + (fallsRight ? 2 : -2);
        wy = ty;
        facingRight = !fallsRight;
      }
    } else {
      // ─── Hauling loop — log persists on ground ─────────────────────
      this._eraseStandingTree(pixels, tree);
      this._drawLog(pixels, N, ext, tx, ty, fallsRight, tree);

      const haulT = localT - FELL_DURATION;
      const tripT = haulT % HAUL_DURATION;
      const ht = tripT / HAUL_DURATION;

      if (ht < HAUL_WALK_OUT) {
        const p = ht / HAUL_WALK_OUT;
        wx = Math.round(hx + (tx - hx) * p);
        wy = Math.round(hy + (ty - hy) * p);
        facingRight = fallsRight;
      } else if (ht < HAUL_PICKUP) {
        wx = tx + (fallsRight ? 2 : -2);
        wy = ty;
        facingRight = !fallsRight;
      } else if (ht < HAUL_CARRY) {
        const p = (ht - HAUL_PICKUP) / (HAUL_CARRY - HAUL_PICKUP);
        wx = Math.round(tx + (hx - tx) * p);
        wy = Math.round(ty + (hy - ty) * p);
        facingRight = hx > tx;
        carryingLog = true;
      } else {
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

  // ── Capture background pixels behind a target tree (screen space) ────────
  private _captureTreeBackground(
    pixels: Uint32Array, N: number, ext: Int16Array | null,
    tree: PlacedTree,
  ): void {
    const { w, h, data, flipped } = tree;
    const startX = tree.px - Math.floor(w / 2);
    const startY = tree.py - h + 1;
    const bg: { screenIdx: number; color: number }[] = [];

    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const srcX = flipped ? (w - 1 - sx) : sx;
        if (data[sy * w + srcX] === 0) continue;
        const px = startX + sx;
        const py = startY + sy;
        if (px < 0 || px >= N || py < 0 || py >= N) continue;
        const screenIdx = this._screenIdx(py * N + px, N, ext);
        if (screenIdx < 0) continue;
        bg.push({ screenIdx, color: pixels[screenIdx] });
      }
    }
    this._treeBackgrounds.set(tree, bg);
  }

  // ── Erase standing tree by restoring captured background ────────────────
  private _eraseStandingTree(
    pixels: Uint32Array, tree: PlacedTree,
  ): void {
    const bg = this._treeBackgrounds.get(tree);
    if (!bg) return;
    for (const { screenIdx, color } of bg) {
      this._saveDirty(pixels, screenIdx);
      pixels[screenIdx] = color;
    }
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

  // ── Downed tree (full sprite 90° rotated, during processing phase) ───────
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

  // ── Persistent log on ground (just trunk, no canopy) ─────────────────────
  private _drawLog(
    pixels: Uint32Array, N: number, ext: Int16Array | null,
    tx: number, ty: number, liesRight: boolean, tree: PlacedTree,
  ): void {
    const logLen = Math.min(6, Math.max(3, Math.floor(tree.h * 0.3)));
    const dir = liesRight ? 1 : -1;
    const colors = [tree.trunkColors[1] ?? TRUNK_COLOR, tree.trunkColors[0] ?? LOG_COLOR];

    for (let i = 0; i < logLen; i++) {
      const px = tx + i * dir;
      for (let dy = 0; dy < 2; dy++) {
        const py = ty + dy;
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
    const si = this._screenIdx(fy * N + fx, N, ext);
    if (si < 0) return;
    this._saveDirty(pixels, si);
    pixels[si] = packABGR(0xff, 0xff, 0xe0);
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
    const fd = WHEEL_FRAMES[frame];
    const cx = w.data.wheelPx;
    const cy = w.data.wheelPy;
    const sx = cx - Math.floor(WHEEL_SIZE / 2);
    const sy = cy - Math.floor(WHEEL_SIZE / 2);
    for (let r = 0; r < WHEEL_SIZE; r++) {
      for (let c = 0; c < WHEEL_SIZE; c++) {
        if (fd[r * WHEEL_SIZE + c] !== WH) continue;
        const px = sx + c;
        const py = sy + r;
        if (px < 0 || px >= N || py < 0 || py >= N) continue;
        const srcIdx = py * N + px;
        const screenIdx = this._screenIdx(srcIdx, N, ext);
        if (screenIdx < 0) continue;
        this._saveDirty(pixels, screenIdx);
        pixels[screenIdx] = WHEEL_COLORS[(c + r) & 1];
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
