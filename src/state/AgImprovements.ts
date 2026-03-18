/**
 * Agricultural improvements — grain fields, veggie fields, cow pastures.
 * One of each is assigned deterministically per duchy at game start.
 */

import { TopographyGenerator, mulberry32 } from '../generators/TopographyGenerator';
import { HydrologyGenerator } from '../generators/HydrologyGenerator';
import type { Duchy } from './Duchy';
import type { RoadSegment } from '../generators/RoadGenerator';
import { RIVER_THRESHOLD } from '../generators/utils';

export type AgImprovementType = 'grain' | 'veggie' | 'pasture';

/**
 * Assign one grain field, one veggie field, and one pasture per duchy.
 * Eligible: lowland, no river, mid elevation, not capital region, not on a road.
 * Returns a Map from regionIndex → improvement type.
 */
// Set to true to fill all eligible lowland tiles for visual testing
const FILL_ALL_FOR_TESTING = true;

export function assignAgImprovements(
  topo: TopographyGenerator,
  hydro: HydrologyGenerator,
  duchies: Duchy[],
  seed: number,
  roads: RoadSegment[] = [],
): Map<number, AgImprovementType> {
  const result = new Map<number, AgImprovementType>();
  const TYPES: AgImprovementType[] = ['grain', 'veggie', 'pasture'];

  // Build set of regions that lie on any road path
  const roadRegions = new Set<number>();
  for (const road of roads) {
    for (const r of road.path) roadRegions.add(r);
  }

  for (const duchy of duchies) {
    const rng = mulberry32(seed ^ (duchy.id * 0x1d3c7 + 0xfa12b8c3));

    // Find eligible regions: lowland, no river, mid elevation, not capital, not on road
    const eligible = duchy.regions.filter(r => {
      if (r === duchy.capitalRegion) return false;
      const terrain = topo.terrainType[r];
      if (terrain !== 'lowland') return false;
      const elev = topo.elevation[r];
      if (elev < 0.08 || elev > 0.40) return false;
      if (hydro.flowAccumulation[r] >= RIVER_THRESHOLD) return false;
      if (roadRegions.has(r)) return false;
      return true;
    });

    if (eligible.length === 0) continue;

    if (FILL_ALL_FOR_TESTING) {
      // Assign a random improvement to every eligible tile
      for (const r of eligible) {
        result.set(r, TYPES[Math.floor(rng() * TYPES.length)]);
      }
    } else {
      // Production: one of each per duchy
      const shuffled = [...eligible];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      for (let t = 0; t < TYPES.length && t < shuffled.length; t++) {
        result.set(shuffled[t], TYPES[t]);
      }
    }
  }

  return result;
}
