/**
 * WoodcutterAssignment — deterministically places one woodcutter per duchy.
 *
 * If the chosen forested region is on a river, it becomes a sawmill (higher yield).
 * Otherwise it's a manual woodcutter.
 */

import { TopographyGenerator, mulberry32 } from '../generators/TopographyGenerator';
import { HydrologyGenerator } from '../generators/HydrologyGenerator';
import type { Duchy } from './Duchy';
import type { RoadSegment } from '../generators/RoadGenerator';
import type { AgImprovementType } from './AgImprovements';
import type { WoodcutterState } from './Building';
import { RIVER_THRESHOLD } from '../generators/utils';
import { buildAdjacencyList } from '../utils/adjacency';

/**
 * Assign one woodcutter per duchy on an eligible forested region.
 * Returns Map from duchyIndex → WoodcutterState.
 */
export function assignWoodcutters(
  topo: TopographyGenerator,
  hydro: HydrologyGenerator,
  duchies: Duchy[],
  seed: number,
  pixelResolution: number,
  roads: RoadSegment[] = [],
  agImprovements: Map<number, AgImprovementType> = new Map(),
): Map<number, WoodcutterState> {
  const result = new Map<number, WoodcutterState>();
  const scale = topo.size / pixelResolution;
  const adj = buildAdjacencyList(topo.mesh);

  // Build set of regions on roads or assigned to ag improvements
  const excludedRegions = new Set<number>();
  for (const road of roads) {
    for (const r of road.path) excludedRegions.add(r);
  }
  for (const [r] of agImprovements) {
    excludedRegions.add(r);
  }

  for (let di = 0; di < duchies.length; di++) {
    const duchy = duchies[di];
    const rng = mulberry32(seed ^ (duchy.id * 0x3a7f5c + 0x0000d001));

    // Find eligible forested regions: lowland/highland, not capital, not road, not farm
    const eligible = duchy.regions.filter(r => {
      if (r === duchy.capitalRegion) return false;
      if (excludedRegions.has(r)) return false;
      const terrain = topo.terrainType[r];
      if (terrain !== 'lowland' && terrain !== 'highland') return false;
      const elev = topo.elevation[r];
      if (elev < 0.10 || elev > 0.50) return false;
      // Must have decent moisture (proxy for forest density)
      if (hydro.moisture[r] < 0.25) return false;
      return true;
    });

    if (eligible.length === 0) continue;

    // Sort by moisture descending (prefer dense forest), with river regions first
    eligible.sort((a, b) => {
      const aRiver = hydro.flowAccumulation[a] >= RIVER_THRESHOLD ? 1 : 0;
      const bRiver = hydro.flowAccumulation[b] >= RIVER_THRESHOLD ? 1 : 0;
      if (aRiver !== bRiver) return bRiver - aRiver; // river regions first
      return hydro.moisture[b] - hydro.moisture[a];
    });

    // Pick from top candidates with some randomness
    const pickIdx = Math.min(
      Math.floor(rng() * Math.min(3, eligible.length)),
      eligible.length - 1,
    );
    const region = eligible[pickIdx];

    // Determine variant
    const onRiver = hydro.flowAccumulation[region] >= RIVER_THRESHOLD;
    // Also check neighbors for river adjacency (sawmill doesn't need to be ON the river)
    let nearRiver = onRiver;
    if (!nearRiver && adj[region]) {
      for (const n of adj[region]) {
        if (hydro.flowAccumulation[n] >= RIVER_THRESHOLD) {
          nearRiver = true;
          break;
        }
      }
    }

    const variant: 'manual' | 'sawmill' = nearRiver ? 'sawmill' : 'manual';

    // Compute pixel position from region center
    const pt = topo.mesh.points[region];
    const hutPx = Math.floor(pt.x / scale);
    const hutPy = Math.floor(pt.y / scale);

    result.set(di, {
      regionIndex: region,
      duchyIndex: di,
      variant,
      hutPx,
      hutPy,
      lumberCount: 0,
    });
  }

  return result;
}
