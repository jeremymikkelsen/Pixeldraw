/**
 * HydrologyGenerator
 *
 * Simulates hydrology on the Voronoi mesh produced by TopographyGenerator:
 *  0. Pre-compute adjacency list (O(E) single pass)
 *  1. Precipitation with westerly-wind rain shadow
 *  2. Sink filling (priority flood)
 *  3. Flow direction (steepest descent)
 *  4. Flow accumulation (dendritic drainage)
 *  5. River network extraction
 *  6. Soil moisture (precip + river proximity + drainage position)
 */

import { TopographyGenerator, TerrainType, mulberry32 } from './TopographyGenerator';
import { DualMesh, Point } from './DualMesh';

// -- Precipitation constants --
const BASE_MOISTURE = 1.0;
const OCEAN_RECHARGE = 0.06;
const UPLIFT_FACTOR = 6.0;
const BASE_PRECIP_RATE = 0.08;

// -- River extraction --
const RIVER_THRESHOLD = 25;

// -- Soil moisture --
const PRECIP_WEIGHT = 0.65;
const RIVER_WEIGHT = 0.25;
const DRAINAGE_WEIGHT = 0.10;
const RIVER_SPREAD_DIST = 6;

// ---------------------------------------------------------------------------
// Inline binary min-heap
// ---------------------------------------------------------------------------
class MinHeap {
  private data: { key: number; pri: number }[] = [];

  get length(): number { return this.data.length; }

  push(key: number, pri: number): void {
    this.data.push({ key, pri });
    this._siftUp(this.data.length - 1);
  }

  pop(): { key: number; pri: number } {
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this._siftDown(0);
    }
    return top;
  }

  private _siftUp(i: number): void {
    const d = this.data;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (d[p].pri <= d[i].pri) break;
      [d[p], d[i]] = [d[i], d[p]];
      i = p;
    }
  }

  private _siftDown(i: number): void {
    const d = this.data;
    const n = d.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && d[l].pri < d[smallest].pri) smallest = l;
      if (r < n && d[r].pri < d[smallest].pri) smallest = r;
      if (smallest === i) break;
      [d[smallest], d[i]] = [d[i], d[smallest]];
      i = smallest;
    }
  }
}

// ---------------------------------------------------------------------------
function isWater(t: TerrainType): boolean {
  return t === 'ocean' || t === 'water';
}

// ---------------------------------------------------------------------------
// HydrologyGenerator
// ---------------------------------------------------------------------------
export class HydrologyGenerator {
  readonly precipitation!: Float32Array;
  readonly flowDirection!: Int32Array;
  readonly flowAccumulation!: Float32Array;
  readonly moisture!: Float32Array;
  readonly rivers!: number[][];

  constructor(topo: TopographyGenerator, seed: number) {
    this._build(topo, seed);
  }

  // -----------------------------------------------------------------------
  private _build(topo: TopographyGenerator, seed: number): void {
    const { mesh, elevation, terrainType } = topo;
    const N = mesh.numRegions;
    const rng = mulberry32(seed ^ 0xf100d);

    // Step 0: adjacency
    const adj = this._buildAdjacency(mesh);

    // Step 1: precipitation
    const precipitation = this._computePrecipitation(
      mesh.points, elevation, terrainType, adj, N, rng,
    );

    // Step 2: fill sinks
    const filledElev = this._fillSinks(elevation, terrainType, adj, N);

    // Step 3: flow direction
    const flowDirection = this._computeFlowDirection(filledElev, terrainType, adj, N);

    // Step 4: flow accumulation
    const flowAccumulation = this._computeFlowAccumulation(
      filledElev, flowDirection, terrainType, N,
    );

    // Step 5: rivers
    const rivers = this._extractRivers(flowDirection, flowAccumulation, terrainType, N);

    // Step 6: moisture
    const moisture = this._computeMoisture(
      precipitation, flowAccumulation, rivers, adj, terrainType, N,
    );

    (this as any).precipitation = precipitation;
    (this as any).flowDirection = flowDirection;
    (this as any).flowAccumulation = flowAccumulation;
    (this as any).moisture = moisture;
    (this as any).rivers = rivers;
  }

