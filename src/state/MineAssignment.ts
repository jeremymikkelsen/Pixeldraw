/**
 * MineAssignment — deterministically places iron mines in high-highland
 * regions that border rock/cliff terrain.
 *
 * Iron ore is somewhat rare: a mineral noise layer filters ~40-50% of
 * duchies. Only those with qualifying highland regions get a mine.
 */

import { TopographyGenerator, mulberry32 } from '../generators/TopographyGenerator';
import { HydrologyGenerator } from '../generators/HydrologyGenerator';
import { createNoise2D } from 'simplex-noise';
import type { Duchy } from './Duchy';
import type { RoadSegment } from '../generators/RoadGenerator';
import type { AgImprovementType } from './AgImprovements';
import type { MineState } from './Building';
import { buildAdjacencyList } from '../utils/adjacency';

// Elevation band for mine placement (upper highland, near rock border)
const MINE_ELEV_MIN = 0.35;
const MINE_ELEV_MAX = 0.45;  // rock terrain starts at 0.45

// Mineral noise threshold — higher = rarer. ~0.62 yields ~40-50% of duchies
const MINERAL_THRESHOLD = 0.62;

/**
 * Assign at most one iron mine per duchy on an eligible highland region
 * bordering rock/cliff terrain.
 * Returns Map from duchyIndex → MineState (some duchies will be absent).
 */
export function assignMines(
  topo: TopographyGenerator,
  hydro: HydrologyGenerator,
  duchies: Duchy[],
  seed: number,
  pixelResolution: number,
  roads: RoadSegment[] = [],
  agImprovements: Map<number, AgImprovementType> = new Map(),
): Map<number, MineState> {
  const result = new Map<number, MineState>();
  const scale = topo.size / pixelResolution;
  const adj = buildAdjacencyList(topo.mesh);

  // Mineral noise — determines which regions are iron-rich
  const mineralRng = mulberry32(seed ^ 0xfe3d1a07);
  const mineralNoise = createNoise2D(mineralRng);

  // Build set of excluded regions (roads, ag improvements)
  const excludedRegions = new Set<number>();
  for (const road of roads) {
    for (const r of road.path) excludedRegions.add(r);
  }
  for (const [r] of agImprovements) {
    excludedRegions.add(r);
  }

  for (let di = 0; di < duchies.length; di++) {
    const duchy = duchies[di];
    const rng = mulberry32(seed ^ (duchy.id * 0x4b8e2d + 0x0000e001));

    // Find highland regions near rock border with mineral richness
    const eligible: { region: number; mineralValue: number }[] = [];

    for (const r of duchy.regions) {
      if (r === duchy.capitalRegion) continue;
      if (excludedRegions.has(r)) continue;

      const terrain = topo.terrainType[r];
      if (terrain !== 'highland') continue;

      const elev = topo.elevation[r];
      if (elev < MINE_ELEV_MIN || elev >= MINE_ELEV_MAX) continue;

      // Must border rock or cliff terrain
      const neighbors = adj[r] ?? [];
      let bordersRock = false;
      for (const n of neighbors) {
        const nt = topo.terrainType[n];
        if (nt === 'rock' || nt === 'cliff') {
          bordersRock = true;
          break;
        }
      }
      if (!bordersRock) continue;

      // Check mineral noise at region center
      const pt = topo.mesh.points[r];
      const nx = pt.x / topo.size * 4; // scale for noise frequency
      const ny = pt.y / topo.size * 4;
      const mineralValue = (mineralNoise(nx, ny) + 1) * 0.5; // normalize to 0-1

      if (mineralValue < MINERAL_THRESHOLD) continue;

      eligible.push({ region: r, mineralValue });
    }

    if (eligible.length === 0) continue;

    // Sort by mineral value descending, pick from top candidates
    eligible.sort((a, b) => b.mineralValue - a.mineralValue);
    const pickIdx = Math.min(
      Math.floor(rng() * Math.min(3, eligible.length)),
      eligible.length - 1,
    );
    const region = eligible[pickIdx].region;

    // Compute rock direction: average offsets toward rock/cliff neighbors
    const neighbors = adj[region] ?? [];
    const pt = topo.mesh.points[region];
    let rx = 0, ry = 0;
    for (const n of neighbors) {
      const nt = topo.terrainType[n];
      if (nt === 'rock' || nt === 'cliff') {
        const np = topo.mesh.points[n];
        rx += np.x - pt.x;
        ry += np.y - pt.y;
      }
    }
    const rlen = Math.sqrt(rx * rx + ry * ry);
    const rockDirX = rlen > 0 ? rx / rlen : 0;
    const rockDirY = rlen > 0 ? ry / rlen : 1;

    // Pixel position from region center
    const entrancePx = Math.floor(pt.x / scale);
    const entrancePy = Math.floor(pt.y / scale);

    result.set(di, {
      regionIndex: region,
      duchyIndex: di,
      entrancePx,
      entrancePy,
      rockDirX,
      rockDirY,
      oreCount: 0,
    });
  }

  return result;
}
