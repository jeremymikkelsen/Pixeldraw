/**
 * RoadRenderer
 *
 * Draws stone roads between duchy capitals onto the pixel buffer.
 * Roads are 3-4px wide gray cobblestone with slight color variation.
 * Also marks road pixels in a mask so trees won't overlap them.
 * Supports bridge rendering where roads cross rivers.
 *
 * Per-step logic:
 *   - If this step's stamp overlaps the river mask → draw bridge at center (no offset)
 *   - Else if segment is parallel to the river → draw road offset 5px to the right
 *   - Else → draw road at center
 * Connector segments are drawn whenever the draw position jumps (parallel↔bridge
 * transitions within a segment, or between adjacent road segments).
 */

import { TopographyGenerator, mulberry32 } from './TopographyGenerator';
import { createNoise2D } from 'simplex-noise';
import { packABGR } from './TerrainPalettes';
import { RoadSegment } from './RoadGenerator';

// Cobblestone palette — warm gray with slight variation
const ROAD_COLORS = [
  packABGR(0x8a, 0x82, 0x76),  // base stone
  packABGR(0x7e, 0x78, 0x6c),  // darker stone
  packABGR(0x96, 0x8c, 0x80),  // lighter stone
  packABGR(0x72, 0x6c, 0x64),  // shadow stone
  packABGR(0x90, 0x88, 0x7a),  // warm stone
];

// Bridge colors
const BRIDGE_DECK    = packABGR(0xb0, 0xa6, 0x96);  // lighter stone
const BRIDGE_PARAPET = packABGR(0x50, 0x48, 0x42);  // dark stone border

const ROAD_WIDTH = 4;

export class RoadRenderer {
  bridgeMask: Uint8Array = new Uint8Array(0);

  /**
   * Render roads onto the pixel buffer and return a mask of road pixels.
   * The mask can be merged with structureMask to prevent trees on roads.
   * If riverMask is provided, bridges will be drawn where roads cross rivers.
   */
  render(
    pixels: Uint32Array,
    topo: TopographyGenerator,
    resolution: number,
    seed: number,
    roads: RoadSegment[],
    riverMask?: Uint8Array,
  ): Uint8Array {
    const N = resolution;
    const scale = topo.size / N;
    const points = topo.mesh.points;
    const roadMask = new Uint8Array(N * N);
    this.bridgeMask = new Uint8Array(N * N);

    // Noise for color variation
    const rng = mulberry32(seed ^ 0xc0bb1e);
    const noise = createNoise2D(rng);

    for (const road of roads) {
      const { path } = road;
      let prevEndX = -1, prevEndY = -1;

      for (let si = 0; si < path.length - 1; si++) {
        const rA = path[si];
        const rB = path[si + 1];

        const x0 = Math.floor(points[rA].x / scale);
        const y0 = Math.floor(points[rA].y / scale);
        const x1 = Math.floor(points[rB].x / scale);
        const y1 = Math.floor(points[rB].y / scale);

        const result = this._drawRoadSegment(
          pixels, roadMask, this.bridgeMask, N, x0, y0, x1, y1, noise,
          riverMask ?? null, prevEndX, prevEndY,
        );
        prevEndX = result.endX;
        prevEndY = result.endY;
      }
    }

    return roadMask;
  }

