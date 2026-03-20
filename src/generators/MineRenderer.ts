/**
 * MineRenderer — static rendering of iron mine entrances and ore piles.
 *
 * Rendered once per season during _renderMapInner, before TreeRenderer so
 * trees avoid the mine clearing.
 */

import { packABGR } from './TerrainPalettes';
import { Season } from '../state/Season';
import type { MineState } from '../state/Building';

// ── Cell types ───────────────────────────────────────────────────────────────
const _ = 0;  // transparent
const ST = 1; // stone arch
const TM = 2; // timber support
const DK = 3; // dark opening
const TR = 4; // cart track rail
const M = 9;  // smoke/dust marker

// ── Mine entrance sprite (9×8, 3/4 perspective) ────────────────────────────
type SpriteTemplate = { w: number; h: number; data: number[]; anchorY: number };

const MINE_ENTRANCE: SpriteTemplate = {
  w: 9, h: 8, anchorY: 7, data: [
    _, _, _, M, _, _, _, _, _,
    _, _, ST, ST, ST, ST, ST, _, _,
    _, _, ST, DK, DK, DK, ST, _, _,
    _, _, TM, DK, DK, DK, TM, _, _,
    _, _, TM, DK, DK, DK, TM, _, _,
    _, _, ST, ST, ST, ST, ST, _, _,
    _, _, _, TR, _, TR, _, _, _,
    _, _, _, TR, _, TR, _, _, _,
  ],
};

// ── Ore pile sprite (4×2, grows with oreCount) ──────────────────────────────
const OP = 5; // ore pile cell
const ORE_SMALL: SpriteTemplate = {
  w: 3, h: 2, anchorY: 1, data: [
    _, OP, _,
    OP, OP, OP,
  ],
};
const ORE_MEDIUM: SpriteTemplate = {
  w: 4, h: 2, anchorY: 1, data: [
    OP, OP, OP, _,
    OP, OP, OP, OP,
  ],
};
const ORE_LARGE: SpriteTemplate = {
  w: 4, h: 3, anchorY: 2, data: [
    _, OP, OP, _,
    OP, OP, OP, OP,
    OP, OP, OP, OP,
  ],
};

// ── Color palettes ──────────────────────────────────────────────────────────
interface MinePalette {
  stone: number[];    // 3 shades (grey arch)
  timber: number[];   // 2 shades (support beams)
  dark: number[];     // 2 shades (mine interior)
  ore: number[];      // 3 shades (rusty brown-orange iron ore)
  track: number[];    // 2 shades (wooden rails)
}

const PALETTE_SUMMER: MinePalette = {
  stone:  [0x585050, 0x686060, 0x787070],
  timber: [0x5c4430, 0x6e5340],
  dark:   [0x181410, 0x201c14],
  ore:    [0x8a5030, 0x7a4020, 0x6a3818],
  track:  [0x4a3a28, 0x5a4a38],
};

const PALETTE_WINTER: MinePalette = {
  stone:  [0x686068, 0x787078, 0x888088],
  timber: [0x6c5440, 0x7e6350],
  dark:   [0x181410, 0x201c14],
  ore:    [0x7a4828, 0x6a3818, 0x5a3010],
  track:  [0x5a4a38, 0x6a5a48],
};

function getPalette(season: Season): MinePalette {
  if (season === Season.Winter) return PALETTE_WINTER;
  return PALETTE_SUMMER;
}

// ── Render data passed to the animator ───────────────────────────────────────
export interface MineRenderData {
  duchyIndex: number;
  entrancePx: number;
  entrancePy: number;
  rockDirX: number;
  rockDirY: number;
  oreCount: number;
  dustPx: number;       // dust emission point (above entrance arch)
  dustPy: number;
  orePilePx: number;    // ore pile position
  orePilePy: number;
}

