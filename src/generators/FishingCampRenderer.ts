/**
 * FishingCampRenderer — static rendering of fishing camps.
 *
 * Each camp has:
 *  - Packed dirt ground
 *  - Processing hut with smoking chimney
 *  - Two fish drying racks
 *  - Ocean: pier extending toward water with a moored boat
 *  - River: long skinny wharf parallel to bank with static fishermen
 */

import { packABGR } from './TerrainPalettes';
import { Season } from '../state/Season';
import type { FishingCampState } from '../state/Building';

// ── Seasonal dirt palette (matches FarmRenderer field-dirt look) ─────────────
const DIRT_COLOR: Record<Season, number> = {
  [Season.Winter]: packABGR(0x7a, 0x6a, 0x5a),
  [Season.Spring]: packABGR(0x56, 0x3c, 0x20),
  [Season.Summer]: packABGR(0x50, 0x38, 0x1c),
  [Season.Fall]:   packABGR(0x5c, 0x40, 0x22),
};

// ── Cell type tokens ─────────────────────────────────────────────────────────
const _ = 0;
const W = 1;   // wall (wood)
const R = 2;   // roof (thatch)
const D = 3;   // door
const S = 4;   // stone foundation
const N = 5;   // window
const K = 7;   // chimney
const E = 8;   // east/side wall
const M = 9;   // smoke placeholder (blended, not solid)
const PO = 20; // rack pole
const CR = 21; // rack crossbar
const FH = 22; // fish hanging on rack
const PL = 23; // dock plank

// ── Sprite templates ─────────────────────────────────────────────────────────
type SpriteTemplate = { w: number; h: number; data: number[]; anchorY: number };

