/**
 * RoadGenerator
 *
 * Builds a road network connecting all 9 duchy capitals using A* pathfinding
 * over the Voronoi region adjacency graph. Roads avoid ocean/water and prefer
 * low-elevation terrain.
 *
 * River crossing rule: roads may only cross rivers at >80° (nearly perpendicular).
 * Edges that pass through a river region at a shallower angle receive a heavy
 * cost penalty, so A* routes the road to a perpendicular crossing instead.
 *
 * Output: an array of RoadSegment[], each being a sequence of region indices
 * forming a path between two capitals.
 */

import { TopographyGenerator, TerrainType } from './TopographyGenerator';
import { HydrologyGenerator } from './HydrologyGenerator';
import { buildAdjacencyList } from '../utils/adjacency';
import { Duchy } from '../state/Duchy';

export interface RoadSegment {
  from: number;  // duchy index
  to: number;    // duchy index
  path: number[];  // region indices from capital to capital
}

/**
 * Movement cost per terrain type. Ocean/water are impassable.
 */
function terrainCost(t: TerrainType): number {
  switch (t) {
    case 'ocean':    return Infinity;
    case 'water':    return Infinity;
    case 'coast':    return 1.2;
    case 'lowland':  return 1.0;
    case 'highland': return 1.8;
    case 'rock':     return 4.0;
    case 'cliff':    return 8.0;
  }
}

/**
 * Build a map from river region index → normalized river flow direction.
 * Used to penalize road edges that cross rivers at shallow angles.
 */
function buildRiverDirMap(
  hydro: HydrologyGenerator,
  topo: TopographyGenerator,
): Map<number, { x: number; y: number }> {
  const points = topo.mesh.points;
  const map = new Map<number, { x: number; y: number }>();

  for (const path of hydro.rivers) {
    for (let i = 0; i < path.length - 1; i++) {
      const rA = path[i], rB = path[i + 1];
      const dx = points[rB].x - points[rA].x;
      const dy = points[rB].y - points[rA].y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const dir = { x: dx / len, y: dy / len };
      // Overwrite is fine — last segment direction for that region is close enough
      map.set(rA, dir);
      map.set(rB, dir);
    }
  }

  return map;
}

// cos(80°) ≈ 0.174 — crossings shallower than 80° get penalized
const COS_80 = Math.cos((80 * Math.PI) / 180);

/**
 * A* pathfinding between two regions on the Voronoi adjacency graph.
 * Returns array of region indices from start to goal, or null if no path.
 */
