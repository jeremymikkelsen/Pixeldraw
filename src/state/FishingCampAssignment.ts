/**
 * FishingCampAssignment — deterministically places one fishing camp per duchy.
 *
 * Ocean variant: coast region adjacent to ocean/water → pier extending into sea.
 * River variant: region on/adjacent to a big river → wharf along the bank.
 *
 * If a duchy has both, ocean is preferred.
 */

import { TopographyGenerator, mulberry32 } from '../generators/TopographyGenerator';
import { HydrologyGenerator } from '../generators/HydrologyGenerator';
import type { Duchy } from './Duchy';
import type { FishingCampState } from './Building';
import { RIVER_THRESHOLD } from '../generators/utils';

// Wharfs require a proper river, not just a trickle (≥4× the basic threshold)
const WHARF_RIVER_THRESHOLD = RIVER_THRESHOLD * 4;
import { buildAdjacencyList } from '../utils/adjacency';

export function assignFishingCamps(
  topo: TopographyGenerator,
  hydro: HydrologyGenerator,
  duchies: Duchy[],
  seed: number,
  pixelResolution: number,
): Map<number, FishingCampState> {
  const result = new Map<number, FishingCampState>();
  const adj = buildAdjacencyList(topo.mesh);
  const scale = topo.size / pixelResolution;

  for (let di = 0; di < duchies.length; di++) {
    const duchy = duchies[di];
    const rng = mulberry32(seed ^ (duchy.id * 0x5e3f9c + 0x0000f001));

    // Ocean candidates: any land region bordering water or ocean.
    // The shallow ocean edge is 'water' type, so we check for both.
    // Prefer coast-typed regions first; fall back to lowland/highland if needed.
    const isWaterAdjacent = (r: number) =>
      !!adj[r] && adj[r].some(n => {
        const t = topo.terrainType[n];
        return t === 'ocean' || t === 'water';
      });

    const coastBorderCandidates = duchy.regions.filter(r => {
      if (r === duchy.capitalRegion) return false;
      return topo.terrainType[r] === 'coast' && isWaterAdjacent(r);
    });
    const anyBorderCandidates = duchy.regions.filter(r => {
      if (r === duchy.capitalRegion) return false;
      const t = topo.terrainType[r];
      if (t === 'ocean' || t === 'water' || t === 'rock' || t === 'cliff') return false;
      return isWaterAdjacent(r);
    });
    const oceanCandidates = coastBorderCandidates.length > 0
      ? coastBorderCandidates
      : anyBorderCandidates;

    // River candidates: land regions on or directly adjacent to a wide river (not a trickle)
    const riverCandidates = duchy.regions.filter(r => {
      if (r === duchy.capitalRegion) return false;
      const terrain = topo.terrainType[r];
      if (terrain !== 'coast' && terrain !== 'lowland' && terrain !== 'highland') return false;
      if (hydro.flowAccumulation[r] >= WHARF_RIVER_THRESHOLD) return true;
      if (!adj[r]) return false;
      return adj[r].some(n => hydro.flowAccumulation[n] >= WHARF_RIVER_THRESHOLD);
    });

    let variant: 'ocean' | 'river';
    let region: number;

    if (oceanCandidates.length > 0) {
      region = oceanCandidates[Math.floor(rng() * oceanCandidates.length)];
      variant = 'ocean';
    } else if (riverCandidates.length > 0) {
      region = riverCandidates[Math.floor(rng() * riverCandidates.length)];
      variant = 'river';
    } else {
      continue; // duchy has no suitable coast or river
    }

    const pt = topo.mesh.points[region];
    const hutPx = Math.floor(pt.x / scale);
    const hutPy = Math.floor(pt.y / scale);

    // Compute direction toward the nearest water by averaging offsets to water neighbors
    let wx = 0, wy = 0;
    if (adj[region]) {
      for (const n of adj[region]) {
        const nt = topo.terrainType[n];
        const isTarget = variant === 'ocean'
          ? (nt === 'ocean' || nt === 'water')
          : hydro.flowAccumulation[n] >= WHARF_RIVER_THRESHOLD;
        if (isTarget) {
          const npt = topo.mesh.points[n];
          wx += npt.x - pt.x;
          wy += npt.y - pt.y;
        }
      }
    }
    const wlen = Math.sqrt(wx * wx + wy * wy);
    const waterDirX = wlen > 0 ? wx / wlen : 0;
    const waterDirY = wlen > 0 ? wy / wlen : 1;

    // Dock end: extend from hut toward water
    const dockLength = variant === 'ocean' ? 24 : 12;
    const dockPx = Math.round(hutPx + waterDirX * dockLength);
    const dockPy = Math.round(hutPy + waterDirY * dockLength);

    result.set(di, {
      regionIndex: region,
      duchyIndex: di,
      variant,
      hutPx,
      hutPy,
      dockPx,
      dockPy,
      waterDirX,
      waterDirY,
    });
  }

  return result;
}