// ── Renderer ────────────────────────────────────────────────────────────────
export class MineRenderer {
  render(
    pixels: Uint32Array,
    resolution: number,
    mines: Map<number, MineState>,
    seed: number,
    season: Season,
  ): { mineMask: Uint8Array; mineBuildingMask: Uint8Array; renderData: MineRenderData[] } {
    const NN = resolution;
    const palette = getPalette(season);
    const mask = new Uint8Array(NN * NN);
    const buildMask = new Uint8Array(NN * NN);
    const renderData: MineRenderData[] = [];

    for (const [_di, mine] of mines) {
      const { entrancePx, entrancePy, oreCount, duchyIndex, rockDirX, rockDirY } = mine;

      if (entrancePx < 15 || entrancePy < 15 ||
          entrancePx >= NN - 15 || entrancePy >= NN - 15) continue;

      // Clear area around mine
      const clearRadius = 12;
      for (let dy = -clearRadius; dy <= clearRadius; dy++) {
        for (let dx = -clearRadius; dx <= clearRadius; dx++) {
          if (dx * dx + dy * dy > clearRadius * clearRadius) continue;
          const px = entrancePx + dx;
          const py = entrancePy + dy;
          if (px >= 0 && px < NN && py >= 0 && py < NN) {
            mask[py * NN + px] = 1;
          }
        }
      }

      // Stamp shadow
      this._stampShadow(pixels, NN, entrancePx, entrancePy, MINE_ENTRANCE);

      // Stamp mine entrance sprite
      this._stampSprite(pixels, NN, entrancePx, entrancePy, MINE_ENTRANCE, palette, mask, buildMask);

      // Dust position (above entrance arch)
      const dustPx = entrancePx;
      const dustPy = entrancePy - MINE_ENTRANCE.anchorY;

      // Ore pile position — placed perpendicular to rock direction
      const perpX = -rockDirY;
      const perpY = rockDirX;
      const orePilePx = Math.round(entrancePx + perpX * 6);
      const orePilePy = Math.round(entrancePy + perpY * 6);

      // Stamp ore pile
      if (oreCount > 0) {
        const oreTmpl = oreCount >= 13 ? ORE_LARGE : (oreCount >= 5 ? ORE_MEDIUM : ORE_SMALL);
        this._stampOrePile(pixels, NN, orePilePx, orePilePy, oreTmpl, palette, mask, buildMask);
      }

      renderData.push({
        duchyIndex,
        entrancePx,
        entrancePy,
        rockDirX,
        rockDirY,
        oreCount,
        dustPx,
        dustPy,
        orePilePx,
        orePilePy,
      });
    }

    return { mineMask: mask, mineBuildingMask: buildMask, renderData };
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
    tmpl: SpriteTemplate, palette: MinePalette, mask: Uint8Array,
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
          // Dust hint (semi-transparent brownish)
          const existing = pixels[idx];
          const er = existing & 0xff;
          const eg = (existing >> 8) & 0xff;
          const eb = (existing >> 16) & 0xff;
          const a = 0.35;
          const nr = Math.round(er + (0xc0 - er) * a);
          const ng = Math.round(eg + (0xb0 - eg) * a);
          const nb = Math.round(eb + (0xa0 - eb) * a);
          pixels[idx] = (255 << 24) | (nb << 16) | (ng << 8) | nr;
          continue;
        }

        let color: number;
        switch (cell) {
          case ST: color = palette.stone[Math.min(2, Math.floor(sx / 3))]; break;
          case TM: color = palette.timber[sy % 2]; break;
          case DK: color = palette.dark[sx % 2]; break;
          case TR: color = palette.track[sx % 2]; break;
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

  // ── Ore pile stamp ────────────────────────────────────────────────────────
  private _stampOrePile(
    pixels: Uint32Array, NN: number, cx: number, cy: number,
    tmpl: SpriteTemplate, palette: MinePalette, mask: Uint8Array,
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
        const color = palette.ore[(sx + sy) % 3];
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

// Re-export for convenience
export { MINE_ENTRANCE };