  // -----------------------------------------------------------------------
  // Step 0: build adjacency in O(E) instead of O(R*E)
  // -----------------------------------------------------------------------
  private _buildAdjacency(mesh: DualMesh): number[][] {
    const N = mesh.numRegions;
    const adj: number[][] = new Array(N);
    for (let i = 0; i < N; i++) adj[i] = [];

    const triangles = mesh.delaunay.triangles;
    const halfedges = mesh.delaunay.halfedges;
    const numEdges = triangles.length;

    // Use a flat boolean grid for dedup (faster than Set for small neighbor counts)
    // We'll use a per-region marker array and clear as we go
    const seen = new Uint8Array(N);
    const touchedRegions: number[] = [];

    for (let r = 0; r < N; r++) seen[r] = 0;

    // Group edges by region using a single pass
    for (let e = 0; e < numEdges; e++) {
      const r = triangles[e];
      const opp = halfedges[e];
      if (opp === -1) continue;
      const neighbor = triangles[opp];
      if (r === neighbor) continue;
      if (!seen[neighbor]) {
        // We need per-region dedup — but seen is global.
        // Instead, just collect and dedup per-region after.
      }
    }

    // Simpler approach: iterate edges, build with Set-based dedup
    const sets: Set<number>[] = new Array(N);
    for (let i = 0; i < N; i++) sets[i] = new Set();

    for (let e = 0; e < numEdges; e++) {
      const r = triangles[e];
      const opp = halfedges[e];
      if (opp === -1) continue;
      const neighbor = triangles[opp];
      if (r !== neighbor) sets[r].add(neighbor);
    }

    for (let i = 0; i < N; i++) adj[i] = Array.from(sets[i]);
    return adj;
  }

  // -----------------------------------------------------------------------
  // Step 1: precipitation with westerly wind rain shadow
  // -----------------------------------------------------------------------
  private _computePrecipitation(
    points: Point[],
    elevation: Float32Array,
    terrain: TerrainType[],
    adj: number[][],
    N: number,
    rng: () => number,
  ): Float32Array {
    // Sort regions west-to-east
    const sorted = new Array(N);
    for (let i = 0; i < N; i++) sorted[i] = i;
    sorted.sort((a: number, b: number) => points[a].x - points[b].x);

    const airMoisture = new Float32Array(N);
    const precipitation = new Float32Array(N);

    for (let si = 0; si < N; si++) {
      const r = sorted[si];

      // Gather moisture from western neighbors
      const neighbors = adj[r];
      let moistureSum = 0;
      let totalWeight = 0;

      for (let ni = 0; ni < neighbors.length; ni++) {
        const n = neighbors[ni];
        const dx = points[r].x - points[n].x;
        if (dx <= 0) continue; // only look west
        const dy = points[r].y - points[n].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const alignment = dx / dist; // 1.0 = directly west
        const w = alignment;
        moistureSum += airMoisture[n] * w;
        totalWeight += w;
      }

      if (totalWeight > 0) {
        airMoisture[r] = moistureSum / totalWeight;
      } else {
        airMoisture[r] = isWater(terrain[r]) ? BASE_MOISTURE : BASE_MOISTURE * 0.3;
      }

      // Ocean/water recharges air moisture
      if (isWater(terrain[r])) {
        airMoisture[r] = Math.min(BASE_MOISTURE, airMoisture[r] + OCEAN_RECHARGE);
        precipitation[r] = 0;
        continue;
      }

      // Orographic uplift: compare elevation to western neighbors
      let avgWestElev = 0;
      let westCount = 0;
      for (let ni = 0; ni < neighbors.length; ni++) {
        const n = neighbors[ni];
        if (points[n].x < points[r].x) {
          avgWestElev += elevation[n];
          westCount++;
        }
      }
      if (westCount > 0) avgWestElev /= westCount;

      const elevGain = Math.max(0, elevation[r] - avgWestElev);
      const precipRate = BASE_PRECIP_RATE + elevGain * UPLIFT_FACTOR;
      let precipAmount = airMoisture[r] * precipRate;
      precipAmount = Math.min(precipAmount, airMoisture[r] * 0.9);

      precipitation[r] = precipAmount;
      airMoisture[r] = Math.max(0.01, airMoisture[r] - precipAmount);
    }

    // Add noise jitter
    for (let r = 0; r < N; r++) {
      precipitation[r] *= 0.85 + 0.3 * rng();
    }

    // Normalize to [0..1]
    let maxP = 0;
    for (let r = 0; r < N; r++) if (precipitation[r] > maxP) maxP = precipitation[r];
    if (maxP > 0) {
      for (let r = 0; r < N; r++) precipitation[r] /= maxP;
    }

    // Mild contrast curve: amplify differences without crushing wet regions
    for (let r = 0; r < N; r++) {
      precipitation[r] = Math.pow(precipitation[r], 1.4);
    }

    return precipitation;
  }

