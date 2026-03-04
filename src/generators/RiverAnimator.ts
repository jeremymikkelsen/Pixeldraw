import { TopographyGenerator, mulberry32 } from './TopographyGenerator';
import { HydrologyGenerator } from './HydrologyGenerator';
import { packABGR } from './TerrainPalettes';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_RIVER_WIDTH = 6;
const RIVER_MIN_FLOW = 25;

// Slope thresholds
const RAPIDS_SLOPE = 0.03;
const WATERFALL_SLOPE = 0.06;

// Animation speeds (pixels per second along flow direction)
const CALM_SPEED = 8;
const RAPIDS_SPEED = 20;

// Wave frequency (higher = tighter highlight bands)
const WAVE_FREQ = 0.6;

// Rock/log placement
const ROCK_CHANCE = 0.003;      // per river pixel
const LOG_CHANCE = 0.0008;      // per Bresenham step on narrow rivers

// ---------------------------------------------------------------------------
// River pixel metadata (packed for memory efficiency)
// ---------------------------------------------------------------------------
const enum PixelType {
  Water = 0,
  Rock = 1,
  Log = 2,
}

interface RiverPixel {
  idx: number;       // pixel index (y * N + x)
  flowDirX: number;  // normalized flow direction
  flowDirY: number;
  slope: number;     // elevation change magnitude for this segment
  widthTier: number; // 0=narrow, 1=mid, 2=wide (for color depth)
  phase: number;     // dot(pos, flowDir) for wave animation
  type: PixelType;
}

// ---------------------------------------------------------------------------
// Color palettes
// ---------------------------------------------------------------------------

// Calm water: 3 depth shades × 3 brightness levels (dark/mid/light)
const CALM_COLORS = [
  // Narrow (shallow)
  [packABGR(0x22, 0x5e, 0x7a), packABGR(0x2a, 0x70, 0x90), packABGR(0x38, 0x88, 0xa8)],
  // Mid
  [packABGR(0x20, 0x56, 0x74), packABGR(0x28, 0x65, 0x88), packABGR(0x34, 0x80, 0xa0)],
  // Wide (deep)
  [packABGR(0x1c, 0x4e, 0x6c), packABGR(0x25, 0x5c, 0x80), packABGR(0x30, 0x78, 0x98)],
];

// Foam/rapids highlight
const FOAM_COLOR = packABGR(0xb0, 0xd0, 0xe0);
const FOAM_BRIGHT = packABGR(0xc8, 0xe4, 0xf0);

// Rock color
const ROCK_COLOR = packABGR(0x48, 0x42, 0x3c);
const ROCK_DARK = packABGR(0x38, 0x34, 0x30);

// Log color
const LOG_COLOR = packABGR(0x5a, 0x46, 0x30);
const LOG_DARK = packABGR(0x48, 0x38, 0x28);

// ---------------------------------------------------------------------------
// RiverAnimator
// ---------------------------------------------------------------------------
export class RiverAnimator {
  private _pixels: RiverPixel[] = [];
  private _N: number;

  constructor(
    topo: TopographyGenerator,
    hydro: HydrologyGenerator,
    resolution: number,
    seed: number,
  ) {
    this._N = resolution;
    this._build(topo, hydro, resolution, seed);
  }

  get pixelCount(): number { return this._pixels.length; }

