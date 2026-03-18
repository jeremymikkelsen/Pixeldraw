/**
 * FenceRenderer — post-and-rail fence following Voronoi cell polygon edges.
 *
 * For each pasture region:
 *   - Walk the half-edge ring to enumerate Voronoi polygon edges
 *   - Skip any edge whose neighbour is also a pasture (shared border = no fence)
 *   - Draw a 3px-tall post at each exterior vertex
 *   - Draw a single-pixel rail at height 1 along each exterior edge (Bresenham)
 *
 * Layer split (3/4 depth):
 *   BACK  — edges whose midpoint y < region centre y (farther from viewer)
 *           Written statically; cows appear in front of them.
 *   FRONT — edges whose midpoint y ≥ region centre y (closer to viewer)
 *           Returned as `frontFence` for per-frame restore on top of cows.
 */

import { packABGR } from './TerrainPalettes';
import type { PastureData } from './FarmRenderer';
import type { TopographyGenerator } from './TopographyGenerator';
import type { AgImprovementType } from '../state/AgImprovements';

const FENCE_POST = packABGR(0x4c, 0x32, 0x18);
const FENCE_RAIL = packABGR(0x6e, 0x4c, 0x26);

function triOfEdge(e: number)  { return Math.floor(e / 3); }
function prevEdge(e: number)   { return (e % 3 === 0) ? e + 2 : e - 1; }

export class FenceRenderer {
  render(
    pixels: Uint32Array,
    pastures: PastureData[],
    topo: TopographyGenerator,
    improvements: Map<number, AgImprovementType>,
    ext: Int16Array | null,
    N: number,
  ): { frontFence: { idx: number; color: number }[] } {
    const frontFence: { idx: number; color: number }[] = [];
    const scale = topo.size / N;            // world-units per pixel
    const { mesh } = topo;
    const { delaunay, triCenters } = mesh;
    const halfedges = delaunay.halfedges;
    const triangles = delaunay.triangles;
    const numEdges  = mesh.numEdges;

    for (const pd of pastures) {
      const r = pd.regionIndex;

      // Region centre in pixel space (for front/back split)
      const rcx = mesh.points[r].x / scale;
      const rcy = mesh.points[r].y / scale;

      // Find any half-edge that starts at region r
      let startEdge = -1;
      for (let e = 0; e < numEdges; e++) {
        if (triangles[e] === r) { startEdge = e; break; }
      }
      if (startEdge === -1) continue;

      // Walk the half-edge ring around r
      let e = startEdge;
      do {
        const fromTri  = triOfEdge(e);
        const prev     = prevEdge(e);
        const neighbor = triangles[prev];    // region across this Voronoi edge
        const opp      = halfedges[prev];
        if (opp === -1) { break; }          // hull — incomplete polygon, stop
        const toTri    = triOfEdge(opp);

        // Only draw fence on exterior edges (neighbour is not a pasture)
        if (improvements.get(neighbor) !== 'pasture') {
          const x0 = Math.round(triCenters[fromTri].x / scale);
          const y0 = Math.round(triCenters[fromTri].y / scale);
          const x1 = Math.round(triCenters[toTri].x  / scale);
          const y1 = Math.round(triCenters[toTri].y  / scale);

          // Clip to pixel bounds before drawing
          if (this._inBounds(x0, y0, N) || this._inBounds(x1, y1, N)) {
            const isFront = (y0 + y1) * 0.5 >= rcy;
            const cap = isFront ? frontFence : null;

            this._post(pixels, x0, y0, N, ext, cap);
            this._post(pixels, x1, y1, N, ext, cap);
            this._rail(pixels, x0, y0, x1, y1, N, ext, cap);
          }
        }

        e = opp;
      } while (e !== startEdge);
    }

    return { frontFence };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private _inBounds(px: number, py: number, N: number): boolean {
    return px >= 0 && px < N && py >= 0 && py < N;
  }

  /** 3-pixel tall post at source position (px, py), growing upward. */
  private _post(
    pixels: Uint32Array,
    px: number, py: number,
    N: number, ext: Int16Array | null,
    cap: { idx: number; color: number }[] | null,
  ): void {
    const cx = Math.max(0, Math.min(N - 1, px));
    const cy = Math.max(0, Math.min(N - 1, py));
    const base = this._sBase(cy * N + cx, cy, ext);
    for (let h = 0; h < 3; h++) {
      const sy = base - h;
      if (sy < 0 || sy >= N) continue;
      const si = sy * N + cx;
      pixels[si] = FENCE_POST;
      if (cap) cap.push({ idx: si, color: FENCE_POST });
    }
  }

  /** Bresenham line; rail pixel drawn at height 1 above terrain base. */
  private _rail(
    pixels: Uint32Array,
    x0: number, y0: number, x1: number, y1: number,
    N: number, ext: Int16Array | null,
    cap: { idx: number; color: number }[] | null,
  ): void {
    let cx = Math.round(x0), cy = Math.round(y0);
    const ex = Math.round(x1), ey = Math.round(y1);
    const dx = Math.abs(ex - cx), dy = Math.abs(ey - cy);
    const sx = cx < ex ? 1 : -1;
    const sy = cy < ey ? 1 : -1;
    let err = dx - dy;

    for (;;) {
      if (cx >= 0 && cx < N && cy >= 0 && cy < N) {
        const screenY = this._sBase(cy * N + cx, cy, ext) - 1;
        if (screenY >= 0 && screenY < N) {
          const si = screenY * N + cx;
          pixels[si] = FENCE_RAIL;
          if (cap) cap.push({ idx: si, color: FENCE_RAIL });
        }
      }
      if (cx === ex && cy === ey) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 <  dx) { err += dx; cy += sy; }
    }
  }

  private _sBase(srcIdx: number, py: number, ext: Int16Array | null): number {
    return ext ? py - ext[srcIdx] : py;
  }
}
