import { createNoise2D, type NoiseFunction2D } from 'simplex-noise';
import { TopographyGenerator, mulberry32 } from './TopographyGenerator';
import { applyBrightness, packABGR } from './TerrainPalettes';

// ---------------------------------------------------------------------------
// Terrain Extrusion Renderer (two-pass displacement + gap interpolation)
//
// Pass 1: every source pixel is copied to its extruded screen position.
// Pass 2: empty gaps are filled by extending the surface pixel above with
//          progressive darkening (smooth slopes), not hard cliff-face textures.
// ---------------------------------------------------------------------------

// Snow line (lowered to compensate for pow(2.2) elevation reshaping)
const SNOW_LINE = 0.48;

// Maximum upward extrusion in pixels for the highest elevation
const MAX_EXTRUSION = 150;

// Snow palette (0xRRGGBB — packed to ABGR when written)
const SNOW_SHADOW    = 0xa0b8d0;
const SNOW_MID       = 0xc8d8e8;
const SNOW_BRIGHT    = 0xe0ecf4;
const SNOW_HIGHLIGHT = 0xf0f8ff;

// Minimum gap height (in pixels) to show a cliff face. Smaller gaps just
// darken the surface pixel above. Eliminates brown micro-lines on hills.
const CLIFF_GAP_THRESHOLD = 12;

// Cliff face palette for large drops
const CLIFF_WARM_DARK  = 0x5a3c28;
const CLIFF_WARM_MID   = 0x7a5438;
const CLIFF_WARM_LIGHT = 0x9a7048;

// Helper: pack a snow constant (0xRRGGBB) into ABGR with alpha=255
function packSnow(rgb: number): number {
  return applyBrightness(rgb, 1.0);
}

// ---------------------------------------------------------------------------
export class MountainRenderer {
  // Extrusion displacement map: for each source pixel index, the vertical
  // offset (in pixels) it was shifted upward.
  extrusionMap: Int16Array | null = null;
  // Resolution stored for animation remapping
  resolution = 0;

  render(
    pixels: Uint32Array,
    topo: TopographyGenerator,
    resolution: number,
    seed: number,
  ): void {
    const rngNoise = mulberry32(seed ^ 0x904e);
    const noise = createNoise2D(rngNoise);
    const N = resolution;
    this.resolution = N;
    const scale = topo.size / N;
    const { points, numRegions } = topo.mesh;

    // Build spatial grid for region lookup
    const cellSize = 40;
    const gridW = Math.ceil(topo.size / cellSize);
    const grid: number[][] = new Array(gridW * gridW);
    for (let i = 0; i < grid.length; i++) grid[i] = [];
    for (let r = 0; r < numRegions; r++) {
      const gx = Math.min(Math.floor(points[r].x / cellSize), gridW - 1);
      const gy = Math.min(Math.floor(points[r].y / cellSize), gridW - 1);
      if (gx >= 0 && gy >= 0) grid[gy * gridW + gx].push(r);
    }

    // Build per-pixel elevation grid
    const elevGrid = new Float32Array(N * N);
    for (let py = 0; py < N; py++) {
      for (let px = 0; px < N; px++) {
        const wx = (px + 0.5) * scale;
        const wy = (py + 0.5) * scale;
        const gx = Math.floor(wx / cellSize);
        const gyCur = Math.floor(wy / cellSize);
        let bestR = 0, bestD = Infinity;
        for (let dy = -2; dy <= 2; dy++) {
          const cy = gyCur + dy;
          if (cy < 0 || cy >= gridW) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const cx = gx + dx;
            if (cx < 0 || cx >= gridW) continue;
            for (const r of grid[cy * gridW + cx]) {
              const d = (points[r].x - wx) ** 2 + (points[r].y - wy) ** 2;
              if (d < bestD) { bestD = d; bestR = r; }
            }
          }
        }
        elevGrid[py * N + px] = topo.elevation[bestR];
      }
    }

