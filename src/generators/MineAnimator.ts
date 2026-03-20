/**
 * MineAnimator — per-frame animation for iron mines.
 *
 * Animates:
 *  - Dust particles from mine entrance (brown-grey)
 *  - Miner cycle: enters mine, pickaxe flashes, exits with ore, deposits
 *
 * Active in all seasons (mines don't shut down in winter).
 * Uses dirty-pixel save/restore pattern.
 */

import { packABGR } from './TerrainPalettes';
import type { MineRenderData } from './MineRenderer';

// ── Mining cycle ─────────────────────────────────────────────────────────────
const MINE_CYCLE      = 20000;  // 20s full cycle
const PHASE_ENTER     = 0.15;   // 0-15%: walk to entrance
const PHASE_MINING    = 0.55;   // 15-55%: inside mine, pickaxe flashes
const PHASE_EXIT      = 0.65;   // 55-65%: emerge with ore
const PHASE_DEPOSIT   = 0.80;   // 65-80%: walk to ore pile
// 80-100%: rest

// ── Dust ─────────────────────────────────────────────────────────────────────
const DUST_SPAWN_MS   = 1200;
const DUST_RISE       = 0.002;
const DUST_MAX_AGE    = 1800;

// ── Colors ───────────────────────────────────────────────────────────────────
const HEAD_COLOR  = packABGR(0xc8, 0xa8, 0x80);
const LEG_COLOR   = packABGR(0x5a, 0x48, 0x38);
const ORE_COLOR   = packABGR(0x8a, 0x50, 0x30);
const FLASH_COLOR = packABGR(0xff, 0xff, 0xe0);

// ── Person sprite ────────────────────────────────────────────────────────────
const _  = -1;
const PERSON_RIGHT = { w: 2, h: 3, cells: [[0, _], [1, 1], [_, 2]] };
const PERSON_LEFT  = { w: 2, h: 3, cells: [[_, 0], [1, 1], [2, _]] };

interface DustParticle { x: number; y: number; age: number; }

interface MinerState {
  data: MineRenderData;
  bodyColor: number;
  dust: DustParticle[];
  lastDust: number;
}

export class MineAnimator {
  extrusionMap: Int16Array | null = null;

  private _miners: MinerState[] = [];
  private _N: number;
  private _dirty: { screenIdx: number; color: number }[] = [];
  private _savedThisFrame = new Set<number>();

  constructor(renderData: MineRenderData[], N: number, duchyColors: number[]) {
    this._N = N;
    for (const data of renderData) {
      const bodyColor = duchyColors[data.duchyIndex] ?? packABGR(0x80, 0x60, 0x40);
      this._miners.push({ data, bodyColor, dust: [], lastDust: 0 });
    }
  }

  animate(pixels: Uint32Array, timeMs: number): void {
    const N = this._N;
    const ext = this.extrusionMap;

    for (const d of this._dirty) pixels[d.screenIdx] = d.color;
    this._dirty = [];
    this._savedThisFrame = new Set<number>();

    for (const m of this._miners) {
      this._animateDust(pixels, m, timeMs, N, ext);
      this._animateMiner(pixels, m, timeMs, N, ext);
    }
  }

