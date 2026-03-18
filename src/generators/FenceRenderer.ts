/**
 * FenceRenderer — post-and-rail fence following Voronoi cell polygon edges.
 *
 * For each pasture region:
 *   - Walk the half-edge ring to enumerate Voronoi polygon edges
 *   - Skip any edge whose neighbour is also a pasture (shared border = no fence)
 *   - Draw a 3px-tall post at each exterior vertex
 *   - Draw a single-pixel rail at height 1 along each exterior edge (Bresenham)
 *
 * Fence pixels are clipped to source-space pixels that belong to the pasture
 * region or its immediate neighbour region, preventing lines from straying
 * outside the actual rendered tile boundary.
 *
 * All fence pixels are returned in `fencePixels` for per-frame restoration
 * after cow animation, so cows never permanently erase fence segments.
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
    regionGrid: Uint16Array | null,
  ): { fencePixels: { idx: number; color: number }[] } {
    const fencePixels: { idx: number; color: number }[] = [];
    const scale = topo.size / N;
    const { mesh } = topo;
    const { delaunay, triCenters } = mesh;
    const halfedges = delaunay.halfedges;
    const triangles = delaunay.triangles;
    const numEdges  = mesh.numEdges;

    for (const pd of pastures) {
      const r = pd.regionIndex;

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

          if (this._inBounds(x0, y0, N) || this._inBounds(x1, y1, N)) {
            this._post(pixels, x0, y0, N, ext, fencePixels, regionGrid, r, neighbor);
            this._post(pixels, x1, y1, N, ext, fencePixels, regionGrid, r, neighbor);
            this._rail(pixels, x0, y0, x1, y1, N, ext, fencePixels, regionGrid, r, neighbor);
          }
        }

        e = opp;
      } while (e !== startEdge);
    }

    return { fencePixels };
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
    cap: { idx: number; color: number }[],
    regionGrid: Uint16Array | null,
    r1: number, _r2: number,
  ): void {
    const cx = Math.max(0, Math.min(N - 1, px));
    const cy = Math.max(0, Math.min(N - 1, py));

    // Clip: only draw on pixels that belong to the pasture region itself,
    // so fence never bleeds into neighbouring terrain.
    if (regionGrid && regionGrid[cy * N + cx] !== r1) return;

    const base = this._sBase(cy * N + cx, cy, ext);
    for (let h = 0; h < 3; h++) {
      const sy = base - h;
      if (sy < 0 || sy >= N) continue;
      const si = sy * N + cx;
      cap.push({ idx: si, color: FENCE_POST });
      pixels[si] = FENCE_POST;
    }
  }

  /** Bresenham line; rail + intermediate posts every POST_INTERVAL steps. */
  private _rail(
    pixels: Uint32Array,
    x0: number, y0: number, x1: number, y1: number,
    N: number, ext: Int16Array | null,
    cap: { idx: number; color: number }[],
    regionGrid: Uint16Array | null,
    r1: number, r2: number,
  ): void {
    let cx = Math.round(x0), cy = Math.round(y0);
    const ex = Math.round(x1), ey = Math.round(y1);
    const dx = Math.abs(ex - cx), dy = Math.abs(ey - cy);
    const sx = cx < ex ? 1 : -1;
    const sy = cy < ey ? 1 : -1;
    let err = dx - dy;
    let step = 0;
    const POST_INTERVAL = 8;  // intermediate post every 8 Bresenham steps

    for (;;) {
      if (cx >= 0 && cx < N && cy >= 0 && cy < N) {
        // Only draw on pixels that belong to the pasture region itself —
        // drawing on the neighbour causes fence to bleed into adjacent cells.
        const srcIdx = cy * N + cx;
        const inRegion = !regionGrid || regionGrid[srcIdx] === r1;
        if (inRegion) {
          const base = this._sBase(srcIdx, cy, ext);
          if (step > 0 && step % POST_INTERVAL === 0) {
            // Intermediate post — 3px tall, sitting on rail height
            for (let h = 0; h < 3; h++) {
              const psy = base - h;
              if (psy >= 0 && psy < N) {
                const pi = psy * N + cx;
                cap.push({ idx: pi, color: FENCE_POST });
                pixels[pi] = FENCE_POST;
              }
            }
          } else {
            const screenY = base - 1;
            if (screenY >= 0 && screenY < N) {
              const si = screenY * N + cx;
              cap.push({ idx: si, color: FENCE_RAIL });
              pixels[si] = FENCE_RAIL;
            }
          }
        }
      }
      if (cx === ex && cy === ey) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 <  dx) { err += dx; cy += sy; }
      step++;
    }
  }

  private _sBase(srcIdx: number, py: number, ext: Int16Array | null): number {
    return ext ? py - ext[srcIdx] : py;
  }
}
