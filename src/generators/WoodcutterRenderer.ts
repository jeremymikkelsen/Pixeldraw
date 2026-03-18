/**
 * WoodcutterRenderer — static rendering of woodcutter huts, lumber stack,
 * sawmill water wheels with stone dam, and dirt haul paths.
 *
 * Rendered once per season during _renderMapInner, before TreeRenderer so
 * trees avoid the woodcutter clearing.
 */

import { mulberry32 } from './TopographyGenerator';
import { packABGR } from './TerrainPalettes';
import { Season } from '../state/Season';
import type { WoodcutterState } from '../state/Building';
import type { PlacedTree } from './TreeRenderer';

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

// ── Lumber stack sprite (5×3, single stack next to hut) ────────────────────
const LUMBER_STACK: SpriteTemplate = {
  w: 5, h: 3, anchorY: 2, data: [
    L, L, L, L, L,
    L, L, L, L, L,
    L, L, L, L, L,
  ],
};

// ── Water wheel frames (5×5, 4 rotation states) ───────────────────────────
const WH = 11; // wheel cell type
const WHEEL_FRAMES: number[][] = [
  // Frame 0: spokes at +
  [_, _, WH, _, _,
   _, _, WH, _, _,
   WH, WH, WH, WH, WH,
   _, _, WH, _, _,
   _, _, WH, _, _],
  // Frame 1: spokes at ×
  [WH, _, _, _, WH,
   _, WH, _, WH, _,
   _, _, WH, _, _,
   _, WH, _, WH, _,
   WH, _, _, _, WH],
  // Frame 2: spokes at + (repeat for smooth spin)
  [_, _, WH, _, _,
   _, _, WH, _, _,
   WH, WH, WH, WH, WH,
   _, _, WH, _, _,
   _, _, WH, _, _],
  // Frame 3: spokes at ×
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
  dam: number[];      // 2 shades for stone dam
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
  dam:     [0x686060, 0x787070],
};

const PALETTE_WINTER: WoodcutterPalette = {
  wall:    [0x5a4530, 0x6c5440, 0x7e6350],  // slightly brighter walls vs snow
  roof:    [0xb0b0b8, 0xc0c0c8, 0xd0d0d8],  // snow-covered but not pure white
  stone:   [0x686068, 0x787078],
  door:    0x4a3820,
  window:  0x3a78a8,
  chimney: [0x887070, 0x988080],
  lumber:  [0x807050, 0x928260, 0xa49470],  // snow-dusted lumber
  wheel:   [0x5a4830, 0x6e5c3e],
  dam:     [0x787078, 0x888088],
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
  // Sawmill: wheel position
  wheelPx: number;
  wheelPy: number;
  // Chimney top position for smoke
  chimneyPx: number;
  chimneyPy: number;
  // Target trees (actual placed trees from TreeRenderer)
  targets: PlacedTree[];
}

