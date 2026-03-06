import { createNoise2D, type NoiseFunction2D } from 'simplex-noise';
import { TopographyGenerator, mulberry32 } from './TopographyGenerator';
import { applyBrightness, packABGR } from './TerrainPalettes';

// ---------------------------------------------------------------------------
// Terrain Extrusion Renderer (Comanche-style voxel column extrusion)
//
// Applies faux-3D height extrusion to the ENTIRE map. Runs as a post-
// processing pass after all other renderers (ground, coast, rivers, trees).
//
// For each screen column (x), scans front-to-back (south→north). Each
// terrain pixel is shifted upward proportional to its elevation. Surface
// pixels preserve their original rendered colors; cliff faces get filled
// with terrain-appropriate colors.
// ---------------------------------------------------------------------------

// Snow line for cliff face material (lowered to compensate for pow(2.2)
// elevation reshaping in TopographyGenerator — 0.8^2.2 ≈ 0.62)
const SNOW_LINE = 0.48;

// Maximum upward extrusion in pixels for the highest elevation
const MAX_EXTRUSION = 150;

// Minimum extrusion to bother rendering (skip very low terrain)
const MIN_EXTRUSION = 1;

// ---- Cliff face palettes by elevation zone ----

// Low elevation cliff (coast/lowland): earthy green-brown
const CLIFF_LOW_DARK   = 0x4a5838;  // dark mossy
const CLIFF_LOW_MID    = 0x5a6840;  // earth green
const CLIFF_LOW_LIGHT  = 0x6a7848;  // light earthy

// Mid elevation cliff (highland): warm brown earth
const CLIFF_MID_DARK   = 0x5a4830;  // dark brown
const CLIFF_MID_MID    = 0x7a6040;  // brown
const CLIFF_MID_LIGHT  = 0x8a7050;  // tan

// High elevation cliff (rock zone): warm rock
const CLIFF_HIGH_DARK  = 0x5a3c28;  // deep brown rock
const CLIFF_HIGH_MID   = 0x7a5438;  // brown rock
const CLIFF_HIGH_LIGHT = 0x9a7048;  // warm tan rock
const CLIFF_HIGH_HOT   = 0xb08050;  // orange-brown highlight

// Snow zone cliff: cool rock + snow patches
const CLIFF_SNOW_ROCK_DARK  = 0x585060;  // cool gray
const CLIFF_SNOW_ROCK_MID   = 0x787078;  // mid gray
const CLIFF_SNOW_ROCK_LIGHT = 0x989090;  // light gray

const SNOW_SHADOW    = 0xa0b8d0;
const SNOW_MID       = 0xc8d8e8;
const SNOW_BRIGHT    = 0xe0ecf4;
const SNOW_HIGHLIGHT = 0xf0f8ff;

// ---------------------------------------------------------------------------
// MountainRenderer (full-map terrain extrusion)
// ---------------------------------------------------------------------------
export class MountainRenderer {

  render(
    pixels: Uint32Array,
    topo: TopographyGenerator,
    resolution: number,
    seed: number,
  ): void {
    const rngNoise = mulberry32(seed ^ 0x904e);
    const noise = createNoise2D(rngNoise);
    const rngNoise2 = mulberry32(seed ^ 0x1234);
    const noise2 = createNoise2D(rngNoise2);
    const N = resolution;
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

    // Apply full-map terrain extrusion
    this._extrudeTerrain(pixels, elevGrid, N, noise, noise2);
  }