  // -------------------------------------------------------------------------
  // Draw one Voronoi edge as a road segment. Returns the last draw position
  // so the next segment can draw a connector if the offset changes.
  // -------------------------------------------------------------------------
  private _drawRoadSegment(
    pixels: Uint32Array,
    mask: Uint8Array,
    bridgeMask: Uint8Array,
    N: number,
    x0: number, y0: number,
    x1: number, y1: number,
    noise: (x: number, y: number) => number,
    riverMask: Uint8Array | null,
    prevEndX: number,
    prevEndY: number,
  ): { endX: number; endY: number } {
    const rawDX = x1 - x0;
    const rawDY = y1 - y0;
    const absDX = Math.abs(rawDX);
    const absDY = Math.abs(rawDY);
    const sx = rawDX > 0 ? 1 : (rawDX < 0 ? -1 : 0);
    const sy = rawDY > 0 ? 1 : (rawDY < 0 ? -1 : 0);
    const r = (ROAD_WIDTH - 1) >> 1;

    // -----------------------------------------------------------------------
    // Classify segment: count how many centerline steps land on the river.
    // If > 40% → treat whole segment as running parallel to the river.
    // -----------------------------------------------------------------------
    let overlapSteps = 0, totalSteps = 0;
    {
      let cx = x0, cy = y0;
      let err = absDX - absDY;
      while (true) {
        if (riverMask && cx >= 0 && cy >= 0 && cx < N && cy < N && riverMask[cy * N + cx]) {
          overlapSteps++;
        }
        totalSteps++;
        if (cx === x1 && cy === y1) break;
        const e2 = 2 * err;
        if (e2 > -absDY) { err -= absDY; cx += sx; }
        if (e2 < absDX)  { err += absDX; cy += sy; }
      }
    }

    const isParallel = totalSteps > 3 && overlapSteps / totalSteps > 0.4;

    // Perpendicular offset for parallel sections (right-hand side of travel direction)
    const segLen = Math.sqrt(rawDX * rawDX + rawDY * rawDY) || 1;
    const offX = isParallel ? Math.round(-rawDY / segLen * 5) : 0;
    const offY = isParallel ? Math.round(rawDX / segLen * 5) : 0;

    // -----------------------------------------------------------------------
    // Main draw pass — per-step bridge detection overrides offset
    // -----------------------------------------------------------------------
    let cx = x0, cy = y0;
    let err = absDX - absDY;
    let lastDrawX = prevEndX;
    let lastDrawY = prevEndY;

    while (true) {
      // Bridge check: does the stamp at the ACTUAL center overlap the river?
      let isBridge = false;
      if (riverMask !== null) {
        outer: for (let oy = -r; oy <= r; oy++) {
          for (let ox = -r; ox <= r; ox++) {
            const checkX = cx + ox, checkY = cy + oy;
            if (checkX >= 0 && checkY >= 0 && checkX < N && checkY < N
                && riverMask[checkY * N + checkX]) {
              isBridge = true;
              break outer;
            }
          }
        }
      }

      // Bridge always draws at center; otherwise apply parallel offset
      const drawCX = isBridge ? cx : cx + offX;
      const drawCY = isBridge ? cy : cy + offY;

      // Draw connector if draw position jumped (offset↔bridge or inter-segment gap)
      if (lastDrawX >= 0 && (Math.abs(drawCX - lastDrawX) > 1 || Math.abs(drawCY - lastDrawY) > 1)) {
        this._drawConnector(pixels, mask, N, lastDrawX, lastDrawY, drawCX, drawCY, r, noise);
      }

      this._drawStamp(pixels, mask, bridgeMask, N, drawCX, drawCY, r, isBridge, noise);
      lastDrawX = drawCX;
      lastDrawY = drawCY;

      if (cx === x1 && cy === y1) break;
      const e2 = 2 * err;
      if (e2 > -absDY) { err -= absDY; cx += sx; }
      if (e2 < absDX)  { err += absDX; cy += sy; }
    }

    return { endX: lastDrawX, endY: lastDrawY };
  }

  // -------------------------------------------------------------------------
  // Draw a single road/bridge stamp (filled square of radius r)
  // -------------------------------------------------------------------------
  private _drawStamp(
    pixels: Uint32Array,
    mask: Uint8Array,
    bridgeMask: Uint8Array | null,
    N: number,
    cx: number, cy: number,
    r: number,
    isBridge: boolean,
    noise: (x: number, y: number) => number,
  ): void {
    for (let oy = -r; oy <= r; oy++) {
      const py = cy + oy;
      if (py < 0 || py >= N) continue;
      for (let ox = -r; ox <= r; ox++) {
        const px = cx + ox;
        if (px < 0 || px >= N) continue;
        const idx = py * N + px;
        if (isBridge) {
          const isEdge = Math.abs(ox) === r || Math.abs(oy) === r;
          pixels[idx] = isEdge ? BRIDGE_PARAPET : BRIDGE_DECK;
          if (bridgeMask) bridgeMask[idx] = 1;
        } else {
          const n = noise(px * 0.15, py * 0.15);
          const ci = Math.abs(n) < 0.2 ? 0
            : n < -0.4 ? 3
            : n < 0 ? 1
            : n < 0.4 ? 4
            : 2;
          pixels[idx] = ROAD_COLORS[ci];
        }
        mask[idx] = 1;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Draw a short road connector between two positions (Bresenham, road colors)
  // -------------------------------------------------------------------------
  private _drawConnector(
    pixels: Uint32Array,
    mask: Uint8Array,
    N: number,
    x0: number, y0: number,
    x1: number, y1: number,
    r: number,
    noise: (x: number, y: number) => number,
  ): void {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy, cx = x0, cy = y0;
    while (true) {
      this._drawStamp(pixels, mask, null, N, cx, cy, r, false, noise);
      if (cx === x1 && cy === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 < dx)  { err += dx; cy += sy; }
    }
  }
}
