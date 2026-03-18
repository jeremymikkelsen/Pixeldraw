/**
 * WoodcutterRenderer — static rendering of woodcutter huts, lumber stacks,
 * and sawmill water wheels + canals.
 *
 * Rendered once per season during _renderMapInner, before TreeRenderer so
 * trees avoid the woodcutter clearing.
 */

import { TopographyGenerator, mulberry32 } from './TopographyGenerator';
import { HydrologyGenerator } from './HydrologyGenerator';
import { packABGR } from './TerrainPalettes';
import { Season } from '../state/Season';
import type { WoodcutterState } from '../state/Building';
import { RIVER_THRESHOLD } from './utils';

// ── Cell types (matches StructureRenderer conventions) ──────────────────────
const _ = 0;  // transparent
const W = 1;  // wall (wood)
const R = 2;  // roof (thatch)
const D = 3;  // door
const S = 4;  // stone foundation
const N = 5;  // window
const K = 7;  // chimney
const E = 8;  // east/side wall
const M = 9;  // smoke
const L = 10; // lumber (boards)

// ── Hut sprite (9×10, 3/4 perspective) ─────────────────────────────────────
type SpriteTemplate = { w: number; h: number; data: number[]; anchorY: number };

const WOODCUTTER_HUT: SpriteTemplate = {
  w: 9, h: 10, anchorY: 9, data: [
    _, _, _, M, _, _, _, _, _,
    _, _, K, K, _, _, _, _, _,
    _, _, R, R, R, R, _, _, _,
    _, R, R, R, R, R, R, _, _,
    _, R, R, R, R, R, R, _, _,
    _, W, W, N, W, E, E, _, _,
    _, W, W, D, W, E, E, _, _,
    _, S, S, S, S, S, S, _, _,
    _, _, _, _, _, _, _, _, _,
    _, _, _, _, _, _, _, _, _,
  ],
};

// ── Lumber stack sprite (4×3 each) ─────────────────────────────────────────
const LUMBER_STACK: SpriteTemplate = {
  w: 4, h: 3, anchorY: 2, data: [
    L, L, L, L,
    L, L, L, L,
    L, L, L, L,
  ],
};

// ── Water wheel frames (5×5, 4 rotation states) ───────────────────────────
const WH = 11; // wheel cell type
const WHEEL_FRAMES: number[][] = [
  // Frame 0: spokes at +  (vertical + horizontal)
  [_, _, WH, _, _,
   _, _, WH, _, _,
   WH, WH, WH, WH, WH,
   _, _, WH, _, _,
   _, _, WH, _, _],
  // Frame 1: spokes at ×  (diagonal)
  [WH, _, _, _, WH,
   _, WH, _, WH, _,
   _, _, WH, _, _,
   _, WH, _, WH, _,
   WH, _, _, _, WH],
  // Frame 2: spokes at +  (same as 0 but offset)
  [_, _, WH, _, _,
   _, _, WH, _, _,
   WH, WH, WH, WH, WH,
   _, _, WH, _, _,
   _, _, WH, _, _],
  // Frame 3: spokes at ×  (same as 1)
  [WH, _, _, _, WH,
   _, WH, _, WH, _,
   _, _, WH, _, _,
   _, WH, _, WH, _,
   WH, _, _, _, WH],
];
const WHEEL_SIZE = 5;

// ── Color palettes ─────────────────────────────────────────────────────────
interface WoodcutterPalette {
  wall: number[];     // 3 shades (RGB hex)
  roof: number[];     // 3 shades
  stone: number[];    // 2 shades
  door: number;
  window: number;
  chimney: number[];  // 2 shades
  lumber: number[];   // 3 shades (board colors)
  wheel: number[];    // 2 shades
}

const PALETTE_SUMMER: WoodcutterPalette = {
  wall:    [0x4a3520, 0x5c4430, 0x6e5340],
  roof:    [0x8a7a40, 0x9c8c50, 0xae9e60],
  stone:   [0x585050, 0x686060],
  door:    0x3a2810,
  window:  0x4488bb,
  chimney: [0x887070, 0x988080],
  lumber:  [0x8a7040, 0x9c8250, 0xae9460],
  wheel:   [0x5a4830, 0x6e5c3e],
};

