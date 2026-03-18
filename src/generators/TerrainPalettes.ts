import type { TerrainType } from './TopographyGenerator';
import { Season } from '../state/Season';

export interface TerrainPalette {
  base: number[];      // RGB hex colors, ordered dark → light (3-5 shades)
  detailFreq: number;  // simplex noise frequency for intra-terrain variation
  detailAmp: number;   // how strongly noise modulates palette index (0..1)
}

// Default (Summer) palettes — the baseline
const PALETTES_SUMMER: Record<TerrainType, TerrainPalette> = {
  ocean:    { base: [0x1a2e4a, 0x223d5e, 0x2a4a6b, 0x325878, 0x3a6585], detailFreq: 0.06, detailAmp: 0.7 },
  water:    { base: [0x1e3450, 0x264264, 0x2e5070, 0x385e7e, 0x406c8c], detailFreq: 0.07, detailAmp: 0.7 },
  coast:    { base: [0x5a8840, 0x6a9c50, 0x7aac6a, 0x8abc70, 0x9acc80], detailFreq: 0.15, detailAmp: 0.6 },
  lowland:  { base: [0x356828, 0x3e7c30, 0x4a8c40, 0x58a048, 0x65ac55], detailFreq: 0.18, detailAmp: 0.7 },
  highland: { base: [0x2a5420, 0x336428, 0x3a6c30, 0x447a38, 0x4e8840], detailFreq: 0.14, detailAmp: 0.6 },
  rock:     { base: [0x605848, 0x706858, 0x8c8070, 0x9c9080, 0xaca090], detailFreq: 0.20, detailAmp: 0.9 },
  cliff:    { base: [0x706050, 0x887868, 0xa09080, 0xb0a090, 0xc0b0a0], detailFreq: 0.22, detailAmp: 0.9 },
};

// Spring: lush greens, slightly brighter than summer
const PALETTES_SPRING: Record<TerrainType, TerrainPalette> = {
  ocean:    { base: [0x1a2e4a, 0x223d5e, 0x2a4a6b, 0x325878, 0x3a6585], detailFreq: 0.06, detailAmp: 0.7 },
  water:    { base: [0x1e3450, 0x264264, 0x2e5070, 0x385e7e, 0x406c8c], detailFreq: 0.07, detailAmp: 0.7 },
  coast:    { base: [0x4e9838, 0x5eac48, 0x70bc5a, 0x82cc68, 0x94dc78], detailFreq: 0.15, detailAmp: 0.6 },
  lowland:  { base: [0x2e7820, 0x389028, 0x44a038, 0x54b448, 0x64c458], detailFreq: 0.18, detailAmp: 0.7 },
  highland: { base: [0x286020, 0x307428, 0x388430, 0x429438, 0x4ea040], detailFreq: 0.14, detailAmp: 0.6 },
  rock:     { base: [0x605848, 0x706858, 0x8c8070, 0x9c9080, 0xaca090], detailFreq: 0.20, detailAmp: 0.9 },
  cliff:    { base: [0x706050, 0x887868, 0xa09080, 0xb0a090, 0xc0b0a0], detailFreq: 0.22, detailAmp: 0.9 },
};

// Fall: same green ground as summer — seasonal change is in the trees, not the grass
const PALETTES_FALL: Record<TerrainType, TerrainPalette> = {
  ocean:    { base: [0x1a2e4a, 0x223d5e, 0x2a4a6b, 0x325878, 0x3a6585], detailFreq: 0.06, detailAmp: 0.7 },
  water:    { base: [0x1e3450, 0x264264, 0x2e5070, 0x385e7e, 0x406c8c], detailFreq: 0.07, detailAmp: 0.7 },
  coast:    { base: [0x5a8840, 0x6a9c50, 0x7aac6a, 0x8abc70, 0x9acc80], detailFreq: 0.15, detailAmp: 0.6 },
  lowland:  { base: [0x356828, 0x3e7c30, 0x4a8c40, 0x58a048, 0x65ac55], detailFreq: 0.18, detailAmp: 0.7 },
  highland: { base: [0x2a5420, 0x336428, 0x3a6c30, 0x447a38, 0x4e8840], detailFreq: 0.14, detailAmp: 0.6 },
  rock:     { base: [0x605848, 0x706858, 0x8c8070, 0x9c9080, 0xaca090], detailFreq: 0.20, detailAmp: 0.9 },
  cliff:    { base: [0x706050, 0x887868, 0xa09080, 0xb0a090, 0xc0b0a0], detailFreq: 0.22, detailAmp: 0.9 },
};

// Winter: mostly snow-covered; base colors are bright spring green for visible patches
const PALETTES_WINTER: Record<TerrainType, TerrainPalette> = {
  ocean:    { base: [0x182838, 0x1e3448, 0x264058, 0x2e4c66, 0x365874], detailFreq: 0.06, detailAmp: 0.7 },
  water:    { base: [0x1c2e40, 0x223a50, 0x2a465e, 0x32526c, 0x3a5e7a], detailFreq: 0.07, detailAmp: 0.7 },
  coast:    { base: [0x3c8030, 0x4c9440, 0x5ca850, 0x6cbc60, 0x7ccc70], detailFreq: 0.15, detailAmp: 0.6 },
  lowland:  { base: [0x2e7820, 0x389028, 0x44a438, 0x54b848, 0x64c858], detailFreq: 0.18, detailAmp: 0.7 },
  highland: { base: [0x286820, 0x347c28, 0x409030, 0x4ca438, 0x58b440], detailFreq: 0.14, detailAmp: 0.6 },
  rock:     { base: [0x585858, 0x686868, 0x808080, 0x909090, 0xa0a0a0], detailFreq: 0.20, detailAmp: 0.9 },
  cliff:    { base: [0x686068, 0x807880, 0x989098, 0xa8a0a8, 0xb8b0b8], detailFreq: 0.22, detailAmp: 0.9 },
};

const SEASONAL_PALETTES: Record<Season, Record<TerrainType, TerrainPalette>> = {
  [Season.Spring]: PALETTES_SPRING,
  [Season.Summer]: PALETTES_SUMMER,
  [Season.Fall]:   PALETTES_FALL,
  [Season.Winter]: PALETTES_WINTER,
};

/** Get terrain palettes for a given season. Defaults to Summer. */
export function getPalettes(season: Season = Season.Summer): Record<TerrainType, TerrainPalette> {
  return SEASONAL_PALETTES[season];
}

/** Legacy alias — summer palettes */
export const PALETTES = PALETTES_SUMMER;

// Bayer 4×4 ordered dither matrix (values 0–15)
export const BAYER_4X4: readonly number[] = [
   0, 8, 2, 10,
  12, 4, 14,  6,
   3, 11, 1,  9,
  15, 7, 13,  5,
];

// Pack RGB channels into ABGR Uint32 (little-endian ImageData format)
export function packABGR(r: number, g: number, b: number): number {
  return (255 << 24) | (b << 16) | (g << 8) | r;
}

// Apply brightness multiplier to an RGB hex color, return ABGR Uint32
export function applyBrightness(rgb: number, factor: number): number {
  const r = Math.min(255, Math.floor(((rgb >> 16) & 0xff) * factor));
  const g = Math.min(255, Math.floor(((rgb >> 8) & 0xff) * factor));
  const b = Math.min(255, Math.floor((rgb & 0xff) * factor));
  return packABGR(r, g, b);
}
