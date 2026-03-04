import type { TerrainType } from './TopographyGenerator';

export interface TerrainPalette {
  base: number[];      // RGB hex colors, ordered dark → light (3-5 shades)
  detailFreq: number;  // simplex noise frequency for intra-terrain variation
  detailAmp: number;   // how strongly noise modulates palette index (0..1)
}

export const PALETTES: Record<TerrainType, TerrainPalette> = {
  ocean:    { base: [0x1a2e4a, 0x223d5e, 0x2a4a6b, 0x325878, 0x3a6585], detailFreq: 0.06, detailAmp: 0.7 },
  water:    { base: [0x2a5c80, 0x347a9e, 0x3a8cb5, 0x4a9cc5, 0x5aaccc], detailFreq: 0.08, detailAmp: 0.8 },
  coast:    { base: [0x5a8840, 0x6a9c50, 0x7aac6a, 0x8abc70, 0x9acc80], detailFreq: 0.15, detailAmp: 0.6 },
  lowland:  { base: [0x356828, 0x3e7c30, 0x4a8c40, 0x58a048, 0x65ac55], detailFreq: 0.18, detailAmp: 0.7 },
  highland: { base: [0x2a5420, 0x336428, 0x3a6c30, 0x447a38, 0x4e8840], detailFreq: 0.14, detailAmp: 0.6 },
  rock:     { base: [0x605848, 0x706858, 0x8c8070, 0x9c9080, 0xaca090], detailFreq: 0.20, detailAmp: 0.9 },
  cliff:    { base: [0x706050, 0x887868, 0xa09080, 0xb0a090, 0xc0b0a0], detailFreq: 0.22, detailAmp: 0.9 },
};

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