// ── Renderer ───────────────────────────────────────────────────────────────
export class WoodcutterRenderer {
  render(
    pixels: Uint32Array,
    resolution: number,
    woodcutters: Map<number, WoodcutterState>,
    seed: number,
    season: Season,
    riverMask: Uint8Array | null,
    removedTrees: Set<number>,
  ): { woodcutterMask: Uint8Array; woodcutterBuildingMask: Uint8Array; renderData: WoodcutterRenderData[] } {
    const NN = resolution;
    const palette = getPalette(season);
    const mask = new Uint8Array(NN * NN);           // wide clearing (tree avoidance)
    const buildMask = new Uint8Array(NN * NN);      // tight (actual structure pixels only)
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

      // Stamp hut sprite (marks both masks)
      this._stampSprite(pixels, NN, hutPx, hutPy, WOODCUTTER_HUT, palette, mask, buildMask);

      // Chimney position (for smoke animation)
      const chimneyPx = hutPx - Math.floor(WOODCUTTER_HUT.w / 2) + 3;
      const chimneyPy = hutPy - WOODCUTTER_HUT.anchorY;

      // Single lumber stack — placed to the right of the hut
      if (lumberCount > 0) {
        const stackX = hutPx + 6;
        const stackY = hutPy - 1;
        this._stampLumber(pixels, NN, stackX, stackY, palette, mask, buildMask);
      }

      // Sawmill: water wheel flush against hut left wall + stone dam
      let wheelPx = 0, wheelPy = 0;

      if (variant === 'sawmill') {
        // Wheel right next to hut's left wall (water mill style)
        wheelPx = hutPx - Math.floor(WOODCUTTER_HUT.w / 2) - 2;
        wheelPy = hutPy - 3;  // vertically centered on the wall

        // Stone dam: 2 rows of stone below and around the wheel
        this._stampDam(pixels, NN, wheelPx, wheelPy, palette, buildMask, riverMask);

        // Stamp initial wheel frame (NOT in buildMask — animator overwrites each frame)
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
        chimneyPx,
        chimneyPy,
        targets: [], // populated in phase 2 after tree rendering
      });
    }

    return { woodcutterMask: mask, woodcutterBuildingMask: buildMask, renderData };
  }

  /**
   * Phase 2: find target trees and draw dirt haul paths.
   * Called after TreeRenderer so treeMask is available.
   */
  /**
   * Phase 2: find actual placed trees as targets and draw dirt haul paths.
   * Called after TreeRenderer so placedTrees is available.
   */
  findTargetsAndDrawPaths(
    pixels: Uint32Array,
    resolution: number,
    renderData: WoodcutterRenderData[],
    placedTrees: PlacedTree[],
    removedTrees: Set<number>,
    riverMask: Uint8Array | null,
    seed: number,
  ): number[] {
    const NN = resolution;
    const targetKeys: number[] = [];
    for (const rd of renderData) {
      const rng = mulberry32(seed ^ (rd.duchyIndex * 0x7e3a + 0xbeef + 0x1111));
      const numTargets = rd.variant === 'sawmill' ? 3 : 1;
      rd.targets = this._findTargetTrees(
        rd.hutPx, rd.hutPy, numTargets, NN, placedTrees, removedTrees, riverMask, rng,
      );
      for (const t of rd.targets) {
        this._drawDirtPath(pixels, NN, rd.hutPx, rd.hutPy, t.px, t.py, riverMask);
        targetKeys.push(t.py * NN + t.px);
      }
    }
    return targetKeys;
  }

  // ── Find actual placed trees near hut (same side of river) ───────────────
  private _findTargetTrees(
    hutPx: number, hutPy: number, count: number, NN: number,
    placedTrees: PlacedTree[], removedTrees: Set<number>,
    riverMask: Uint8Array | null, rng: () => number,
  ): PlacedTree[] {
    const searchRadius = 45;
    const minDist = 12;

    // Filter to nearby trees not already removed and not across a river
    const candidates: { tree: PlacedTree; dist: number }[] = [];
    for (const tree of placedTrees) {
      const dx = tree.px - hutPx;
      const dy = tree.py - hutPy;
      const dist = dx * dx + dy * dy;
      if (dist < minDist * minDist || dist > searchRadius * searchRadius) continue;
      // Already removed?
      if (removedTrees.has(tree.py * NN + tree.px)) continue;
      // Across river?
      if (riverMask && this._pathCrossesRiver(hutPx, hutPy, tree.px, tree.py, riverMask, NN)) continue;
      candidates.push({ tree, dist });
    }

    candidates.sort((a, b) => a.dist - b.dist);

    // Pick from nearest with randomness, avoiding trees too close together
    const result: PlacedTree[] = [];
    const used = new Set<number>();
    for (let i = 0; i < count && candidates.length > 0; i++) {
      const pool = candidates.filter((_, ci) => !used.has(ci)).slice(0, 5);
      if (pool.length === 0) break;
      const pick = pool[Math.floor(rng() * pool.length)];
      result.push(pick.tree);
      const pickIdx = candidates.indexOf(pick);
      used.add(pickIdx);
      // Don't pick two trees right next to each other
      for (let ci = 0; ci < candidates.length; ci++) {
        if (used.has(ci)) continue;
        const c = candidates[ci];
        if ((c.tree.px - pick.tree.px) ** 2 + (c.tree.py - pick.tree.py) ** 2 < 8 * 8) used.add(ci);
      }
    }

    return result;
  }

  // ── Check if a straight line crosses river ───────────────────────────────
  private _pathCrossesRiver(
    x0: number, y0: number, x1: number, y1: number,
    riverMask: Uint8Array, NN: number,
  ): boolean {
    // Sample points along the line
    const dx = x1 - x0;
    const dy = y1 - y0;
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    if (steps === 0) return false;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const px = Math.round(x0 + dx * t);
      const py = Math.round(y0 + dy * t);
      if (px >= 0 && px < NN && py >= 0 && py < NN) {
        if (riverMask[py * NN + px]) return true;
      }
    }
    return false;
  }

  // ── Draw dirt haul path (1px Bresenham, 50% alpha blend) ─────────────────
  private _drawDirtPath(
    pixels: Uint32Array, NN: number,
    x0: number, y0: number, x1: number, y1: number,
    riverMask: Uint8Array | null,
  ): void {
    // Bresenham line
    let cx = x0, cy = y0;
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    // Dirt color to blend toward (warm brown)
    const dirtR = 0x7a, dirtG = 0x68, dirtB = 0x50;
    const alpha = 0.50;

    while (true) {
      if (cx >= 0 && cx < NN && cy >= 0 && cy < NN) {
        // Don't draw over river
        if (!riverMask || !riverMask[cy * NN + cx]) {
          const idx = cy * NN + cx;
          const existing = pixels[idx];
          const er = existing & 0xff;
          const eg = (existing >> 8) & 0xff;
          const eb = (existing >> 16) & 0xff;
          const nr = Math.round(er + (dirtR - er) * alpha);
          const ng = Math.round(eg + (dirtG - eg) * alpha);
          const nb = Math.round(eb + (dirtB - eb) * alpha);
          pixels[idx] = (255 << 24) | (nb << 16) | (ng << 8) | nr;
        }
      }
      if (cx === x1 && cy === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 < dx)  { err += dx; cy += sy; }
    }
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
    buildMask?: Uint8Array,
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

        if (cell === M) {
          const existing = pixels[idx];
          const er = existing & 0xff;
          const eg = (existing >> 8) & 0xff;
          const eb = (existing >> 16) & 0xff;
          const a = 0.55;
          const nr = Math.round(er + (0xe8 - er) * a);
          const ng = Math.round(eg + (0xe4 - eg) * a);
          const nb = Math.round(eb + (0xe0 - eb) * a);
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
        if (buildMask) buildMask[idx] = 1;
      }
    }
  }

  // ── Lumber stack stamp ───────────────────────────────────────────────────
  private _stampLumber(
    pixels: Uint32Array, NN: number, cx: number, cy: number,
    palette: WoodcutterPalette, mask: Uint8Array,
    buildMask?: Uint8Array,
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
        if (buildMask) buildMask[idx] = 1;
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
        // Don't mark wheel in mask — animator needs to overwrite these each frame
      }
    }
  }

  // ── Stone dam around wheel (sawmill) ─────────────────────────────────────
  private _stampDam(
    pixels: Uint32Array, NN: number,
    wheelCx: number, wheelCy: number,
    palette: WoodcutterPalette, mask: Uint8Array,
    riverMask: Uint8Array | null,
  ): void {
    // Draw stone dam pixels around and below the wheel
    // The dam is a small stone platform: 7 wide, 2 rows below wheel, 1 row each side
    const halfW = Math.floor(WHEEL_SIZE / 2) + 1;
    const damTop = wheelCy + Math.floor(WHEEL_SIZE / 2) + 1;

    for (let dy = 0; dy < 2; dy++) {
      for (let dx = -halfW; dx <= halfW; dx++) {
        const px = wheelCx + dx;
        const py = damTop + dy;
        if (px < 0 || px >= NN || py < 0 || py >= NN) continue;
        const idx = py * NN + px;
        const color = palette.dam[(dx + dy) & 1];
        const r = (color >> 16) & 0xff;
        const g = (color >> 8) & 0xff;
        const b = color & 0xff;
        pixels[idx] = packABGR(r, g, b);
        mask[idx] = 1;
      }
    }

    // Side walls of dam (1px each side, height of wheel)
    for (let dy = -Math.floor(WHEEL_SIZE / 2); dy <= Math.floor(WHEEL_SIZE / 2); dy++) {
      for (const side of [-halfW, halfW]) {
        const px = wheelCx + side;
        const py = wheelCy + dy;
        if (px < 0 || px >= NN || py < 0 || py >= NN) continue;
        const idx = py * NN + px;
        const color = palette.dam[Math.abs(dy) & 1];
        const r = (color >> 16) & 0xff;
        const g = (color >> 8) & 0xff;
        const b = color & 0xff;
        pixels[idx] = packABGR(r, g, b);
        mask[idx] = 1;
      }
    }
  }
}

// Export wheel frames for the animator
export { WHEEL_FRAMES, WHEEL_SIZE, WH };
