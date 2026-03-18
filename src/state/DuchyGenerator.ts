/**
 * DuchyGenerator
 *
 * Places 9 duchies on the map. Each duchy gets ~10 contiguous Voronoi regions.
 * Constraints:
 *  - Only land regions (coast, lowland, highland)
 *  - Each duchy must have at least 1 river region and 1 forested region
 *  - Duchies are evenly distributed (seeded on a ~3x3 grid)
 *  - Simultaneous BFS growth for balanced territory sizes
 *  - Seeds placed near rivers; BFS biased toward river/forest regions
 */

import { TopographyGenerator, TerrainType, mulberry32 } from '../generators/TopographyGenerator';
import { HydrologyGenerator } from '../generators/HydrologyGenerator';
import { buildAdjacencyList } from '../utils/adjacency';
import { Duchy, HOUSES } from './Duchy';

const NUM_DUCHIES = 9;
const REGIONS_PER_DUCHY = 40;
const MAX_RETRIES = 20;

/** Terrain types valid for duchy territory */
function isValidLand(t: TerrainType): boolean {
  return t === 'coast' || t === 'lowland' || t === 'highland';
}

const LOWLAND_FRACTION = 0.5;

/**
 * Generate 9 duchies placed on the map.
 * Returns the duchies array and a per-region mapping (regionToDuchy).
 */
export function generateDuchies(
  topo: TopographyGenerator,
  hydro: HydrologyGenerator,
  seed: number,
): { duchies: Duchy[]; regionToDuchy: Int8Array } {
  const mesh = topo.mesh;
  const N = mesh.numRegions;
  const adj = buildAdjacencyList(mesh);

  // --- Step 1: Identify valid land regions ---
  const isLand = new Uint8Array(N);
  const isLowland = new Uint8Array(N);
  for (let r = 0; r < N; r++) {
    if (isValidLand(topo.terrainType[r])) isLand[r] = 1;
    if (topo.terrainType[r] === 'lowland') isLowland[r] = 1;
  }

  // --- Step 2: Tag river and forest regions ---
  const hasRiver = new Uint8Array(N);
  for (const path of hydro.rivers) {
    for (const r of path) {
      if (isLand[r]) hasRiver[r] = 1;
    }
  }

  // Also compute river proximity: BFS distance from nearest river region
  const riverDist = new Float32Array(N).fill(Infinity);
  const riverQueue: number[] = [];
  for (let r = 0; r < N; r++) {
    if (hasRiver[r]) {
      riverDist[r] = 0;
      riverQueue.push(r);
    }
  }
  let head = 0;
  while (head < riverQueue.length) {
    const r = riverQueue[head++];
    if (riverDist[r] >= 5) continue;
    for (const n of adj[r]) {
      if (!isLand[n]) continue;
      const nd = riverDist[r] + 1;
      if (nd < riverDist[n]) {
        riverDist[n] = nd;
        riverQueue.push(n);
      }
    }
  }

  const hasForest = new Uint8Array(N);
  for (let r = 0; r < N; r++) {
    if (isLand[r] && topo.terrainType[r] === 'highland') {
      hasForest[r] = 1;
    }
    if (isLand[r] && topo.terrainType[r] === 'lowland' && hydro.moisture[r] > 0.5) {
      hasForest[r] = 1;
    }
  }

  // --- Step 3: Find land bounds for grid placement ---
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

  // --- Retry loop: re-seed if constraints fail ---
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const rng = mulberry32(seed ^ 0xd0c4e ^ (attempt * 7919));
    const result = _tryGenerate(
      rng, mesh, adj, isLand, isLowland, hasRiver, hasForest, riverDist,
      landRegions, landMinX, landMaxX, landMinY, landMaxY, N,
    );
    if (result) return result;
  }

  // Fallback: return best-effort result without strict validation
  const rng = mulberry32(seed ^ 0xd0c4e ^ 999);
  return _tryGenerate(
    rng, mesh, adj, isLand, isLowland, hasRiver, hasForest, riverDist,
    landRegions, landMinX, landMaxX, landMinY, landMaxY, N,
    true, // skipValidation
  )!;
}