function astar(
  start: number,
  goal: number,
  adj: number[][],
  topo: TopographyGenerator,
  riverDirMap: Map<number, { x: number; y: number }>,
): number[] | null {
  const points = topo.mesh.points;
  const terrain = topo.terrainType;

  // Euclidean distance heuristic
  const heuristic = (r: number) => {
    const dx = points[r].x - points[goal].x;
    const dy = points[r].y - points[goal].y;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const gScore = new Map<number, number>();
  const fScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  const closed = new Set<number>();

  gScore.set(start, 0);
  fScore.set(start, heuristic(start));

  // Simple binary heap for the open set
  const open: number[] = [start];
  const openSet = new Set<number>([start]);

  const popBest = (): number => {
    let bestIdx = 0;
    let bestF = fScore.get(open[0]) ?? Infinity;
    for (let i = 1; i < open.length; i++) {
      const f = fScore.get(open[i]) ?? Infinity;
      if (f < bestF) { bestF = f; bestIdx = i; }
    }
    const r = open[bestIdx];
    open[bestIdx] = open[open.length - 1];
    open.pop();
    openSet.delete(r);
    return r;
  };

  while (open.length > 0) {
    const current = popBest();

    if (current === goal) {
      // Reconstruct path
      const path: number[] = [current];
      let c = current;
      while (cameFrom.has(c)) {
        c = cameFrom.get(c)!;
        path.push(c);
      }
      path.reverse();
      return path;
    }

    closed.add(current);

    for (const neighbor of adj[current]) {
      if (closed.has(neighbor)) continue;

      const cost = terrainCost(terrain[neighbor]);
      if (cost === Infinity) continue;

      // Edge weight: terrain cost × euclidean distance between region centers
      const edgeDX = points[neighbor].x - points[current].x;
      const edgeDY = points[neighbor].y - points[current].y;
      const dist = Math.sqrt(edgeDX * edgeDX + edgeDY * edgeDY);

      // Slope penalty for steep climbs
      const elevDiff = Math.abs(topo.elevation[neighbor] - topo.elevation[current]);
      const slopePenalty = 1 + elevDiff * 10;

      // River crossing angle penalty:
      // If either endpoint is a river region, check the angle between this road edge
      // and the river direction. Crossings shallower than 80° get a heavy penalty.
      // |cos(θ)| = |road · river|; we want |cos| < cos(80°) ≈ 0.174.
      let riverPenalty = 1.0;
      const edgeLen = dist || 1;
      const rdx = edgeDX / edgeLen;
      const rdy = edgeDY / edgeLen;

      for (const region of [current, neighbor]) {
        const riverDir = riverDirMap.get(region);
        if (!riverDir) continue;
        const absCos = Math.abs(rdx * riverDir.x + rdy * riverDir.y);
        if (absCos > COS_80) {
          // Scale penalty: 1× at exactly 80°, up to 200× when fully parallel
          const t = (absCos - COS_80) / (1 - COS_80);
          riverPenalty = Math.max(riverPenalty, 1 + t * 199);
        }
      }

      const tentativeG = (gScore.get(current) ?? Infinity) + cost * dist * slopePenalty * riverPenalty;

      if (tentativeG < (gScore.get(neighbor) ?? Infinity)) {
        cameFrom.set(neighbor, current);
        gScore.set(neighbor, tentativeG);
        fScore.set(neighbor, tentativeG + heuristic(neighbor));
        if (!openSet.has(neighbor)) {
          open.push(neighbor);
          openSet.add(neighbor);
        }
      }
    }
  }

  return null; // no path found
}

/**
 * Build a minimum spanning tree of road connections between all 9 capitals,
 * then add shortest cross-links for any pair of adjacent duchies that share a border.
 */
export function generateRoads(
  topo: TopographyGenerator,
  hydro: HydrologyGenerator,
  duchies: Duchy[],
): RoadSegment[] {
  const adj = buildAdjacencyList(topo.mesh);
  const capitals = duchies.map(d => d.capitalRegion);
  const n = capitals.length;

  // River direction map for crossing-angle penalty
  const riverDirMap = buildRiverDirMap(hydro, topo);

  // Compute all pairwise shortest paths between capitals
  const paths: (number[] | null)[][] = Array.from({ length: n }, () => new Array(n).fill(null));
  const costs: number[][] = Array.from({ length: n }, () => new Array(n).fill(Infinity));

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const path = astar(capitals[i], capitals[j], adj, topo, riverDirMap);
      if (path) {
        paths[i][j] = path;
        paths[j][i] = [...path].reverse();
        costs[i][j] = path.length;
        costs[j][i] = path.length;
      }
    }
  }

  // Build MST using Prim's algorithm to connect all capitals
  const inMST = new Uint8Array(n);
  const mstEdges: [number, number][] = [];
  inMST[0] = 1;

  for (let step = 0; step < n - 1; step++) {
    let bestI = -1, bestJ = -1, bestCost = Infinity;
    for (let i = 0; i < n; i++) {
      if (!inMST[i]) continue;
      for (let j = 0; j < n; j++) {
        if (inMST[j]) continue;
        if (costs[i][j] < bestCost) {
          bestCost = costs[i][j];
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestI >= 0) {
      inMST[bestJ] = 1;
      mstEdges.push([bestI, bestJ]);
    }
  }

  // Build road segments from MST edges
  const roads: RoadSegment[] = [];
  for (const [i, j] of mstEdges) {
    const path = paths[i][j];
    if (path) {
      roads.push({ from: i, to: j, path });
    }
  }

  return roads;
}
