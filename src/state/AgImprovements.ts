/**
 * Agricultural improvements — grain fields, veggie fields, cow pastures.
 * One of each is assigned deterministically per duchy at game start.
 */

import { TopographyGenerator, mulberry32 } from '../generators/TopographyGenerator';
import { HydrologyGenerator } from '../generators/HydrologyGenerator';
import type { Duchy } from './Duchy';
import { RIVER_THRESHOLD } from '../generators/utils';

export type AgImprovementType = 'grain' | 'veggie' | 'pasture';

/**
 * Assign one grain field, one veggie field, and one pasture per duchy.
 * Eligible: lowland, no river, mid elevation, not capital region.
 * Returns a Map from regionIndex → improvement type.
 */
export function assignAgImprovements(
  topo: TopographyGenerator,
  hydro: HydrologyGenerator,
  duchies: Duchy[],
  seed: number,
): Map<number, AgImprovementType> {
  const result = new Map<number, AgImprovementType>();
  const rng = mulberry32(seed ^ 0xfa12b8c3);
  const TYPES: AgImprovementType[] = ['grain', 'veggie', 'pasture'];

  for (const duchy of duchies) {
    // Find eligible regions
    const eligible = duchy.regions.filter(r => {
      if (r === duchy.capitalRegion) return false;
      const terrain = topo.terrainType[r];
      if (terrain !== 'lowland') return false;
      const elev = topo.elevation[r];
      if (elev < 0.08 || elev > 0.40) return false;
      // No river through this region
      if (hydro.flowAccumulation[r] >= RIVER_THRESHOLD) return false;
      return true;
    });

    if (eligible.length === 0) continue;

    // Fisher-Yates shuffle with seeded RNG
    const shuffled = [...eligible];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // Assign first 3 (or fewer)
    for (let t = 0; t < TYPES.length && t < shuffled.length; t++) {
      result.set(shuffled[t], TYPES[t]);
    }
  }

  return result;
}