const PALETTE_WINTER: WoodcutterPalette = {
  wall:    [0x4a3520, 0x5c4430, 0x6e5340],
  roof:    [0xc8c8d0, 0xd4d4dc, 0xe0e0e8],
  stone:   [0x585058, 0x686068],
  door:    0x3a2810,
  window:  0x3a78a8,
  chimney: [0x887070, 0x988080],
  lumber:  [0x706040, 0x827250, 0x948460],
  wheel:   [0x5a4830, 0x6e5c3e],
};

function getPalette(season: Season): WoodcutterPalette {
  if (season === Season.Winter) return PALETTE_WINTER;
  return PALETTE_SUMMER;
}

// ── Render data passed to the animator ─────────────────────────────────────
export interface WoodcutterRenderData {
  duchyIndex: number;
  variant: 'manual' | 'sawmill';
  hutPx: number;
  hutPy: number;
  lumberCount: number;
  // Sawmill-only: wheel position and canal path
  wheelPx: number;
  wheelPy: number;
  canalPixels: number[];  // pixel indices of the canal
  // Chimney top position for smoke
  chimneyPx: number;
  chimneyPy: number;
}

// ── Renderer ───────────────────────────────────────────────────────────────
export class WoodcutterRenderer {
  render(
    pixels: Uint32Array,
    resolution: number,
    woodcutters: Map<number, WoodcutterState>,
    topo: TopographyGenerator,
    hydro: HydrologyGenerator,
    seed: number,
    season: Season,
    riverMask: Uint8Array | null,
  ): { woodcutterMask: Uint8Array; renderData: WoodcutterRenderData[] } {
    const NN = resolution;
    const palette = getPalette(season);
    const mask = new Uint8Array(NN * NN);
    const renderData: WoodcutterRenderData[] = [];

    for (const [_di, wc] of woodcutters) {
      const { hutPx, hutPy, variant, lumberCount, duchyIndex } = wc;
      const rng = mulberry32(seed ^ (duchyIndex * 0x7e3a + 0xbeef));

      // Don't render if too close to edge
      if (hutPx < 15 || hutPy < 15 || hutPx >= NN - 15 || hutPy >= NN - 15) continue;

      // Clear area around hut in mask (so trees avoid this zone)
      const clearRadius = 14;
      for (let dy = -clearRadius; dy <= clearRadius; dy++) {
        for (let dx = -clearRadius; dx <= clearRadius; dx++) {
          if (dx * dx + dy * dy > clearRadius * clearRadius) continue;
          const px = hutPx + dx;
          const py = hutPy + dy;
          if (px >= 0 && px < NN && py >= 0 && py < NN) {
            mask[py * NN + px] = 1;
          }
        }
      }

      // Stamp hut shadow
      this._stampShadow(pixels, NN, hutPx, hutPy, WOODCUTTER_HUT);

      // Stamp hut sprite
      this._stampSprite(pixels, NN, hutPx, hutPy, WOODCUTTER_HUT, palette, mask);

      // Chimney position (for smoke animation)
      const chimneyPx = hutPx - Math.floor(WOODCUTTER_HUT.w / 2) + 3;
      const chimneyPy = hutPy - WOODCUTTER_HUT.anchorY;

      // Lumber stacks — placed to the right of the hut
      const stackCount = Math.min(4, Math.floor(lumberCount / 2));
      for (let si = 0; si < stackCount; si++) {
        const stackX = hutPx + 6 + (si % 2) * 5;
        const stackY = hutPy - 1 + Math.floor(si / 2) * 4;
        this._stampLumber(pixels, NN, stackX, stackY, palette, mask);
      }

      // Sawmill: water wheel + canal
      let wheelPx = 0, wheelPy = 0;
      const canalPixels: number[] = [];

      if (variant === 'sawmill' && riverMask) {
        // Place wheel to the left of the hut
        wheelPx = hutPx - 8;
        wheelPy = hutPy - 2;

        // Draw canal from wheel to nearest river pixel (BFS)
        const canalPath = this._findCanalPath(wheelPx, wheelPy, riverMask, NN);
        const canalColor = packABGR(0x30, 0x60, 0x90);
        for (const idx of canalPath) {
          if (!riverMask[idx]) {
            pixels[idx] = canalColor;
            mask[idx] = 1;
            canalPixels.push(idx);
          }
        }

        // Stamp initial wheel frame
        this._stampWheel(pixels, NN, wheelPx, wheelPy, 0, palette, mask);
      }

      renderData.push({
        duchyIndex,
        variant,
        hutPx,
        hutPy,
        lumberCount,
        wheelPx,
        wheelPy,
        canalPixels,
        chimneyPx,
        chimneyPy,
      });
    }

    return { woodcutterMask: mask, renderData };
  }