  // -----------------------------------------------------------------------
  // Pre-compute all river pixel positions and metadata
  // -----------------------------------------------------------------------
  private _build(
    topo: TopographyGenerator,
    hydro: HydrologyGenerator,
    resolution: number,
    seed: number,
  ): void {
    const rng = mulberry32(seed ^ 0xa10e0000);
    const N = resolution;
    const scale = topo.size / N;
    const { points } = topo.mesh;

    const maxAccum = Math.max(RIVER_MIN_FLOW + 1,
      Math.max(...Array.from(hydro.flowAccumulation)));
    const logMin = Math.log(RIVER_MIN_FLOW);
    const logRange = Math.log(maxAccum) - logMin;

    // Set to deduplicate pixels (rivers can overlap at confluences)
    const visited = new Uint8Array(N * N);

    for (const path of hydro.rivers) {
      for (let si = 0; si < path.length - 1; si++) {
        const rA = path[si];
        const rB = path[si + 1];

        const x0 = Math.floor(points[rA].x / scale);
        const y0 = Math.floor(points[rA].y / scale);
        const x1 = Math.floor(points[rB].x / scale);
        const y1 = Math.floor(points[rB].y / scale);

        // Flow direction (normalized)
        const fdx = x1 - x0;
        const fdy = y1 - y0;
        const flen = Math.sqrt(fdx * fdx + fdy * fdy) || 1;
        const flowDirX = fdx / flen;
        const flowDirY = fdy / flen;

        // Segment slope
        const slope = Math.abs(topo.elevation[rA] - topo.elevation[rB]);

        // Width
        const flow = Math.max(RIVER_MIN_FLOW,
          hydro.flowAccumulation[rA], hydro.flowAccumulation[rB]);
        const t = Math.min(1, (Math.log(flow) - logMin) / logRange);
        const width = Math.max(1, Math.ceil(t * MAX_RIVER_WIDTH));
        const widthTier = Math.min(2, Math.floor(t * 3));

        // Log placement (on Bresenham steps, narrow rivers only)
        let logPlaced = false;

        // Walk Bresenham thick line
        this._walkThickLine(N, x0, y0, x1, y1, width,
          (px, py, isCenterLine) => {
            const idx = py * N + px;
            if (visited[idx]) return;
            visited[idx] = 1;

            // Phase for wave animation
            const phase = px * flowDirX + py * flowDirY;

            // Determine pixel type
            let type = PixelType.Water;

            // Rocks in wider calm sections
            if (width >= 3 && slope < RAPIDS_SLOPE && rng() < ROCK_CHANCE) {
              type = PixelType.Rock;
            }

            // Logs across narrow rivers (only one per segment)
            if (!logPlaced && isCenterLine && width <= 3 && slope < RAPIDS_SLOPE
                && rng() < LOG_CHANCE) {
              type = PixelType.Log;
              logPlaced = true;
              // Mark adjacent pixels as log too (perpendicular to flow)
              const perpX = Math.round(-flowDirY);
              const perpY = Math.round(flowDirX);
              for (let li = -1; li <= 1; li++) {
                const lx = px + perpX * li;
                const ly = py + perpY * li;
                if (lx >= 0 && lx < N && ly >= 0 && ly < N) {
                  const lIdx = ly * N + lx;
                  if (!visited[lIdx]) {
                    visited[lIdx] = 1;
                    this._pixels.push({
                      idx: lIdx, flowDirX, flowDirY, slope, widthTier,
                      phase: lx * flowDirX + ly * flowDirY,
                      type: PixelType.Log,
                    });
                  }
                }
              }
            }

            this._pixels.push({
              idx, flowDirX, flowDirY, slope, widthTier, phase, type,
            });
          },
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // Animate river pixels — called every frame
  // -----------------------------------------------------------------------
  animate(pixels: Uint32Array, timeMs: number): void {
    const timeSec = timeMs / 1000;

    for (let i = 0; i < this._pixels.length; i++) {
      const rp = this._pixels[i];

      // Static decorations
      if (rp.type === PixelType.Rock) {
        // Alternate rock colors for texture
        pixels[rp.idx] = ((rp.idx >> 1) & 1) ? ROCK_COLOR : ROCK_DARK;
        continue;
      }
      if (rp.type === PixelType.Log) {
        pixels[rp.idx] = ((rp.idx >> 2) & 1) ? LOG_COLOR : LOG_DARK;
        continue;
      }

      // Animated water
      const isRapids = rp.slope >= RAPIDS_SLOPE;
      const isWaterfall = rp.slope >= WATERFALL_SLOPE;
      const speed = isRapids ? RAPIDS_SPEED : CALM_SPEED;

      // Wave phase: highlight bands moving downstream
      const wave = Math.sin((rp.phase * WAVE_FREQ - timeSec * speed) * 0.5);
      // Map sine [-1..1] → shade index [0..2]
      const shadeIdx = wave < -0.3 ? 0 : wave > 0.3 ? 2 : 1;

      let color = CALM_COLORS[rp.widthTier][shadeIdx];

      // Rapids/waterfall foam
      if (isRapids) {
        // Hash-based per-pixel per-frame sparkle
        const sparkle = fastHash(rp.idx + Math.floor(timeSec * 8)) & 0xff;
        if (isWaterfall) {
          // Heavy foam — ~40% of pixels sparkle
          if (sparkle < 100) {
            color = sparkle < 50 ? FOAM_BRIGHT : FOAM_COLOR;
          }
        } else {
          // Light rapids foam — ~20% of pixels sparkle
          if (sparkle < 50) {
            color = FOAM_COLOR;
          }
        }
      }

      pixels[rp.idx] = color;
    }
  }

  // -----------------------------------------------------------------------
  // Bresenham thick line walker (calls callback for each pixel)
  // -----------------------------------------------------------------------
  private _walkThickLine(
    N: number,
    x0: number, y0: number, x1: number, y1: number,
    width: number,
    cb: (px: number, py: number, isCenterLine: boolean) => void,
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
          cb(px, py, ox === 0 && oy === 0);
        }
      }
      if (cx === x1 && cy === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 < dx)  { err += dx; cy += sy; }
    }
  }
}

// ---------------------------------------------------------------------------
// Fast integer hash for per-pixel sparkle (deterministic per frame)
// ---------------------------------------------------------------------------
function fastHash(n: number): number {
  let h = n | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 13), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}
