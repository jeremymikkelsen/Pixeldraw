/**
 * SmelterAssignment — places one smelter per duchy that has an iron mine.
 *
 * Smelters go in lowland/highland regions, preferring river-adjacent
 * sites (water-powered bellows).
 */

import { TopographyGenerator, mulberry32 } from '../generators/TopographyGenerator';
import { HydrologyGenerator } from '../generators/HydrologyGenerator';
import type { Duchy } from './Duchy';
import type { RoadSegment } from '../generators/RoadGenerator';
import type { AgImprovementType } from './AgImprovements';
import type { MineState, SmelterState } from './Building';
import { RIVER_THRESHOLD } from '../generators/utils';
import { buildAdjacencyList } from '../utils/adjacency';

/**
 * Assign one smelter per duchy that has a mine.
 * Returns Map from duchyIndex → SmelterState.
 */
export function assignSmelters(
  topo: TopographyGenerator,
  hydro: HydrologyGenerator,
  duchies: Duchy[],
  seed: number,
  pixelResolution: number,
  mines: Map<number, MineState>,
  roads: RoadSegment[] = [],
  agImprovements: Map<number, AgImprovementType> = new Map(),
): Map<number, SmelterState> {
  const result = new Map<number, SmelterState>();
  const scale = topo.size / pixelResolution;
  const adj = buildAdjacencyList(topo.mesh);

  // Build set of excluded regions
  const excludedRegions = new Set<number>();
  for (const road of roads) {
    for (const r of road.path) excludedRegions.add(r);
  }
  for (const [r] of agImprovements) {
    excludedRegions.add(r);
  }
  // Also exclude mine regions
  for (const [, mine] of mines) {
    excludedRegions.add(mine.regionIndex);
  }

  for (let di = 0; di < duchies.length; di++) {
    // Only duchies with a mine get a smelter
    if (!mines.has(di)) continue;

    const duchy = duchies[di];
    const rng = mulberry32(seed ^ (duchy.id * 0x6c3a9f + 0x0000b001));

    // Find eligible regions: lowland or highland, not capital/road/mine
    const eligible: { region: number; onRiver: boolean }[] = [];

    for (const r of duchy.regions) {
      if (r === duchy.capitalRegion) continue;
      if (excludedRegions.has(r)) continue;

      const terrain = topo.terrainType[r];
      if (terrain !== 'lowland' && terrain !== 'highland') continue;

      // Check river adjacency
      let onRiver = hydro.flowAccumulation[r] >= RIVER_THRESHOLD;
      if (!onRiver) {
        const neighbors = adj[r] ?? [];
        for (const n of neighbors) {
          if (hydro.flowAccumulation[n] >= RIVER_THRESHOLD) {
            onRiver = true;
            break;
          }
        }
      }

      eligible.push({ region: r, onRiver });
    }

    if (eligible.length === 0) continue;

    // Sort: river-adjacent first, then by proximity to duchy center
    const capitalPt = topo.mesh.points[duchy.capitalRegion];
    eligible.sort((a, b) => {
      if (a.onRiver !== b.onRiver) return b.onRiver ? 1 : -1;
      const aPt = topo.mesh.points[a.region];
      const bPt = topo.mesh.points[b.region];
      const aDist = (aPt.x - capitalPt.x) ** 2 + (aPt.y - capitalPt.y) ** 2;
      const bDist = (bPt.x - capitalPt.x) ** 2 + (bPt.y - capitalPt.y) ** 2;
      return aDist - bDist;
    });

    // Pick from top candidates with some randomness
    const pickIdx = Math.min(
      Math.floor(rng() * Math.min(3, eligible.length)),
      eligible.length - 1,
    );
    const { region, onRiver: nearRiver } = eligible[pickIdx];

    // Pixel position
    const pt = topo.mesh.points[region];
    const buildingPx = Math.floor(pt.x / scale);
    const buildingPy = Math.floor(pt.y / scale);

    result.set(di, {
      regionIndex: region,
      duchyIndex: di,
      buildingPx,
      buildingPy,
      nearRiver,
      ingotCount: 0,
    });
  }

  return result;
}
