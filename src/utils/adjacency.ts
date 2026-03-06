/**
 * Shared adjacency-list builder for the DualMesh.
 * Extracts the O(E) adjacency construction from HydrologyGenerator
 * so it can be reused by DuchyGenerator, RoadGenerator, etc.
 */

import { DualMesh } from '../generators/DualMesh';

/**
 * Build a per-region adjacency list from the Delaunay triangulation.
 * Returns adj[r] = array of neighbor region indices for region r.
 */
export function buildAdjacencyList(mesh: DualMesh): number[][] {
  const N = mesh.numRegions;
  const triangles = mesh.delaunay.triangles;
  const halfedges = mesh.delaunay.halfedges;
  const numEdges = triangles.length;

  const sets: Set<number>[] = new Array(N);
  for (let i = 0; i < N; i++) sets[i] = new Set();

  for (let e = 0; e < numEdges; e++) {
    const r = triangles[e];
    const opp = halfedges[e];
    if (opp === -1) continue;
    const neighbor = triangles[opp];
    if (r !== neighbor) sets[r].add(neighbor);
  }

  const adj: number[][] = new Array(N);
  for (let i = 0; i < N; i++) adj[i] = Array.from(sets[i]);
  return adj;
}
