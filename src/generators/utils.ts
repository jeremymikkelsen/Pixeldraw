// ---------------------------------------------------------------------------
// Shared utilities for procedural generation
// ---------------------------------------------------------------------------

// Seeded PRNG (Mulberry32) — returns a () => number factory
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

// Terrain classification
export type TerrainType = 'ocean' | 'coast' | 'lowland' | 'highland' | 'rock' | 'cliff' | 'water';

export function isWater(t: TerrainType): boolean {
  return t === 'ocean' || t === 'water';
}

// Noise/map constants
export const MAP_SCALE = 1;

// Minimum flow accumulation to form a visible river
export const RIVER_THRESHOLD = 25;

// Directional light (upper-left, normalized)
export const LIGHT_DIR_X = -0.707;
export const LIGHT_DIR_Y = -0.707;
