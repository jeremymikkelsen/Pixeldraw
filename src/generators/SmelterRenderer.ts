/**
 * SmelterRenderer — static rendering of smelter buildings, ingot piles,
 * and slag piles.
 *
 * Rendered once per season during _renderMapInner, before TreeRenderer so
 * trees avoid the smelter clearing.
 */

import { packABGR } from './TerrainPalettes';
import { Season } from '../state/Season';
import type { SmelterState } from '../state/Building';

// ── Cell types ───────────────────────────────────────────────────────────────
const _ = 0;  // transparent
const W = 1;  // wall (wood)
const R = 2;  // roof (slate/dark)
const D = 3;  // door
const S = 4;  // stone foundation
const N = 5;  // window
const F = 6;  // furnace glow
const K = 7;  // chimney (stone, 3px wide)
const E = 8;  // east/side wall
const M = 9;  // smoke marker
const IG = 10; // ingot pile
const SL = 11; // slag pile

// ── Smelter building sprite (11×11, 3/4 perspective) ────────────────────────
type SpriteTemplate = { w: number; h: number; data: number[]; anchorY: number };

const SMELTER_BUILDING: SpriteTemplate = {
  w: 11, h: 11, anchorY: 10, data: [
    _, _, _, _, M, M, _, _, _, _, _,
    _, _, _, K, K, K, _, _, _, _, _,
    _, _, _, K, K, K, _, _, _, _, _,
    _, _, R, R, R, R, R, R, _, _, _,
    _, R, R, R, R, R, R, R, R, _, _,
    _, R, R, R, R, R, R, R, R, _, _,
    _, W, W, N, W, K, K, W, E, E, _,
    _, W, W, F, W, W, W, D, E, E, _,
    _, S, S, S, S, S, S, S, S, S, _,
    _, S, S, S, S, S, S, S, S, S, _,
    _, _, _, _, _, _, _, _, _, _, _,
  ],
};

// ── Ingot pile sprite (5×2) ─────────────────────────────────────────────────
const INGOT_PILE: SpriteTemplate = {
  w: 5, h: 2, anchorY: 1, data: [
    IG, IG, IG, IG, IG,
    IG, IG, IG, IG, IG,
  ],
};

// ── Slag pile sprite (3×2) ──────────────────────────────────────────────────
const SLAG_PILE: SpriteTemplate = {
  w: 3, h: 2, anchorY: 1, data: [
    SL, SL, _,
    SL, SL, SL,
  ],
};

// ── Color palettes ──────────────────────────────────────────────────────────
interface SmelterPalette {
  wall: number[];     // 3 shades
  roof: number[];     // 3 shades (darker/industrial)
  stone: number[];    // 2 shades (heavy foundation)
  door: number;
  window: number;
  chimney: number[];  // 3 shades (stone chimney)
  furnace: number[];  // 2 shades (hot glow)
  ingot: number[];    // 3 shades (dark metallic grey)
  slag: number[];     // 2 shades (dark waste)
}

const PALETTE_SUMMER: SmelterPalette = {
  wall:    [0x4a3520, 0x5c4430, 0x6e5340],
  roof:    [0x585058, 0x686068, 0x787078],
  stone:   [0x484040, 0x585050],
  door:    0x3a2810,
  window:  0x4488bb,
  chimney: [0x585050, 0x686060, 0x787070],
  furnace: [0xc04020, 0xe06030],
  ingot:   [0x505860, 0x606870, 0x707880],
  slag:    [0x3a3430, 0x4a4440],
};

const PALETTE_WINTER: SmelterPalette = {
  wall:    [0x5a4530, 0x6c5440, 0x7e6350],
  roof:    [0xa0a0a8, 0xb0b0b8, 0xc0c0c8],
  stone:   [0x585058, 0x686068],
  door:    0x4a3820,
  window:  0x3a78a8,
  chimney: [0x686068, 0x787078, 0x888088],
  furnace: [0xc04020, 0xe06030],
  ingot:   [0x586068, 0x687078, 0x788088],
  slag:    [0x3a3438, 0x4a4448],
};

function getPalette(season: Season): SmelterPalette {
  if (season === Season.Winter) return PALETTE_WINTER;
  return PALETTE_SUMMER;
}

// ── Render data passed to the animator ───────────────────────────────────────
export interface SmelterRenderData {
  duchyIndex: number;
  buildingPx: number;
  buildingPy: number;
  nearRiver: boolean;
  ingotCount: number;
  chimneyPx: number;
  chimneyPy: number;
  furnacePx: number;
  furnacePy: number;
  ingotPilePx: number;
  ingotPilePy: number;
}

