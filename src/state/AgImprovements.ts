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
const TILES_PER_DUCHY = 40;
const GRAIN_RATIO = 0.50; // 50% grain, 25% veggie, 25% pasture

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

    // Shuffle and take up to TILES_PER_DUCHY
    const shuffled = [...eligible];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const count = Math.min(TILES_PER_DUCHY, shuffled.length);
    const grainCount = Math.floor(count * GRAIN_RATIO);
    const remaining = count - grainCount;
    const veggieCount = Math.floor(remaining / 2);

    for (let t = 0; t < count; t++) {
      if (t < grainCount) {
        result.set(shuffled[t], 'grain');
      } else if (t < grainCount + veggieCount) {
        result.set(shuffled[t], 'veggie');
      } else {
        result.set(shuffled[t], 'pasture');
      }
    }
  }

  return result;
}
