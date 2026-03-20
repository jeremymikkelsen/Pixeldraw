/**
 * SmelterAnimator — per-frame animation for smelter buildings.
 *
 * Animates:
 *  - Heavy chimney smoke (thicker/darker than woodcutter)
 *  - Furnace glow pulse (orange sine wave)
 *  - Worker cycle: fetch ore, feed furnace, tend, retrieve ingot, deposit
 *
 * Active in all seasons.
 * Uses dirty-pixel save/restore pattern.
 */

import { packABGR } from './TerrainPalettes';
import type { SmelterRenderData } from './SmelterRenderer';

// ── Smelting cycle ───────────────────────────────────────────────────────────
const SMELT_CYCLE     = 15000;  // 15s full cycle
const PHASE_IDLE      = 0.10;   // 0-10%
const PHASE_FETCH     = 0.30;   // 10-30%: walk out and return with ore
const PHASE_FEED      = 0.45;   // 30-45%: deposit ore at furnace
const PHASE_TEND      = 0.70;   // 45-70%: stand by furnace
const PHASE_RETRIEVE  = 0.85;   // 70-85%: pull ingot
// 85-100%: walk to ingot pile and deposit

// ── Smoke — stronger than woodcutter ─────────────────────────────────────────
const SMOKE_SPAWN_MS  = 500;   // vs 900ms for woodcutter
const SMOKE_RISE      = 0.004; // vs 0.003
const SMOKE_MAX_AGE   = 3500;  // vs 2500ms
const SMOKE_MAX       = 8;     // vs 5

// ── Furnace glow ─────────────────────────────────────────────────────────────
const GLOW_CYCLE      = 3000;  // 3s sine cycle

// ── Colors ───────────────────────────────────────────────────────────────────
const HEAD_COLOR   = packABGR(0xc8, 0xa8, 0x80);
const LEG_COLOR    = packABGR(0x5a, 0x48, 0x38);
const ORE_COLOR    = packABGR(0x8a, 0x50, 0x30);
const INGOT_COLOR  = packABGR(0x60, 0x68, 0x70);
const GLOW_DIM     = packABGR(0xc0, 0x40, 0x20);
const GLOW_BRIGHT  = packABGR(0xf0, 0x80, 0x40);

// ── Person sprite ────────────────────────────────────────────────────────────
const _v = -1;
const PERSON_RIGHT = { w: 2, h: 3, cells: [[0, _v], [1, 1], [_v, 2]] };
const PERSON_LEFT  = { w: 2, h: 3, cells: [[_v, 0], [1, 1], [2, _v]] };

interface SmokeParticle { x: number; y: number; age: number; }

interface SmelterWorkerState {
  data: SmelterRenderData;
  bodyColor: number;
  smoke: SmokeParticle[];
  lastSmoke: number;
}

export class SmelterAnimator {
  extrusionMap: Int16Array | null = null;

  private _workers: SmelterWorkerState[] = [];
  private _N: number;
  private _dirty: { screenIdx: number; color: number }[] = [];
  private _savedThisFrame = new Set<number>();

  constructor(renderData: SmelterRenderData[], N: number, duchyColors: number[]) {
    this._N = N;
    for (const data of renderData) {
      const bodyColor = duchyColors[data.duchyIndex] ?? packABGR(0x80, 0x60, 0x40);
      this._workers.push({ data, bodyColor, smoke: [], lastSmoke: 0 });
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
      this._animateGlow(pixels, w, timeMs, N, ext);
      this._animateWorker(pixels, w, timeMs, N, ext);
    }
  }

  // ── Heavy smoke ────────────────────────────────────────────────────────
  private _animateSmoke(
    pixels: Uint32Array, w: SmelterWorkerState,
    timeMs: number, N: number, ext: Int16Array | null,
  ): void {
    if (timeMs - w.lastSmoke > SMOKE_SPAWN_MS) {
      // Spawn 2 particles for wider chimney
      const offsets = [-1, 0, 1];
      const ox = offsets[Math.floor(Math.random() * offsets.length)];
      w.smoke.push({
        x: w.data.chimneyPx + ox,
        y: w.data.chimneyPy,
        age: 0,
      });
      w.lastSmoke = timeMs;
      if (w.smoke.length > SMOKE_MAX) w.smoke.shift();
    }

    for (let i = w.smoke.length - 1; i >= 0; i--) {
      const p = w.smoke[i];
      p.age += 16;
      if (p.age > SMOKE_MAX_AGE) { w.smoke.splice(i, 1); continue; }

      const py = Math.round(p.y - p.age * SMOKE_RISE);
      const px = Math.round(p.x + Math.sin(p.age * 0.003) * 0.8);
      if (px < 0 || px >= N || py < 0 || py >= N) continue;

      const srcIdx = py * N + px;
      const screenIdx = this._screenIdx(srcIdx, N, ext);
      if (screenIdx < 0) continue;

      this._saveDirty(pixels, screenIdx);
      const existing = pixels[screenIdx];
      const alpha = Math.max(0.1, 0.65 * (1 - p.age / SMOKE_MAX_AGE));
      const er = existing & 0xff;
      const eg = (existing >> 8) & 0xff;
      const eb = (existing >> 16) & 0xff;
      // Warm/sooty smoke color (0xd8d0c0)
      pixels[screenIdx] = (255 << 24)
        | (Math.round(eb + (0xc0 - eb) * alpha) << 16)
        | (Math.round(eg + (0xd0 - eg) * alpha) << 8)
        | Math.round(er + (0xd8 - er) * alpha);
    }
  }