    this._extrudeTerrain(pixels, elevGrid, N, noise);
  }

  // Remap a flat buffer index to its extruded screen index.
  // Returns -1 if off-screen.
  remapIndex(flatIdx: number): number {
    if (!this.extrusionMap) return flatIdx;
    const N = this.resolution;
    const x = flatIdx % N;
    const y = (flatIdx - x) / N;
    const screenY = y - this.extrusionMap[flatIdx];
    if (screenY < 0 || screenY >= N) return -1;
    return screenY * N + x;
  }

  // -----------------------------------------------------------------------
  private _extrudeTerrain(
    pixels: Uint32Array,
    elevGrid: Float32Array,
    N: number,
    noise: NoiseFunction2D,
  ): void {
    // Smooth elevation (7×7 box blur)
    const smoothElev = new Float32Array(N * N);
    const BLUR = 3;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let sum = 0, count = 0;
        for (let dy = -BLUR; dy <= BLUR; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= N) continue;
          for (let dx = -BLUR; dx <= BLUR; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= N) continue;
            sum += elevGrid[ny * N + nx];
            count++;
          }
        }
        smoothElev[y * N + x] = sum / count;
      }
    }

    // Pre-paint snow onto buffer (properly packed with alpha)
    for (let i = 0; i < N * N; i++) {
      if (smoothElev[i] >= SNOW_LINE) {
        const px = i % N, py = (i - px) / N;
        const n = noise(px * 0.15, py * 0.15);
        const snowVal = 0.7 + n * 0.2;
        if (snowVal > 0.85) pixels[i] = packSnow(SNOW_HIGHLIGHT);
        else if (snowVal > 0.7) pixels[i] = packSnow(SNOW_BRIGHT);
        else if (snowVal > 0.55) pixels[i] = packSnow(SNOW_MID);
        else pixels[i] = packSnow(SNOW_SHADOW);
      }
    }

    // Snapshot source pixels (includes snow), then clear output
    const srcPixels = new Uint32Array(pixels);
    pixels.fill(0);

    // Build extrusion map
    const extMap = new Int16Array(N * N);
    for (let i = 0; i < N * N; i++) {
      extMap[i] = Math.floor(smoothElev[i] * smoothElev[i] * MAX_EXTRUSION);
    }
    this.extrusionMap = extMap;

    // --- Pass 1: Displacement ---
    // Copy every source pixel to its extruded screen position.
    // North→south so southern (front) pixels overwrite northern.
    for (let x = 0; x < N; x++) {
      for (let y = 0; y < N; y++) {
        const idx = y * N + x;
        const screenY = y - extMap[idx];
        if (screenY < 0 || screenY >= N) continue;

        const elev = smoothElev[idx];
        const sidx = screenY * N + x;

        // Slope-based directional lighting
        const eL = x > 0 ? smoothElev[idx - 1] : elev;
        const eR = x < N - 1 ? smoothElev[idx + 1] : elev;
        const eU = y > 0 ? smoothElev[idx - N] : elev;
        const eD = y < N - 1 ? smoothElev[idx + N] : elev;
        const lightDot = (eR - eL) * 80 * -0.707 + (eD - eU) * 80 * -0.707;
        const surfaceLight = 0.7 + lightDot * 0.5;
        const light = Math.max(0.5, Math.min(1.2, surfaceLight));

        if (elev >= SNOW_LINE) {
          const n = noise(x * 0.15, y * 0.15);
          const snowLight = light + n * 0.15;
          if (snowLight > 1.05) pixels[sidx] = packSnow(SNOW_HIGHLIGHT);
          else if (snowLight > 0.85) pixels[sidx] = packSnow(SNOW_BRIGHT);
          else if (snowLight > 0.65) pixels[sidx] = packSnow(SNOW_MID);
          else pixels[sidx] = packSnow(SNOW_SHADOW);
        } else {
          const origPixel = srcPixels[idx];
          const r = (origPixel) & 0xff;
          const g = (origPixel >> 8) & 0xff;
          const b = (origPixel >> 16) & 0xff;
          pixels[sidx] = packABGR(
            Math.min(255, Math.floor(r * light)),
            Math.min(255, Math.floor(g * light)),
            Math.min(255, Math.floor(b * light)),
          );
        }
      }
    }

    // --- Pass 2: Interpolate gaps ---
    // Scan each column top→bottom. Empty pixels below a surface pixel are
    // filled by extending the surface above with progressive darkening.
    // For large gaps (steep cliffs), use cliff-face coloring below a threshold.
    for (let x = 0; x < N; x++) {
      let lastColor = 0;
      let lastElev = 0;
      let gapStart = -1;

      for (let sy = 0; sy < N; sy++) {
        const sidx = sy * N + x;
        if (pixels[sidx] !== 0) {
          // Surface pixel found — fill any gap above
          if (gapStart >= 0 && lastColor !== 0) {
            this._fillGap(pixels, x, gapStart, sy, lastColor, lastElev, N, noise);
          }
          lastColor = pixels[sidx];
          lastElev = smoothElev[sy * N + x] || lastElev;
          gapStart = -1;
        } else if (lastColor !== 0) {
          if (gapStart < 0) gapStart = sy;
        }
      }
      // Trailing gap at bottom
      if (gapStart >= 0 && lastColor !== 0) {
        this._fillGap(pixels, x, gapStart, N, lastColor, lastElev, N, noise);
      }
    }
  }

  // Fill a vertical gap in a column by extending the surface above.
  // Small gaps: darken the surface color progressively.
  // Large gaps: use cliff-face material for the lower portion.
  private _fillGap(
    pixels: Uint32Array,
    x: number,
    gapTop: number,
    gapBot: number,
    surfaceColor: number,
    elev: number,
    N: number,
    noise: NoiseFunction2D,
  ): void {
    const gapHeight = gapBot - gapTop;

    // Unpack the surface color (ABGR)
    const sr = (surfaceColor) & 0xff;
    const sg = (surfaceColor >> 8) & 0xff;
    const sb = (surfaceColor >> 16) & 0xff;

    for (let gy = gapTop; gy < gapBot; gy++) {
      const t = (gy - gapTop) / Math.max(1, gapHeight); // 0=top, 1=bottom

      if (gapHeight >= CLIFF_GAP_THRESHOLD && t > 0.3) {
        // Large gap: cliff face material for the lower 70%
        const cliffT = (t - 0.3) / 0.7;
        let light = 0.7 - cliffT * 0.15;
        light = Math.floor(light * 6) / 6;
        const n = noise(x * 0.18, gy * 0.18);
        let rgb: number;
        if (elev >= SNOW_LINE) {
          rgb = n > 0.2 ? CLIFF_WARM_LIGHT : n > -0.2 ? 0x787078 : 0x585060;
        } else {
          rgb = n > 0.2 ? CLIFF_WARM_LIGHT : n > -0.2 ? CLIFF_WARM_MID : CLIFF_WARM_DARK;
        }
        pixels[gy * N + x] = applyBrightness(rgb, light);
      } else {
        // Small gap or top portion: darken the surface color
        const darken = 1.0 - t * 0.35;
        pixels[gy * N + x] = packABGR(
          Math.max(0, Math.floor(sr * darken)),
          Math.max(0, Math.floor(sg * darken)),
          Math.max(0, Math.floor(sb * darken)),
        );
      }
    }
  }
}
