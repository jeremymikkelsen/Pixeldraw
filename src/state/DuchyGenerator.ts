/**
 * DuchyGenerator
 *
 * Places 9 duchies on the map. Each duchy gets ~10 contiguous Voronoi regions.
 * Constraints:
 *  - Only land regions (coast, lowland, highland)
 *  - Each duchy must have at least 1 river region and 1 forested region
 *  - Duchies are evenly distributed (seeded on a ~3x3 grid)
 *  - Simultaneous BFS growth for balanced territory sizes
 */

import { TopographyGenerator, TerrainType, mulberry32 } from '../generators/TopographyGenerator';
import { HydrologyGenerator } from '../generators/HydrologyGenerator';
import { buildAdjacencyList } from '../utils/adjacency';
import { Duchy, HOUSES } from './Duchy';

const NUM_DUCHIES = 9;
const REGIONS_PER_DUCHY = 10;

/** Terrain types valid for duchy territory */
function isValidLand(t: TerrainType): boolean {
  return t === 'coast' || t === 'lowland' || t === 'highland';
}

/**
 * Generate 9 duchies placed on the map.
 * Returns the duchies array and a per-region mapping (regionToDuchy).
 */
export function generateDuchies(
  topo: TopographyGenerator,
  hydro: HydrologyGenerator,
  seed: number,
): { duchies: Duchy[]; regionToDuchy: Int8Array } {
  const rng = mulberry32(seed ^ 0xd0c4e);
  const mesh = topo.mesh;
  const N = mesh.numRegions;
  const adj = buildAdjacencyList(mesh);

  // --- Step 1: Identify valid land regions ---
  const isLand = new Uint8Array(N);
  for (let r = 0; r < N; r++) {
    if (isValidLand(topo.terrainType[r])) isLand[r] = 1;
  }

  // --- Step 2: Tag river and forest regions ---
  const hasRiver = new Uint8Array(N);
  for (const path of hydro.rivers) {
    for (const r of path) {
      if (isLand[r]) hasRiver[r] = 1;
    }
  }

  const hasForest = new Uint8Array(N);
  for (let r = 0; r < N; r++) {
    // Highland regions have dense tree cover in the renderer
    if (isLand[r] && topo.terrainType[r] === 'highland') {
      hasForest[r] = 1;
    }
    // Also count lowland regions with high moisture (they also get trees)
    if (isLand[r] && topo.terrainType[r] === 'lowland' && hydro.moisture[r] > 0.5) {
      hasForest[r] = 1;
    }
  }

  // --- Step 3: Find land centroid for grid placement ---
  let landMinX = Infinity, landMaxX = -Infinity;
  let landMinY = Infinity, landMaxY = -Infinity;
  const landRegions: number[] = [];

  for (let r = 0; r < N; r++) {
    if (!isLand[r]) continue;
    landRegions.push(r);
    const p = mesh.points[r];
    if (p.x < landMinX) landMinX = p.x;
    if (p.x > landMaxX) landMaxX = p.x;
    if (p.y < landMinY) landMinY = p.y;
    if (p.y > landMaxY) landMaxY = p.y;
  }

  // --- Step 4: Place 9 seeds on a 3x3 grid ---
  const gridCols = 3;
  const gridRows = 3;
  const cellW = (landMaxX - landMinX) / gridCols;
  const cellH = (landMaxY - landMinY) / gridRows;

  const seeds: number[] = [];

  for (let row = 0; row < gridRows; row++) {
    for (let col = 0; col < gridCols; col++) {
      const targetX = landMinX + (col + 0.5) * cellW;
      const targetY = landMinY + (row + 0.5) * cellH;

      // Find the closest valid land region to this target point
      let bestR = -1;
      let bestDist = Infinity;

      for (const r of landRegions) {
        const p = mesh.points[r];
        const dx = p.x - targetX;
        const dy = p.y - targetY;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          bestR = r;
        }
      }

      if (bestR >= 0) {
        seeds.push(bestR);
      }
    }
  }

  // If any seeds ended up on the same region, perturb them
  const usedSeeds = new Set<number>();
  for (let i = 0; i < seeds.length; i++) {
    if (usedSeeds.has(seeds[i])) {
      // Find a nearby unused land region
      const neighbors = adj[seeds[i]];
      for (const n of neighbors) {
        if (isLand[n] && !usedSeeds.has(n)) {
          seeds[i] = n;
          break;
        }
      }
    }
    usedSeeds.add(seeds[i]);
  }

  // --- Step 5: Simultaneous BFS growth ---
  const regionToDuchy = new Int8Array(N).fill(-1);
  const queues: number[][] = [];

  for (let d = 0; d < NUM_DUCHIES; d++) {
    const seedR = seeds[d];
    regionToDuchy[seedR] = d;
    queues.push([seedR]);
  }

  const duchyRegionCount = new Int32Array(NUM_DUCHIES);
  for (let d = 0; d < NUM_DUCHIES; d++) duchyRegionCount[d] = 1;

  // Round-robin BFS: each duchy expands by one region per round
  let anyGrew = true;
  while (anyGrew) {
    anyGrew = false;
    for (let d = 0; d < NUM_DUCHIES; d++) {
      if (duchyRegionCount[d] >= REGIONS_PER_DUCHY) continue;
      if (queues[d].length === 0) continue;

      // Try to claim the next valid region from this duchy's BFS queue
      let claimed = false;
      while (queues[d].length > 0 && !claimed) {
        const r = queues[d].shift()!;

        // Expand neighbors of r
        const neighbors = adj[r];
        // Shuffle neighbors for variety
        for (let i = neighbors.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [neighbors[i], neighbors[j]] = [neighbors[j], neighbors[i]];
        }

        for (const n of neighbors) {
          if (regionToDuchy[n] !== -1) continue; // already claimed
          if (!isLand[n]) continue;

          regionToDuchy[n] = d;
          duchyRegionCount[d]++;
          queues[d].push(n);
          claimed = true;
          anyGrew = true;

          // Also re-add r so we keep exploring from it
          queues[d].push(r);
          break;
        }
      }
    }
  }

  // --- Step 6: Build Duchy objects ---
  const duchies: Duchy[] = [];

  for (let d = 0; d < NUM_DUCHIES; d++) {
    const regions: number[] = [];
    let duchyHasRiver = false;
    let duchyHasForest = false;

    for (let r = 0; r < N; r++) {
      if (regionToDuchy[r] !== d) continue;
      regions.push(r);
      if (hasRiver[r]) duchyHasRiver = true;
      if (hasForest[r]) duchyHasForest = true;
    }

    duchies.push({
      id: d,
      house: HOUSES[d],
      regions,
      capitalRegion: seeds[d],
      hasRiver: duchyHasRiver,
      hasForest: duchyHasForest,
    });
  }

  return { duchies, regionToDuchy };
}