  // -----------------------------------------------------------------------
  // Step 2: fill sinks via priority flood
  // -----------------------------------------------------------------------
  private _fillSinks(
    elevation: Float32Array,
    terrain: TerrainType[],
    adj: number[][],
    N: number,
  ): Float32Array {
    const filled = new Float32Array(N);
    for (let i = 0; i < N; i++) filled[i] = elevation[i];

    const visited = new Uint8Array(N);
    const pq = new MinHeap();

    // Seed with all ocean/water regions
    for (let r = 0; r < N; r++) {
      if (isWater(terrain[r])) {
        pq.push(r, filled[r]);
        visited[r] = 1;
      }
    }

    // Flood inward
    while (pq.length > 0) {
      const { key: r, pri: rElev } = pq.pop();
      const neighbors = adj[r];
      for (let ni = 0; ni < neighbors.length; ni++) {
        const n = neighbors[ni];
        if (visited[n]) continue;
        visited[n] = 1;
        if (filled[n] < rElev) {
          filled[n] = rElev + 1e-5;
        }
        pq.push(n, filled[n]);
      }
    }

    return filled;
  }

  // -----------------------------------------------------------------------
  // Step 3: flow direction — steepest descent to lowest neighbor
  // -----------------------------------------------------------------------
  private _computeFlowDirection(
    filledElev: Float32Array,
    terrain: TerrainType[],
    adj: number[][],
    N: number,
  ): Int32Array {
    const flow = new Int32Array(N).fill(-1);

    for (let r = 0; r < N; r++) {
      if (isWater(terrain[r])) continue; // sinks stay -1

      let bestN = -1;
      let bestE = filledElev[r];
      const neighbors = adj[r];
      for (let ni = 0; ni < neighbors.length; ni++) {
        const n = neighbors[ni];
        if (filledElev[n] < bestE) {
          bestE = filledElev[n];
          bestN = n;
        }
      }
      flow[r] = bestN;
    }

    return flow;
  }

  // -----------------------------------------------------------------------
  // Step 4: flow accumulation — process highest-first, propagate downstream
  // -----------------------------------------------------------------------
  private _computeFlowAccumulation(
    filledElev: Float32Array,
    flowDir: Int32Array,
    terrain: TerrainType[],
    N: number,
  ): Float32Array {
    const accum = new Float32Array(N);

    // Collect land regions and sort by elevation descending
    const landRegions: number[] = [];
    for (let r = 0; r < N; r++) {
      if (!isWater(terrain[r])) {
        accum[r] = 1.0;
        landRegions.push(r);
      }
    }

    landRegions.sort((a, b) => filledElev[b] - filledElev[a]);

    for (let i = 0; i < landRegions.length; i++) {
      const r = landRegions[i];
      const d = flowDir[r];
      if (d !== -1) {
        accum[d] += accum[r];
      }
    }

    return accum;
  }