// ── Renderer ────────────────────────────────────────────────────────────────
export class SmelterRenderer {
  render(
    pixels: Uint32Array,
    resolution: number,
    smelters: Map<number, SmelterState>,
    seed: number,
    season: Season,
  ): { smelterMask: Uint8Array; smelterBuildingMask: Uint8Array; renderData: SmelterRenderData[] } {
    const NN = resolution;
    const palette = getPalette(season);
    const mask = new Uint8Array(NN * NN);
    const buildMask = new Uint8Array(NN * NN);
    const renderData: SmelterRenderData[] = [];

    for (const [_di, smelter] of smelters) {
      const { buildingPx, buildingPy, ingotCount, duchyIndex, nearRiver } = smelter;

      if (buildingPx < 15 || buildingPy < 15 ||
          buildingPx >= NN - 15 || buildingPy >= NN - 15) continue;

      // Clear area around smelter
      const clearRadius = 14;
      for (let dy = -clearRadius; dy <= clearRadius; dy++) {
        for (let dx = -clearRadius; dx <= clearRadius; dx++) {
          if (dx * dx + dy * dy > clearRadius * clearRadius) continue;
          const px = buildingPx + dx;
          const py = buildingPy + dy;
          if (px >= 0 && px < NN && py >= 0 && py < NN) {
            mask[py * NN + px] = 1;
          }
        }
      }

      // Stamp shadow
      this._stampShadow(pixels, NN, buildingPx, buildingPy, SMELTER_BUILDING);

      // Stamp building
      this._stampSprite(pixels, NN, buildingPx, buildingPy, SMELTER_BUILDING, palette, mask, buildMask);

      // Chimney position (above the chimney columns)
      const chimneyPx = buildingPx - Math.floor(SMELTER_BUILDING.w / 2) + 4;
      const chimneyPy = buildingPy - SMELTER_BUILDING.anchorY;

      // Furnace position (front face glow)
      const furnacePx = buildingPx - Math.floor(SMELTER_BUILDING.w / 2) + 3;
      const furnacePy = buildingPy - SMELTER_BUILDING.anchorY + 7;

      // Ingot pile — right of building
      const ingotPilePx = buildingPx + 7;
      const ingotPilePy = buildingPy - 1;

      if (ingotCount > 0) {
        this._stampPile(pixels, NN, ingotPilePx, ingotPilePy, INGOT_PILE, palette.ingot, mask, buildMask);
      }

      // Slag pile — left of building
      const slagPx = buildingPx - 7;
      const slagPy = buildingPy;
      this._stampPile(pixels, NN, slagPx, slagPy, SLAG_PILE, palette.slag, mask, buildMask);

      renderData.push({
        duchyIndex,
        buildingPx,
        buildingPy,
        nearRiver,
        ingotCount,
        chimneyPx,
        chimneyPy,
        furnacePx,
        furnacePy,
        ingotPilePx,
        ingotPilePy,
      });
    }

    return { smelterMask: mask, smelterBuildingMask: buildMask, renderData };
  }

  // ── Shadow stamp ──────────────────────────────────────────────────────────
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

  // ── Sprite stamp ──────────────────────────────────────────────────────────
  private _stampSprite(
    pixels: Uint32Array, NN: number, cx: number, cy: number,
    tmpl: SpriteTemplate, palette: SmelterPalette, mask: Uint8Array,
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
          // Smoke hint (darker/sootier than woodcutter)
          const existing = pixels[idx];
          const er = existing & 0xff;
          const eg = (existing >> 8) & 0xff;
          const eb = (existing >> 16) & 0xff;
          const a = 0.60;
          const nr = Math.round(er + (0xd8 - er) * a);
          const ng = Math.round(eg + (0xd0 - eg) * a);
          const nb = Math.round(eb + (0xc0 - eb) * a);
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
          case K: color = palette.chimney[Math.min(2, sy % 3)]; break;
          case F: color = palette.furnace[0]; break;
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

  // ── Generic pile stamp ────────────────────────────────────────────────────
  private _stampPile(
    pixels: Uint32Array, NN: number, cx: number, cy: number,
    tmpl: SpriteTemplate, colors: number[], mask: Uint8Array,
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
        const color = colors[(sx + sy) % colors.length];
        const r = (color >> 16) & 0xff;
        const g = (color >> 8) & 0xff;
        const b = color & 0xff;
        pixels[idx] = packABGR(r, g, b);
        mask[idx] = 1;
        if (buildMask) buildMask[idx] = 1;
      }
    }
  }
}