  // ── Dust particles from mine entrance ───────────────────────────────────
  private _animateDust(
    pixels: Uint32Array, m: MinerState,
    timeMs: number, N: number, ext: Int16Array | null,
  ): void {
    if (timeMs - m.lastDust > DUST_SPAWN_MS) {
      m.dust.push({
        x: m.data.dustPx + (Math.random() < 0.5 ? 0 : 1),
        y: m.data.dustPy,
        age: 0,
      });
      m.lastDust = timeMs;
      if (m.dust.length > 4) m.dust.shift();
    }

    for (let i = m.dust.length - 1; i >= 0; i--) {
      const p = m.dust[i];
      p.age += 16;
      if (p.age > DUST_MAX_AGE) { m.dust.splice(i, 1); continue; }

      const py = Math.round(p.y - p.age * DUST_RISE);
      const px = Math.round(p.x + Math.sin(p.age * 0.004) * 0.6);
      if (px < 0 || px >= N || py < 0 || py >= N) continue;

      const srcIdx = py * N + px;
      const screenIdx = this._screenIdx(srcIdx, N, ext);
      if (screenIdx < 0) continue;

      this._saveDirty(pixels, screenIdx);
      const existing = pixels[screenIdx];
      const alpha = Math.max(0.1, 0.40 * (1 - p.age / DUST_MAX_AGE));
      const er = existing & 0xff;
      const eg = (existing >> 8) & 0xff;
      const eb = (existing >> 16) & 0xff;
      pixels[screenIdx] = (255 << 24)
        | (Math.round(eb + (0xa0 - eb) * alpha) << 16)
        | (Math.round(eg + (0xb0 - eg) * alpha) << 8)
        | Math.round(er + (0xc0 - er) * alpha);
    }
  }

  // ── Miner cycle ────────────────────────────────────────────────────────
  private _animateMiner(
    pixels: Uint32Array, m: MinerState,
    timeMs: number, N: number, ext: Int16Array | null,
  ): void {
    const d = m.data;
    const t = (timeMs % MINE_CYCLE) / MINE_CYCLE;

    const ex = d.entrancePx;
    const ey = d.entrancePy;
    const ox = d.orePilePx;
    const oy = d.orePilePy;

    let wx: number, wy: number;
    let facingRight: boolean;
    let carryingOre = false;

    if (t < PHASE_ENTER) {
      // Walking from ore pile toward entrance
      const p = t / PHASE_ENTER;
      wx = Math.round(ox + (ex - ox) * p);
      wy = Math.round(oy + (ey - oy) * p);
      facingRight = ex > ox;
    } else if (t < PHASE_MINING) {
      // Inside mine — no visible miner, just pickaxe flashes
      const mineT = (t - PHASE_ENTER) / (PHASE_MINING - PHASE_ENTER);
      const flashPhase = mineT * 12;
      if (Math.floor(flashPhase) % 3 === 0) {
        this._flash(pixels, N, ext, ex, ey - 2);
      }
      return; // miner not visible
    } else if (t < PHASE_EXIT) {
      // Emerging from entrance
      const p = (t - PHASE_MINING) / (PHASE_EXIT - PHASE_MINING);
      wx = ex;
      wy = ey;
      facingRight = ox > ex;
      carryingOre = p > 0.5;
    } else if (t < PHASE_DEPOSIT) {
      // Walking from entrance to ore pile
      const p = (t - PHASE_EXIT) / (PHASE_DEPOSIT - PHASE_EXIT);
      wx = Math.round(ex + (ox - ex) * p);
      wy = Math.round(ey + (oy - ey) * p);
      facingRight = ox > ex;
      carryingOre = true;
    } else {
      // Resting near ore pile
      wx = ox + 1;
      wy = oy;
      facingRight = false;
      return; // resting, no visible activity
    }

    wx = Math.max(1, Math.min(N - 3, wx));
    wy = Math.max(3, Math.min(N - 1, wy));

    this._stampPerson(pixels, N, ext, wx, wy, facingRight, m.bodyColor);

    if (carryingOre) {
      const oreY = wy - 3;
      if (oreY >= 0) {
        const si = this._screenIdx(oreY * N + wx, N, ext);
        if (si >= 0) {
          this._saveDirty(pixels, si);
          pixels[si] = ORE_COLOR;
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

  private _flash(
    pixels: Uint32Array, N: number, ext: Int16Array | null,
    fx: number, fy: number,
  ): void {
    if (fx < 0 || fx >= N || fy < 0 || fy >= N) return;
    const si = this._screenIdx(fy * N + fx, N, ext);
    if (si < 0) return;
    this._saveDirty(pixels, si);
    pixels[si] = FLASH_COLOR;
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