  // ── Furnace glow pulse ─────────────────────────────────────────────────
  private _animateGlow(
    pixels: Uint32Array, w: SmelterWorkerState,
    timeMs: number, N: number, ext: Int16Array | null,
  ): void {
    const t = (Math.sin(timeMs / GLOW_CYCLE * Math.PI * 2) + 1) * 0.5; // 0..1
    // Interpolate between dim and bright
    const dr = (GLOW_DIM & 0xff);
    const dg = ((GLOW_DIM >> 8) & 0xff);
    const db = ((GLOW_DIM >> 16) & 0xff);
    const br = (GLOW_BRIGHT & 0xff);
    const bg = ((GLOW_BRIGHT >> 8) & 0xff);
    const bb = ((GLOW_BRIGHT >> 16) & 0xff);
    const glowColor = (255 << 24)
      | (Math.round(db + (bb - db) * t) << 16)
      | (Math.round(dg + (bg - dg) * t) << 8)
      | Math.round(dr + (br - dr) * t);

    // Paint 2 furnace pixels
    for (let dx = 0; dx < 2; dx++) {
      const px = w.data.furnacePx + dx;
      const py = w.data.furnacePy;
      if (px < 0 || px >= N || py < 0 || py >= N) continue;
      const srcIdx = py * N + px;
      const screenIdx = this._screenIdx(srcIdx, N, ext);
      if (screenIdx < 0) continue;
      this._saveDirty(pixels, screenIdx);
      pixels[screenIdx] = glowColor;
    }
  }

  // ── Worker smelting cycle ──────────────────────────────────────────────
  private _animateWorker(
    pixels: Uint32Array, w: SmelterWorkerState,
    timeMs: number, N: number, ext: Int16Array | null,
  ): void {
    const d = w.data;
    const t = (timeMs % SMELT_CYCLE) / SMELT_CYCLE;

    const bx = d.buildingPx;
    const by = d.buildingPy;
    const ix = d.ingotPilePx;
    const iy = d.ingotPilePy;
    // "Ore delivery" point — opposite side from ingot pile
    const orePtX = bx - 7;
    const orePtY = by;

    let wx: number, wy: number;
    let facingRight: boolean;
    let carryItem: number | null = null; // color of carried item, or null

    if (t < PHASE_IDLE) {
      // Standing near ingot pile
      wx = ix + 1;
      wy = iy;
      facingRight = false;
    } else if (t < PHASE_FETCH) {
      // Walk to ore point and back
      const fetchT = (t - PHASE_IDLE) / (PHASE_FETCH - PHASE_IDLE);
      if (fetchT < 0.5) {
        // Walk out
        const p = fetchT / 0.5;
        wx = Math.round(bx + (orePtX - bx) * p);
        wy = Math.round(by + (orePtY - by) * p);
        facingRight = orePtX > bx;
      } else {
        // Walk back carrying ore
        const p = (fetchT - 0.5) / 0.5;
        wx = Math.round(orePtX + (bx - orePtX) * p);
        wy = Math.round(orePtY + (by - orePtY) * p);
        facingRight = bx > orePtX;
        carryItem = ORE_COLOR;
      }
    } else if (t < PHASE_FEED) {
      // At furnace
      wx = d.furnacePx - 1;
      wy = d.furnacePy;
      facingRight = true;
    } else if (t < PHASE_TEND) {
      // Tending furnace
      wx = d.furnacePx - 1;
      wy = d.furnacePy;
      facingRight = true;
    } else if (t < PHASE_RETRIEVE) {
      // Retrieve ingot
      wx = d.furnacePx - 1;
      wy = d.furnacePy;
      facingRight = true;
      carryItem = INGOT_COLOR;
    } else {
      // Walk to ingot pile and deposit
      const p = (t - PHASE_RETRIEVE) / (1.0 - PHASE_RETRIEVE);
      wx = Math.round(bx + (ix - bx) * p);
      wy = Math.round(by + (iy - by) * p);
      facingRight = ix > bx;
      carryItem = p < 0.8 ? INGOT_COLOR : null;
    }

    wx = Math.max(1, Math.min(N - 3, wx));
    wy = Math.max(3, Math.min(N - 1, wy));

    this._stampPerson(pixels, N, ext, wx, wy, facingRight, w.bodyColor);

    if (carryItem !== null) {
      const carryY = wy - 3;
      if (carryY >= 0) {
        const si = this._screenIdx(carryY * N + wx, N, ext);
        if (si >= 0) {
          this._saveDirty(pixels, si);
          pixels[si] = carryItem;
        }
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────
  private _stampPerson(
    pixels: Uint32Array, N: number, ext: Int16Array | null,
    wx: number, wy: number, facingRight: boolean, bodyColor: number,
  ): void {
    const sprite = facingRight ? PERSON_RIGHT : PERSON_LEFT;
    const colors = [HEAD_COLOR, bodyColor, LEG_COLOR];
    for (let sy = 0; sy < sprite.h; sy++) {
      for (let sx = 0; sx < sprite.w; sx++) {
        const ci = sprite.cells[sy][sx];
        if (ci < 0) continue;
        const px = wx + sx;
        const py = wy - sprite.h + 1 + sy;
        if (px < 0 || px >= N || py < 0 || py >= N) continue;
        const si = this._screenIdx(py * N + px, N, ext);
        if (si < 0) continue;
        this._saveDirty(pixels, si);
        pixels[si] = colors[ci];
      }
    }
  }

  private _screenIdx(srcIdx: number, N: number, ext: Int16Array | null): number {
    if (!ext) return srcIdx;
    return ext[srcIdx] < 0 ? -1 : srcIdx + ext[srcIdx] * N;
  }

  private _saveDirty(pixels: Uint32Array, idx: number): void {
    if (this._savedThisFrame.has(idx)) return;
    this._savedThisFrame.add(idx);
    this._dirty.push({ screenIdx: idx, color: pixels[idx] });
  }
}