  // ── Shadow stamp ─────────────────────────────────────────────────────────
  private _stampShadow(pixels: Uint32Array, NN: number, cx: number, cy: number, tmpl: SpriteTemplate): void {
    const startX = cx - Math.floor(tmpl.w / 2);
    const startY = cy - tmpl.anchorY;
    const SHADOW_SKEW_X = 0.45;
    const SHADOW_SKEW_Y = 0.35;
    const SHADOW_DARKEN = 0.50;

    for (let sy = 0; sy < tmpl.h; sy++) {
      for (let sx = 0; sx < tmpl.w; sx++) {
        const cell = tmpl.data[sy * tmpl.w + sx];
        if (cell === 0 || cell === M) continue;

        const heightAboveBase = tmpl.anchorY - sy;
        const shadowDx = Math.round(heightAboveBase * SHADOW_SKEW_X) + 1;
        const shadowDy = Math.round(heightAboveBase * SHADOW_SKEW_Y);

        const px = startX + sx + shadowDx;
        const py = startY + sy + shadowDy;
        if (px < 0 || px >= NN || py < 0 || py >= NN) continue;

        const idx = py * NN + px;
        const orig = pixels[idx];
        const r = Math.floor((orig & 0xff) * SHADOW_DARKEN);
        const g = Math.floor(((orig >> 8) & 0xff) * SHADOW_DARKEN);
        const b = Math.floor(((orig >> 16) & 0xff) * SHADOW_DARKEN);
        pixels[idx] = (255 << 24) | (b << 16) | (g << 8) | r;
      }
    }
  }

  // ── Sprite stamp ─────────────────────────────────────────────────────────
  private _stampSprite(
    pixels: Uint32Array, NN: number, cx: number, cy: number,
    tmpl: SpriteTemplate, palette: WoodcutterPalette, mask: Uint8Array,
  ): void {
    const startX = cx - Math.floor(tmpl.w / 2);
    const startY = cy - tmpl.anchorY;

    for (let sy = 0; sy < tmpl.h; sy++) {
      for (let sx = 0; sx < tmpl.w; sx++) {
        const cell = tmpl.data[sy * tmpl.w + sx];
        if (cell === 0) continue;

        const px = startX + sx;
        const py = startY + sy;
        if (px < 0 || px >= NN || py < 0 || py >= NN) continue;

        const idx = py * NN + px;

        // Smoke: alpha-blend white wisp
        if (cell === M) {
          const existing = pixels[idx];
          const er = existing & 0xff;
          const eg = (existing >> 8) & 0xff;
          const eb = (existing >> 16) & 0xff;
          const alpha = 0.55;
          const nr = Math.round(er + (0xe8 - er) * alpha);
          const ng = Math.round(eg + (0xe4 - eg) * alpha);
          const nb = Math.round(eb + (0xe0 - eb) * alpha);
          pixels[idx] = (255 << 24) | (nb << 16) | (ng << 8) | nr;
          continue;
        }

        let color: number;
        switch (cell) {
          case W: color = palette.wall[Math.min(2, Math.floor(sx / 3))]; break;
          case E: color = palette.wall[0]; break;
          case R: color = palette.roof[Math.min(2, Math.floor(sx / 3))]; break;
          case S: color = palette.stone[sx % 2]; break;
          case D: color = palette.door; break;
          case N: color = palette.window; break;
          case K: color = palette.chimney[sy % 2]; break;
          default: continue;
        }

        const r = (color >> 16) & 0xff;
        const g = (color >> 8) & 0xff;
        const b = color & 0xff;
        pixels[idx] = packABGR(r, g, b);
        mask[idx] = 1;
      }
    }
  }