  // -----------------------------------------------------------------------
  // Step 5: extract river network
  // -----------------------------------------------------------------------
  private _extractRivers(
    flowDir: Int32Array,
    accum: Float32Array,
    terrain: TerrainType[],
    N: number,
  ): number[][] {
    // Mark river regions
    const isRiver = new Uint8Array(N);
    for (let r = 0; r < N; r++) {
      if (accum[r] >= RIVER_THRESHOLD && !isWater(terrain[r])) {
        isRiver[r] = 1;
      }
    }

    // Build upstream lookup
    const upstream: number[][] = new Array(N);
    for (let i = 0; i < N; i++) upstream[i] = [];
    for (let r = 0; r < N; r++) {
      const d = flowDir[r];
      if (d !== -1) upstream[d].push(r);
    }

    // Find river heads: river regions with no upstream river neighbor
    const heads: number[] = [];
    for (let r = 0; r < N; r++) {
      if (!isRiver[r]) continue;
      let hasUpstream = false;
      const ups = upstream[r];
      for (let i = 0; i < ups.length; i++) {
        if (isRiver[ups[i]]) { hasUpstream = true; break; }
      }
      if (!hasUpstream) heads.push(r);
    }

    // Trace each river from head to ocean
    const visited = new Uint8Array(N);
    const rivers: number[][] = [];

    for (let hi = 0; hi < heads.length; hi++) {
      const path: number[] = [];
      let r = heads[hi];
      while (r !== -1 && !visited[r] && !isWater(terrain[r])) {
        visited[r] = 1;
        path.push(r);
        r = flowDir[r];
      }
      // Include junction (where tributary meets main river) or mouth (water)
      if (r !== -1) {
        path.push(r);
      }
      if (path.length >= 2) rivers.push(path);
    }

    // Major rivers first
    rivers.sort((a, b) => b.length - a.length);
    return rivers;
  }

  // -----------------------------------------------------------------------
  // Step 6: soil moisture
  // -----------------------------------------------------------------------
  private _computeMoisture(
    precip: Float32Array,
    accum: Float32Array,
    rivers: number[][],
    adj: number[][],
    terrain: TerrainType[],
    N: number,
  ): Float32Array {
    // River proximity via multi-source BFS
    const riverDist = new Float32Array(N).fill(Infinity);
    const queue: number[] = [];

    for (let ri = 0; ri < rivers.length; ri++) {
      const path = rivers[ri];
      for (let pi = 0; pi < path.length; pi++) {
        const r = path[pi];
        if (!isWater(terrain[r]) && riverDist[r] === Infinity) {
          riverDist[r] = 0;
          queue.push(r);
        }
      }
    }

    let head = 0;
    while (head < queue.length) {
      const r = queue[head++];
      if (riverDist[r] >= RIVER_SPREAD_DIST) continue;
      const neighbors = adj[r];
      for (let ni = 0; ni < neighbors.length; ni++) {
        const n = neighbors[ni];
        if (isWater(terrain[n])) continue;
        const nd = riverDist[r] + 1;
        if (nd < riverDist[n]) {
          riverDist[n] = nd;
          queue.push(n);
        }
      }
    }

    // River proximity component [0..1]
    const riverProx = new Float32Array(N);
    for (let r = 0; r < N; r++) {
      if (riverDist[r] <= RIVER_SPREAD_DIST) {
        riverProx[r] = 1.0 - riverDist[r] / RIVER_SPREAD_DIST;
      }
    }

    // Drainage component: log-scaled accumulation [0..1]
    const drainage = new Float32Array(N);
    let maxLog = 0;
    for (let r = 0; r < N; r++) {
      if (!isWater(terrain[r]) && accum[r] > 0) {
        drainage[r] = Math.log(1 + accum[r]);
        if (drainage[r] > maxLog) maxLog = drainage[r];
      }
    }
    if (maxLog > 0) {
      for (let r = 0; r < N; r++) drainage[r] /= maxLog;
    }

    // Combine
    const moisture = new Float32Array(N);
    for (let r = 0; r < N; r++) {
      if (isWater(terrain[r])) {
        moisture[r] = 1.0;
        continue;
      }
      const raw = precip[r] * PRECIP_WEIGHT +
        riverProx[r] * RIVER_WEIGHT +
        drainage[r] * DRAINAGE_WEIGHT;
      // Gentle S-curve: boost contrast while keeping enough moisture for forests
      const clamped = Math.min(1, Math.max(0, raw));
      const t = clamped * 2 - 1; // remap to [-1, 1]
      moisture[r] = Math.min(1, Math.max(0, (t * Math.abs(t) + 1) / 2));
    }

    return moisture;
  }
}