const FISHING_HUT: SpriteTemplate = {
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

// Fish drying rack: two end-posts, horizontal crossbar, fish hanging below
const FISH_RACK: SpriteTemplate = {
  w: 7, h: 4, anchorY: 3, data: [
    PO, CR, CR, CR, CR, CR, PO,
    _,  FH, _,  FH, _,  FH, _,
    _,  _,  _,  _,  _,  _,  _,
    _,  _,  _,  _,  _,  _,  _,
  ],
};

// ── Palettes ─────────────────────────────────────────────────────────────────
interface FishingPalette {
  wall:    number[];
  roof:    number[];
  stone:   number[];
  door:    number;
  window:  number;
  chimney: number[];
  rack:    number[];
  fish:    number[];
  plank:   number[];
  boat:    number[];
  person:  number;
  leg:     number;
  rod:     number;
}

const PALETTE_SUMMER: FishingPalette = {
  wall:    [0x4a3520, 0x5c4430, 0x6e5340],
  roof:    [0x8a7a40, 0x9c8c50, 0xae9e60],
  stone:   [0x585050, 0x686060],
  door:    0x3a2810,
  window:  0x4488bb,
  chimney: [0x887070, 0x988080],
  rack:    [0x6e4820, 0x5a3a18],
  fish:    [0xc0785c, 0xa86040],
  plank:   [0x8a7040, 0x9c8250, 0x7a6030],
  boat:    [0x3a2810, 0x5a4030, 0x7a5840],
  person:  0x5c7840,  // generic worker color
  leg:     0x5a4838,
  rod:     0x5a4020,
};

const PALETTE_WINTER: FishingPalette = {
  wall:    [0x4a3520, 0x5c4430, 0x6e5340],
  roof:    [0xc8c8d0, 0xd4d4dc, 0xe0e0e8],
  stone:   [0x585058, 0x686068],
  door:    0x3a2810,
  window:  0x3a78a8,
  chimney: [0x887070, 0x988080],
  rack:    [0x4a3010, 0x3a2408],
  fish:    [0xa06848, 0x885030],
  plank:   [0x706030, 0x826040, 0x605020],
  boat:    [0x2c2010, 0x483020, 0x604030],
  person:  0x4a6030,
  leg:     0x4a3828,
  rod:     0x4a3010,
};

function getPalette(season: Season): FishingPalette {
  return season === Season.Winter ? PALETTE_WINTER : PALETTE_SUMMER;
}

// ── Render data passed to animator ───────────────────────────────────────────
export interface FishingCampRenderData {
  duchyIndex: number;
  variant: 'ocean' | 'river';
  hutPx: number;
  hutPy: number;
  dockPx: number;
  dockPy: number;
  waterDirX: number;
  waterDirY: number;
  chimneyPx: number;
  chimneyPy: number;
  // Where the static moored boat is drawn (boat returns here)
  mooredPx: number;
  mooredPy: number;
  // Far fishing spot where boat sails to
  fishingPx: number;
  fishingPy: number;
  // Positions of the two drying racks (for worker animation)
  rackPositions: { px: number; py: number }[];
}

// ── Renderer ─────────────────────────────────────────────────────────────────
export class FishingCampRenderer {
  render(
    pixels: Uint32Array,
    resolution: number,
    fishingCamps: Map<number, FishingCampState>,
    season: Season,
    riverMask: Uint8Array | null,
    regionGrid: Uint16Array | null,
  ): { campMask: Uint8Array; renderData: FishingCampRenderData[] } {
    const NN = resolution;
    const palette = getPalette(season);
    const mask = new Uint8Array(NN * NN);
    const renderData: FishingCampRenderData[] = [];

    // Paint all camp regions as dirt first (single pass over regionGrid)
    if (regionGrid) {
      const dirtColor = DIRT_COLOR[season];
      for (const [, camp] of fishingCamps) {
        const ri = camp.regionIndex;
        for (let i = 0; i < NN * NN; i++) {
          if (regionGrid[i] !== ri) continue;
          if (riverMask && riverMask[i]) continue; // keep river pixels visible
          pixels[i] = dirtColor;
          mask[i] = 1;
        }
      }
    }

    for (const [, camp] of fishingCamps) {
      const { hutPx, hutPy, dockPx, dockPy, waterDirX, waterDirY, variant, duchyIndex } = camp;

      if (hutPx < 20 || hutPy < 20 || hutPx >= NN - 20 || hutPy >= NN - 20) continue;

      const perpX = -waterDirY;
      const perpY =  waterDirX;

      // ── Dock or wharf ────────────────────────────────────────────────────
      if (variant === 'ocean') {
        this._drawPier(pixels, NN, hutPx, hutPy, dockPx, dockPy, palette, mask);
      } else {
        // River: short wharf at water's edge, no pier needed (hut is close)
        this._drawWharf(pixels, NN, dockPx, dockPy, waterDirX, waterDirY, palette, mask);
      }
      // Moored boat for both variants (at pier/wharf tip)
      this._drawBoat(pixels, NN, dockPx, dockPy, waterDirX, waterDirY, palette, mask);

      // ── Fish drying racks (either side of hut, away from water) ─────────
      const rackPositions: { px: number; py: number }[] = [];
      for (const side of [-1, 1]) {
        const rx = Math.round(hutPx + perpX * 6 * side + waterDirX * (-5));
        const ry = Math.round(hutPy + perpY * 6 * side + waterDirY * (-5));
        this._stampRack(pixels, NN, rx, ry, palette, mask);
        rackPositions.push({ px: rx, py: ry });
      }

      // ── Hut ─────────────────────────────────────────────────────────────
      this._stampShadow(pixels, NN, hutPx, hutPy, FISHING_HUT);
      this._stampHut(pixels, NN, hutPx, hutPy, palette, mask);

      // ── Chimney position ─────────────────────────────────────────────────
      const chimneyPx = hutPx - Math.floor(FISHING_HUT.w / 2) + 3;
      const chimneyPy = hutPy - FISHING_HUT.anchorY;

      // ── Moored boat position (where static boat is drawn) ────────────────
      const mooredPx = Math.round(dockPx + waterDirX * 3);
      const mooredPy = Math.round(dockPy + waterDirY * 3);

      // ── Fishing spot (boat sails here to fish with nets) ─────────────────
      const fishingDist = variant === 'ocean' ? 45 : 55;
      const fishingPx = Math.round(dockPx + waterDirX * fishingDist);
      const fishingPy = Math.round(dockPy + waterDirY * fishingDist);

      renderData.push({
        duchyIndex,
        variant,
        hutPx, hutPy,
        dockPx, dockPy,
        waterDirX, waterDirY,
        chimneyPx, chimneyPy,
        mooredPx, mooredPy,
        fishingPx, fishingPy,
        rackPositions,
      });
    }

    return { campMask: mask, renderData };
  }

  // ── Ocean pier (plank line + T-head) ─────────────────────────────────────
  private _drawPier(
    pixels: Uint32Array, NN: number,
    x0: number, y0: number, x1: number, y1: number,
    palette: FishingPalette, mask: Uint8Array,
  ): void {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return;
    const nx = dx / len, ny = dy / len;
    const perpX = -ny, perpY = nx;

    // Plank run: 3 wide
    const steps = Math.ceil(len);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const cx = Math.round(x0 + dx * t);
      const cy = Math.round(y0 + dy * t);
      for (let side = -1; side <= 1; side++) {
        const px = Math.round(cx + perpX * side);
        const py = Math.round(cy + perpY * side);
        if (px < 0 || px >= NN || py < 0 || py >= NN) continue;
        const idx = py * NN + px;
        const shade = (i + Math.abs(side)) % palette.plank.length;
        const color = palette.plank[shade];
        pixels[idx] = packABGR((color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff);
        mask[idx] = 1;
      }
    }

    // T-head at far end (7 wide, 2 deep)
    for (let depth = 0; depth < 2; depth++) {
      for (let side = -3; side <= 3; side++) {
        const px = Math.round(x1 + nx * depth + perpX * side);
        const py = Math.round(y1 + ny * depth + perpY * side);
        if (px < 0 || px >= NN || py < 0 || py >= NN) continue;
        const idx = py * NN + px;
        const shade = (Math.abs(side) + depth) % palette.plank.length;
        const color = palette.plank[shade];
        pixels[idx] = packABGR((color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff);
        mask[idx] = 1;
      }
    }
  }

  // ── River wharf (short dock at water's edge, parallel to bank) ───────────
  private _drawWharf(
    pixels: Uint32Array, NN: number,
    dockPx: number, dockPy: number,
    waterDirX: number, waterDirY: number,
    palette: FishingPalette, mask: Uint8Array,
  ): void {
    const perpX = -waterDirY, perpY = waterDirX;
    // Centered at the water's edge (dockPx/dockPy)
    const halfLen = 6; // ±6 along bank = 13 total
    const wharfDepth = 2; // 2 planks deep toward water

    for (let along = -halfLen; along <= halfLen; along++) {
      for (let across = 0; across < wharfDepth; across++) {
        const px = Math.round(dockPx + perpX * along + waterDirX * across);
        const py = Math.round(dockPy + perpY * along + waterDirY * across);
        if (px < 0 || px >= NN || py < 0 || py >= NN) continue;
        const idx = py * NN + px;
        const shade = (Math.abs(along) + across) % palette.plank.length;
        const color = palette.plank[shade];
        pixels[idx] = packABGR((color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff);
        mask[idx] = 1;
      }
    }
  }

  // ── River fishermen (2 people casting from wharf) ────────────────────────
  private _drawRiverFishermen(
    pixels: Uint32Array, NN: number,
    hutPx: number, hutPy: number,
    waterDirX: number, waterDirY: number,
    palette: FishingPalette, mask: Uint8Array,
  ): void {
    const perpX = -waterDirY, perpY = waterDirX;
    const bankX = Math.round(hutPx + waterDirX * 9);
    const bankY = Math.round(hutPy + waterDirY * 9);

    const HEAD_COLOR = packABGR(0xc8, 0xa8, 0x80);
    const bodyColor  = packABGR((palette.person >> 16) & 0xff, (palette.person >> 8) & 0xff, palette.person & 0xff);
    const legColor   = packABGR((palette.leg >> 16) & 0xff, (palette.leg >> 8) & 0xff, palette.leg & 0xff);
    const rodColor   = packABGR((palette.rod >> 16) & 0xff, (palette.rod >> 8) & 0xff, palette.rod & 0xff);

    // Two fishermen at -5 and +5 along the wharf
    for (const along of [-5, 5]) {
      const wx = Math.round(bankX + perpX * along);
      const wy = Math.round(bankY + perpY * along);

      // Person (3 rows: head, body, legs)
      const personPixels: [number, number, number][] = [
        [wx, wy - 2, HEAD_COLOR],
        [wx, wy - 1, bodyColor],
        [wx, wy,     legColor],
      ];
      for (const [px, py, color] of personPixels) {
        if (px < 0 || px >= NN || py < 0 || py >= NN) continue;
        const idx = py * NN + px;
        pixels[idx] = color;
        mask[idx] = 1;
      }

      // Fishing rod: 4px toward water from the person
      for (let i = 1; i <= 4; i++) {
        const rpx = Math.round(wx + waterDirX * i);
        const rpy = Math.round(wy - 1 + waterDirY * i);
        if (rpx < 0 || rpx >= NN || rpy < 0 || rpy >= NN) continue;
        const idx = rpy * NN + rpx;
        pixels[idx] = rodColor;
        mask[idx] = 1;
      }

      // Fishing line: drops down 3px from rod tip
      const rtx = Math.round(wx + waterDirX * 4);
      const rty = Math.round(wy - 1 + waterDirY * 4);
      for (let j = 1; j <= 3; j++) {
        const lpx = rtx;
        const lpy = rty + j;
        if (lpx < 0 || lpx >= NN || lpy < 0 || lpy >= NN) continue;
        const idx = lpy * NN + lpx;
        pixels[idx] = rodColor;
        mask[idx] = 1;
      }
    }
  }

  // ── Moored boat at dock tip ───────────────────────────────────────────────
  private _drawBoat(
    pixels: Uint32Array, NN: number,
    cx: number, cy: number,
    waterDirX: number, waterDirY: number,
    palette: FishingPalette, mask: Uint8Array,
  ): void {
    // Boat hull: 5×3 oval, offset slightly beyond dock tip
    const bx = Math.round(cx + waterDirX * 3);
    const by = Math.round(cy + waterDirY * 3);
    const perpX = -waterDirY, perpY = waterDirX;

    // 3 rows: narrow, wide, narrow
    const rows = [
      { width: 1, offset: 0 },
      { width: 2, offset: 0 },
      { width: 1, offset: 1 },
    ];
    for (let row = 0; row < rows.length; row++) {
      const { width, offset } = rows[row];
      for (let side = -width; side <= width; side++) {
        const px = Math.round(bx + perpX * side + waterDirX * (row + offset));
        const py = Math.round(by + perpY * side + waterDirY * (row + offset));
        if (px < 0 || px >= NN || py < 0 || py >= NN) continue;
        const idx = py * NN + px;
        const shade = Math.abs(side) > 1 ? 0 : (row === 1 ? 2 : 1);
        const color = palette.boat[shade];
        pixels[idx] = packABGR((color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff);
        mask[idx] = 1;
      }
    }
  }

  // ── Fish drying rack stamp ────────────────────────────────────────────────
  private _stampRack(
    pixels: Uint32Array, NN: number,
    cx: number, cy: number,
    palette: FishingPalette, mask: Uint8Array,
  ): void {
    const startX = cx - Math.floor(FISH_RACK.w / 2);
    const startY = cy - FISH_RACK.anchorY;
    for (let sy = 0; sy < FISH_RACK.h; sy++) {
      for (let sx = 0; sx < FISH_RACK.w; sx++) {
        const cell = FISH_RACK.data[sy * FISH_RACK.w + sx];
        if (cell === 0) continue;
        const px = startX + sx, py = startY + sy;
        if (px < 0 || px >= NN || py < 0 || py >= NN) continue;
        const idx = py * NN + px;
        let color: number;
        switch (cell) {
          case PO: color = palette.rack[(sx + sy) % 2]; break;
          case CR: color = palette.rack[0]; break;
          case FH: color = palette.fish[(sx + sy) % 2]; break;
          default: continue;
        }
        pixels[idx] = packABGR((color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff);
        mask[idx] = 1;
      }
    }
  }

  // ── Hut shadow ───────────────────────────────────────────────────────────
  private _stampShadow(
    pixels: Uint32Array, NN: number,
    cx: number, cy: number, tmpl: SpriteTemplate,
  ): void {
    const startX = cx - Math.floor(tmpl.w / 2);
    const startY = cy - tmpl.anchorY;
    const SKEW_X = 0.45, SKEW_Y = 0.35, DARKEN = 0.50;
    for (let sy = 0; sy < tmpl.h; sy++) {
      for (let sx = 0; sx < tmpl.w; sx++) {
        const cell = tmpl.data[sy * tmpl.w + sx];
        if (cell === 0 || cell === M) continue;
        const h = tmpl.anchorY - sy;
        const px = startX + sx + Math.round(h * SKEW_X) + 1;
        const py = startY + sy + Math.round(h * SKEW_Y);
        if (px < 0 || px >= NN || py < 0 || py >= NN) continue;
        const orig = pixels[py * NN + px];
        const r = Math.floor((orig & 0xff) * DARKEN);
        const g = Math.floor(((orig >> 8) & 0xff) * DARKEN);
        const b = Math.floor(((orig >> 16) & 0xff) * DARKEN);
        pixels[py * NN + px] = (255 << 24) | (b << 16) | (g << 8) | r;
      }
    }
  }

  // ── Hut sprite stamp ─────────────────────────────────────────────────────
  private _stampHut(
    pixels: Uint32Array, NN: number,
    cx: number, cy: number,
    palette: FishingPalette, mask: Uint8Array,
  ): void {
    const tmpl = FISHING_HUT;
    const startX = cx - Math.floor(tmpl.w / 2);
    const startY = cy - tmpl.anchorY;
    for (let sy = 0; sy < tmpl.h; sy++) {
      for (let sx = 0; sx < tmpl.w; sx++) {
        const cell = tmpl.data[sy * tmpl.w + sx];
        if (cell === 0) continue;
        const px = startX + sx, py = startY + sy;
        if (px < 0 || px >= NN || py < 0 || py >= NN) continue;
        const idx = py * NN + px;

        if (cell === M) {
          // Smoke placeholder: slight white blend
          const existing = pixels[idx];
          const a = 0.45;
          const nr = Math.round((existing & 0xff) + (0xe8 - (existing & 0xff)) * a);
          const ng = Math.round(((existing >> 8) & 0xff) + (0xe4 - ((existing >> 8) & 0xff)) * a);
          const nb = Math.round(((existing >> 16) & 0xff) + (0xe0 - ((existing >> 16) & 0xff)) * a);
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
        pixels[idx] = packABGR((color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff);
        mask[idx] = 1;
      }
    }
  }
}
