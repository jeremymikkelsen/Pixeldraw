/**
 * Agricultural improvements — grain fields, gardens, cow pastures.
 * One of each is assigned deterministically per duchy at game start.
 */

import { TopographyGenerator, mulberry32 } from '../generators/TopographyGenerator';
import { HydrologyGenerator } from '../generators/HydrologyGenerator';
import type { Duchy } from './Duchy';
import type { RoadSegment } from '../generators/RoadGenerator';
import { RIVER_THRESHOLD } from '../generators/utils';

export type AgImprovementType = 'grain' | 'garden' | 'pasture';

/**
 * Assign 3 grain fields, 2 gardens, and 2 pastures per duchy.
 * Eligible: lowland, no river, mid elevation, not capital region, not on a road.
 * Returns a Map from regionIndex → improvement type.
 */
const GRAIN_COUNT  = 3;
const GARDEN_COUNT = 2;
const PASTURE_COUNT = 2;

export function assignAgImprovements(
  topo: TopographyGenerator,
  hydro: HydrologyGenerator,
  duchies: Duchy[],
  seed: number,
  roads: RoadSegment[] = [],
): Map<number, AgImprovementType> {
  const result = new Map<number, AgImprovementType>();

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

    // Shuffle eligible regions
    const shuffled = [...eligible];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // Assign fixed counts: 3 grain, 2 garden, 2 pasture
    const types: AgImprovementType[] = [
      ...Array(GRAIN_COUNT).fill('grain'),
      ...Array(GARDEN_COUNT).fill('garden'),
      ...Array(PASTURE_COUNT).fill('pasture'),
    ];
    for (let t = 0; t < types.length && t < shuffled.length; t++) {
      result.set(shuffled[t], types[t]);
    }
  }

  return result;
}