  // -----------------------------------------------------------------------
  // Full-map voxel column extrusion
  // -----------------------------------------------------------------------
  private _extrudeTerrain(
    pixels: Uint32Array,
    elevGrid: Float32Array,
    N: number,
    noise: NoiseFunction2D,
    noise2: NoiseFunction2D,
  ): void {
    // Smooth elevation for gentle slopes (avoids jagged extrusion edges)
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

    // Snapshot the current pixel buffer (preserves ground, trees, rivers)
    const srcPixels = new Uint32Array(pixels);

    // Clear entire buffer — every pixel will be redrawn at its extruded
    // position. Background is dark navy (visible where terrain doesn't reach).
    const BG_FILL = packABGR(12, 18, 40);
    pixels.fill(BG_FILL);

    // Process each column independently
    for (let x = 0; x < N; x++) {
      let horizon = N; // nothing drawn yet

      // Scan FRONT to BACK: south (y=N-1) → north (y=0)
      for (let y = N - 1; y >= 0; y--) {
        const elev = smoothElev[y * N + x];

        // Extrusion height: t² curve (ocean barely rises, peaks dramatic)
        const extrusion = Math.floor(elev * elev * MAX_EXTRUSION);
        if (extrusion < MIN_EXTRUSION) {
          // No extrusion — just copy original pixel in place
          pixels[y * N + x] = srcPixels[y * N + x];
          continue;
        }

        // Screen position of the extruded top
        const screenTop = y - extrusion;

        // Only draw what peeks above current horizon
        if (screenTop >= horizon) continue;

        const drawFrom = Math.max(0, screenTop);
        const drawTo = Math.min(N - 1, horizon - 1);

        // Slope for directional lighting
        const eL = x > 0 ? smoothElev[y * N + x - 1] : elev;
        const eR = x < N - 1 ? smoothElev[y * N + x + 1] : elev;
        const eU = y > 0 ? smoothElev[(y - 1) * N + x] : elev;
        const eD = y < N - 1 ? smoothElev[(y + 1) * N + x] : elev;

        // Scale slopes heavily (elevation deltas ~0.01 between neighbors)
        const slopeX = (eR - eL) * 80;
        const slopeY = (eD - eU) * 80;
        const lightDot = slopeX * -0.707 + slopeY * -0.707;

        for (let sy = drawFrom; sy <= drawTo; sy++) {
          const colT = extrusion > 0 ? (sy - screenTop) / extrusion : 0;

          // Surface pixels (top ~15%): preserve original rendered colors
          // with slope-based brightness adjustment. Snow replaces surface
          // colors above the snow line.
          if (colT < 0.15) {
            const surfaceLight = 0.7 + lightDot * 0.5;
            const light = Math.max(0.5, Math.min(1.2, surfaceLight));

            if (elev >= SNOW_LINE) {
              // Snow surface: multi-shaded snow based on lighting + noise
              const n = noise(x * 0.15, y * 0.15);
              const snowLight = light + n * 0.15;
              let snowRGB: number;
              if (snowLight > 1.05) snowRGB = SNOW_HIGHLIGHT;
              else if (snowLight > 0.85) snowRGB = SNOW_BRIGHT;
              else if (snowLight > 0.65) snowRGB = SNOW_MID;
              else snowRGB = SNOW_SHADOW;
              pixels[sy * N + x] = snowRGB;
            } else {
              // Normal terrain: apply lighting to the original pixel color
              const origPixel = srcPixels[y * N + x];
              const r = (origPixel) & 0xff;
              const g = (origPixel >> 8) & 0xff;
              const b = (origPixel >> 16) & 0xff;
              const lr = Math.min(255, Math.floor(r * light));
              const lg = Math.min(255, Math.floor(g * light));
              const lb = Math.min(255, Math.floor(b * light));
              pixels[sy * N + x] = packABGR(lr, lg, lb);
            }
          } else {
            // Cliff face: terrain-appropriate colors
            // Light: bright at top, gradually darker toward base, never black
            const cliffBase = 0.75 - colT * 0.2; // 0.75 at top → 0.55 at base
            const lateralLight = lightDot * 0.25;
            let light = cliffBase + lateralLight;
            light = Math.max(0.5, Math.min(1.1, light));
            // Quantize for pixel-art feel
            light = Math.floor(light * 6) / 6;

            const rgb = this._cliffColor(elev, colT, light, x, sy, noise, noise2);
            pixels[sy * N + x] = applyBrightness(rgb, light);
          }
        }

        horizon = Math.min(horizon, drawFrom);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Cliff face color by elevation zone
  // -----------------------------------------------------------------------
  private _cliffColor(
    elev: number,
    colT: number,
    light: number,
    x: number,
    y: number,
    noise: NoiseFunction2D,
    noise2: NoiseFunction2D,
  ): number {
    const n1 = noise(x * 0.12, y * 0.12);
    const n2 = noise2(x * 0.18 + y * 0.12, y * 0.18 - x * 0.08);

    if (elev >= SNOW_LINE) {
      // Snow zone: snow patches on upper cliff, exposed rock on lower
      const snowPatch = n1 > -0.2 + colT * 0.9;
      if (snowPatch) {
        if (light > 0.85) return SNOW_HIGHLIGHT;
        if (light > 0.7) return SNOW_BRIGHT;
        if (light > 0.55) return SNOW_MID;
        return SNOW_SHADOW;
      }
      // Exposed rock between snow patches
      if (n2 > 0.2) return CLIFF_HIGH_HOT;
      if (n2 > -0.1) return CLIFF_HIGH_LIGHT;
      if (n2 > -0.3) return CLIFF_SNOW_ROCK_MID;
      return CLIFF_SNOW_ROCK_DARK;
    }

    if (elev >= 0.45) {
      // Rock/high zone: warm brown rock faces
      if (n2 > 0.3) return CLIFF_HIGH_HOT;
      if (n2 > 0.0) return CLIFF_HIGH_LIGHT;
      if (n2 > -0.3) return CLIFF_HIGH_MID;
      return CLIFF_HIGH_DARK;
    }

    if (elev >= 0.25) {
      // Highland: brown earth
      if (n2 > 0.3) return CLIFF_MID_LIGHT;
      if (n2 > -0.2) return CLIFF_MID_MID;
      return CLIFF_MID_DARK;
    }

    // Lowland/coast: earthy green-brown
    if (n2 > 0.3) return CLIFF_LOW_LIGHT;
    if (n2 > -0.2) return CLIFF_LOW_MID;
    return CLIFF_LOW_DARK;
  }
}