  // ── Lumber stack stamp ───────────────────────────────────────────────────
  private _stampLumber(
    pixels: Uint32Array, NN: number, cx: number, cy: number,
    palette: WoodcutterPalette, mask: Uint8Array,
  ): void {
    const startX = cx - Math.floor(LUMBER_STACK.w / 2);
    const startY = cy - LUMBER_STACK.anchorY;

    for (let sy = 0; sy < LUMBER_STACK.h; sy++) {
      for (let sx = 0; sx < LUMBER_STACK.w; sx++) {
        const cell = LUMBER_STACK.data[sy * LUMBER_STACK.w + sx];
        if (cell !== L) continue;

        const px = startX + sx;
        const py = startY + sy;
        if (px < 0 || px >= NN || py < 0 || py >= NN) continue;

        const idx = py * NN + px;
        const shade = (sx + sy) % 3;
        const color = palette.lumber[shade];
        const r = (color >> 16) & 0xff;
        const g = (color >> 8) & 0xff;
        const b = color & 0xff;
        pixels[idx] = packABGR(r, g, b);
        mask[idx] = 1;
      }
    }
  }

  // ── Water wheel stamp ────────────────────────────────────────────────────
  private _stampWheel(
    pixels: Uint32Array, NN: number, cx: number, cy: number,
    frame: number, palette: WoodcutterPalette, mask: Uint8Array,
  ): void {
    const data = WHEEL_FRAMES[frame % WHEEL_FRAMES.length];
    const startX = cx - Math.floor(WHEEL_SIZE / 2);
    const startY = cy - Math.floor(WHEEL_SIZE / 2);

    for (let sy = 0; sy < WHEEL_SIZE; sy++) {
      for (let sx = 0; sx < WHEEL_SIZE; sx++) {
        const cell = data[sy * WHEEL_SIZE + sx];
        if (cell !== WH) continue;

        const px = startX + sx;
        const py = startY + sy;
        if (px < 0 || px >= NN || py < 0 || py >= NN) continue;

        const idx = py * NN + px;
        const shade = ((sx + sy) & 1);
        const color = palette.wheel[shade];
        const r = (color >> 16) & 0xff;
        const g = (color >> 8) & 0xff;
        const b = color & 0xff;
        pixels[idx] = packABGR(r, g, b);
        mask[idx] = 1;
      }
    }
  }

  // ── Canal pathfinding (BFS from wheel to nearest river pixel) ────────────
  private _findCanalPath(
    startX: number, startY: number,
    riverMask: Uint8Array, NN: number,
  ): number[] {
    const MAX_SEARCH = 35;
    const visited = new Uint8Array(NN * NN);
    const parent = new Int32Array(NN * NN).fill(-1);
    const queue: number[] = [];

    const startIdx = startY * NN + startX;
    queue.push(startIdx);
    visited[startIdx] = 1;

    let found = -1;
    let qi = 0;

    while (qi < queue.length && found < 0) {
      const idx = queue[qi++];
      const cx = idx % NN;
      const cy = (idx - cx) / NN;

      // Check distance from start
      const dist = Math.abs(cx - startX) + Math.abs(cy - startY);
      if (dist > MAX_SEARCH) continue;

      // 4-connected neighbors
      const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
      for (const [dx, dy] of dirs) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= NN || ny < 0 || ny >= NN) continue;
        const nIdx = ny * NN + nx;
        if (visited[nIdx]) continue;
        visited[nIdx] = 1;
        parent[nIdx] = idx;

        if (riverMask[nIdx]) {
          found = nIdx;
          break;
        }
        queue.push(nIdx);
      }
    }

    // Trace path back
    if (found < 0) return [];
    const path: number[] = [];
    let cur = found;
    while (cur !== startIdx && cur >= 0) {
      path.push(cur);
      cur = parent[cur];
    }
    path.push(startIdx);
    path.reverse();
    return path;
  }
}

// Export wheel frames for the animator
export { WHEEL_FRAMES, WHEEL_SIZE, WH };