function _tryGenerate(
  rng: () => number,
  mesh: { points: { x: number; y: number }[]; numRegions: number },
  adj: number[][],
  isLand: Uint8Array,
  isLowland: Uint8Array,
  hasRiver: Uint8Array,
  hasForest: Uint8Array,
  riverDist: Float32Array,
  landRegions: number[],
  landMinX: number,
  landMaxX: number,
  landMinY: number,
  landMaxY: number,
  N: number,
  skipValidation = false,
): { duchies: Duchy[]; regionToDuchy: Int8Array } | null {
  const gridCols = 3;
  const gridRows = 3;
  const cellW = (landMaxX - landMinX) / gridCols;
  const cellH = (landMaxY - landMinY) / gridRows;

  // --- Place 9 seeds, preferring regions near rivers ---
  const seeds: number[] = [];

  for (let row = 0; row < gridRows; row++) {
    for (let col = 0; col < gridCols; col++) {
      // Jitter target position with some randomness
      const targetX = landMinX + (col + 0.3 + rng() * 0.4) * cellW;
      const targetY = landMinY + (row + 0.3 + rng() * 0.4) * cellH;

      // Find best land region: close to target AND close to a river
      let bestR = -1;
      let bestScore = Infinity;

      for (const r of landRegions) {
        const p = mesh.points[r];
        const dx = p.x - targetX;
        const dy = p.y - targetY;
        const positionDist = Math.sqrt(dx * dx + dy * dy);
        // Score: distance to target + heavy penalty for being far from rivers + bonus for lowland
        const rDist = riverDist[r] === Infinity ? 20 : riverDist[r];
        const lowlandBonus = isLowland[r] ? -40 : 0;
        const score = positionDist + rDist * 80 + lowlandBonus;
        if (score < bestScore) {
          bestScore = score;
          bestR = r;
        }
      }

      if (bestR >= 0) {
        seeds.push(bestR);
      }
    }
  }

  // Enforce minimum separation (~20 tiles) between seeds.
  // Approximate tile size from land extent and region count.
  const landW = landMaxX - landMinX;
  const landH = landMaxY - landMinY;
  const approxTileSize = Math.sqrt((landW * landH) / Math.max(1, landRegions.length));
  const minSeedDist = approxTileSize * 20;
  const minSeedDist2 = minSeedDist * minSeedDist;

  // Deduplicate seeds and enforce minimum distance
  const usedSeeds = new Set<number>();
  for (let i = 0; i < seeds.length; i++) {
    // Check if too close to any previously accepted seed
    let tooClose = usedSeeds.has(seeds[i]);
    if (!tooClose) {
      const pi = mesh.points[seeds[i]];
      for (let j = 0; j < i; j++) {
        const pj = mesh.points[seeds[j]];
        const d2 = (pi.x - pj.x) ** 2 + (pi.y - pj.y) ** 2;
        if (d2 < minSeedDist2) { tooClose = true; break; }
      }
    }

    if (tooClose) {
      // Try to find a replacement: search land regions far enough from all prior seeds
      let bestR = -1;
      let bestScore = Infinity;
      const targetX = landMinX + ((i % gridCols) + 0.5) * cellW;
      const targetY = landMinY + (Math.floor(i / gridCols) + 0.5) * cellH;

      for (const r of landRegions) {
        if (usedSeeds.has(r)) continue;
        const p = mesh.points[r];

        // Must be far enough from all prior seeds
        let farEnough = true;
        for (let j = 0; j < i; j++) {
          const pj = mesh.points[seeds[j]];
          if ((p.x - pj.x) ** 2 + (p.y - pj.y) ** 2 < minSeedDist2) {
            farEnough = false;
            break;
          }
        }
        if (!farEnough) continue;

        const dx = p.x - targetX;
        const dy = p.y - targetY;
        const rDist = riverDist[r] === Infinity ? 20 : riverDist[r];
        const score = Math.sqrt(dx * dx + dy * dy) + rDist * 80;
        if (score < bestScore) {
          bestScore = score;
          bestR = r;
        }
      }

      if (bestR >= 0) {
        seeds[i] = bestR;
      }
    }
    usedSeeds.add(seeds[i]);
  }

  // --- BFS growth with bias toward river/forest regions ---
  const regionToDuchy = new Int8Array(N).fill(-1);
  const queues: number[][] = [];

  for (let d = 0; d < NUM_DUCHIES; d++) {
    const seedR = seeds[d];
    regionToDuchy[seedR] = d;
    queues.push([seedR]);
  }

  const duchyRegionCount = new Int32Array(NUM_DUCHIES);
  for (let d = 0; d < NUM_DUCHIES; d++) duchyRegionCount[d] = 1;

  // Track whether each duchy has met its constraints
  const duchyHasRiver = new Uint8Array(NUM_DUCHIES);
  const duchyHasForest = new Uint8Array(NUM_DUCHIES);
  const duchyLowlandCount = new Int32Array(NUM_DUCHIES);
  for (let d = 0; d < NUM_DUCHIES; d++) {
    if (hasRiver[seeds[d]]) duchyHasRiver[d] = 1;
    if (hasForest[seeds[d]]) duchyHasForest[d] = 1;
    if (isLowland[seeds[d]]) duchyLowlandCount[d] = 1;
  }

  let anyGrew = true;
  while (anyGrew) {
    anyGrew = false;
    for (let d = 0; d < NUM_DUCHIES; d++) {
      if (duchyRegionCount[d] >= REGIONS_PER_DUCHY) continue;
      if (queues[d].length === 0) continue;

      let claimed = false;
      while (queues[d].length > 0 && !claimed) {
        const r = queues[d].shift()!;

        const neighbors = adj[r];
        // Shuffle neighbors
        for (let i = neighbors.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [neighbors[i], neighbors[j]] = [neighbors[j], neighbors[i]];
        }

        // Sort candidates: prioritize river/forest if duchy still needs them
        const candidates = neighbors.filter(n => regionToDuchy[n] === -1 && isLand[n]);
        if (candidates.length === 0) continue;

        // Pick best candidate
        let bestCandidate = candidates[0];
        let bestPriority = 0;
        const needsLowland = duchyLowlandCount[d] / duchyRegionCount[d] < LOWLAND_FRACTION;
        for (const n of candidates) {
          let priority = 0;
          if (!duchyHasRiver[d] && hasRiver[n]) priority += 10;
          if (!duchyHasForest[d] && hasForest[n]) priority += 5;
          if (needsLowland && isLowland[n]) priority += 8;
          // Slight bias toward river-adjacent regions
          if (riverDist[n] < 3) priority += 1;
          if (priority > bestPriority) {
            bestPriority = priority;
            bestCandidate = n;
          }
        }

        regionToDuchy[bestCandidate] = d;
        duchyRegionCount[d]++;
        if (hasRiver[bestCandidate]) duchyHasRiver[d] = 1;
        if (hasForest[bestCandidate]) duchyHasForest[d] = 1;
        if (isLowland[bestCandidate]) duchyLowlandCount[d]++;
        queues[d].push(bestCandidate);
        queues[d].push(r); // re-add source to keep exploring
        claimed = true;
        anyGrew = true;
      }
    }
  }

  // --- Validate constraints ---
  if (!skipValidation) {
    for (let d = 0; d < NUM_DUCHIES; d++) {
      if (!duchyHasRiver[d] || !duchyHasForest[d]) {
        return null; // retry with different seed
      }
      if (duchyLowlandCount[d] / duchyRegionCount[d] < LOWLAND_FRACTION) {
        return null; // retry — duchy lacks ≥50% lowland regions
      }
    }
  }

  // --- Build Duchy objects ---
  const duchies: Duchy[] = [];

  for (let d = 0; d < NUM_DUCHIES; d++) {
    const regions: number[] = [];
    for (let r = 0; r < N; r++) {
      if (regionToDuchy[r] === d) regions.push(r);
    }

    duchies.push({
      id: d,
      house: HOUSES[d],
      regions,
      capitalRegion: seeds[d],
      hasRiver: !!duchyHasRiver[d],
      hasForest: !!duchyHasForest[d],
    });
  }

  return { duchies, regionToDuchy };
}
