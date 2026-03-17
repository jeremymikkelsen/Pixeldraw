/**
 * RoadRenderer
 *
 * Draws stone roads between duchy capitals onto the pixel buffer.
 * Roads are 3-4px wide gray cobblestone with slight color variation.
 * Also marks road pixels in a mask so trees won't overlap them.
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

// Road edge/border — darker outline
const ROAD_EDGE = packABGR(0x5a, 0x54, 0x4e);

const ROAD_WIDTH = 4;

export class RoadRenderer {
  /**
   * Render roads onto the pixel buffer and return a mask of road pixels.
   * The mask can be merged with structureMask to prevent trees on roads.
   */
  render(
    pixels: Uint32Array,
    topo: TopographyGenerator,
    resolution: number,
    seed: number,
    roads: RoadSegment[],
  ): Uint8Array {
    const N = resolution;
    const scale = topo.size / N;
    const points = topo.mesh.points;
    const roadMask = new Uint8Array(N * N);

    // Noise for color variation
    const rng = mulberry32(seed ^ 0xc0bb1e);
    const noise = createNoise2D(rng);

    for (const road of roads) {
      const { path } = road;

      for (let si = 0; si < path.length - 1; si++) {
        const rA = path[si];
        const rB = path[si + 1];

        // World coords → pixel coords
        const x0 = Math.floor(points[rA].x / scale);
        const y0 = Math.floor(points[rA].y / scale);
        const x1 = Math.floor(points[rB].x / scale);
        const y1 = Math.floor(points[rB].y / scale);

        // Draw road segment with edge + fill
        this._drawRoadSegment(pixels, roadMask, N, x0, y0, x1, y1, noise);
      }
    }

    return roadMask;
  }

  private _drawRoadSegment(
    pixels: Uint32Array,
    mask: Uint8Array,
    N: number,
    x0: number, y0: number,
    x1: number, y1: number,
    noise: (x: number, y: number) => number,
  ): void {
    // First pass: draw edge (1px wider on each side)
    this._drawThickLine(pixels, mask, N, x0, y0, x1, y1, ROAD_WIDTH + 2, ROAD_EDGE, noise, true);
    // Second pass: draw fill
    this._drawThickLine(pixels, mask, N, x0, y0, x1, y1, ROAD_WIDTH, 0, noise, false);
  }

  private _drawThickLine(
    pixels: Uint32Array,
    mask: Uint8Array,
    N: number,
    x0: number, y0: number,
    x1: number, y1: number,
    width: number,
    fixedColor: number,
    noise: (x: number, y: number) => number,
    isEdge: boolean,
  ): void {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let cx = x0, cy = y0;
    const r = (width - 1) >> 1;

    while (true) {
      for (let oy = -r; oy <= r; oy++) {
        const py = cy + oy;
        if (py < 0 || py >= N) continue;
        for (let ox = -r; ox <= r; ox++) {
          const px = cx + ox;
          if (px < 0 || px >= N) continue;
          const idx = py * N + px;

          if (isEdge) {
            // Only draw edge pixels, don't set mask
            pixels[idx] = fixedColor;
          } else {
            // Cobblestone fill with noise-based color variation
            const n = noise(px * 0.15, py * 0.15);
            const ci = Math.abs(n) < 0.2 ? 0
              : n < -0.4 ? 3
              : n < 0 ? 1
              : n < 0.4 ? 4
              : 2;
            pixels[idx] = ROAD_COLORS[ci];
            mask[idx] = 1;
          }
        }
      }

      if (cx === x1 && cy === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 < dx) { err += dx; cy += sy; }
    }
  }
}
