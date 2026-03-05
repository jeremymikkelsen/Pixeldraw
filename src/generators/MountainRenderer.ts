import { createNoise2D, type NoiseFunction2D } from 'simplex-noise';
import { TopographyGenerator, mulberry32 } from './TopographyGenerator';
import { applyBrightness } from './TerrainPalettes';

// ---------------------------------------------------------------------------
// Mountain rendering — voxel-space column extrusion for massive 3D forms
//
// Instead of placing discrete peak objects, we extrude every high-elevation
// pixel upward proportional to its elevation. This creates continuous mountain
// masses that naturally fill the entire high-elevation region. Processing
// columns back-to-front (north to south) gives correct occlusion.
// ---------------------------------------------------------------------------

// Elevation thresholds
const MOUNTAIN_START = 0.42;  // foothills begin
const SNOW_LINE = 0.61;       // snow coverage begins
const CRAG_MIN_ELEV = 0.45;

// Maximum upward extrusion in pixels for the highest elevation
const MAX_EXTRUSION = 100;

// ---- Rock palette: warm brown/orange tones ----
const ROCK_WARM_DARK   = 0x5a3c28;
const ROCK_WARM_MID    = 0x7a5438;
const ROCK_WARM_LIGHT  = 0x9a7048;
const ROCK_WARM_HOT    = 0xb08050;

const ROCK_COOL_DARK   = 0x3a3840;
const ROCK_COOL_MID    = 0x585060;
const ROCK_COOL_LIGHT  = 0x787078;

// ---- Snow palette ----
const SNOW_DEEP_SHADOW = 0x8098b8;
const SNOW_SHADOW      = 0xa0b8d0;
const SNOW_MID         = 0xc8d8e8;
const SNOW_BRIGHT      = 0xe0ecf4;
const SNOW_HIGHLIGHT   = 0xf0f8ff;

// ---- Crag palette ----
const CRAG_DARK      = 0x585040;
const CRAG_MID       = 0x706850;
const CRAG_LIGHT     = 0x888068;
const CRAG_HIGHLIGHT = 0xa09880;

// ---------------------------------------------------------------------------
// MountainRenderer
// ---------------------------------------------------------------------------
export class MountainRenderer {

  render(
    pixels: Uint32Array,
    topo: TopographyGenerator,
    resolution: number,
    seed: number,
  ): void {
    const rng = mulberry32(seed ^ 0x70c4);
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

    // 1. Rocky crags at high elevation (below snow line)
    this._renderCrags(pixels, elevGrid, N, rng, noise);

    // 2. Voxel-space column extrusion for mountain masses
    this._renderMountainMass(pixels, elevGrid, N, noise, noise2);
  }

  // -----------------------------------------------------------------------
  // Voxel-space column extrusion — the core mountain rendering
  //
  // For each column (x), we scan from the back (north, y=0) to front
  // (south, y=N-1). For each terrain pixel, we compute how high it should
  // extrude upward. We draw vertical fill from the terrain surface up to
  // the extruded top. A "horizon" tracker ensures back pixels are occluded
  // by front pixels (painter's algorithm per-column).
  // -----------------------------------------------------------------------
  private _renderMountainMass(
    pixels: Uint32Array,
    elevGrid: Float32Array,
    N: number,
    noise: NoiseFunction2D,
    noise2: NoiseFunction2D,
  ): void {
    // Pre-compute smoothed elevation for gentler slopes
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

    // Process each column independently
    for (let x = 0; x < N; x++) {
      // Horizon line: the highest (lowest screen-y) pixel drawn so far
      // Start at bottom of screen
      let horizon = N;

      // Scan from back (north) to front (south)
      for (let y = 0; y < N; y++) {
        const elev = smoothElev[y * N + x];
        if (elev < MOUNTAIN_START) continue;

        // Extrusion height: nonlinear for dramatic peaks
        const t = (elev - MOUNTAIN_START) / (1 - MOUNTAIN_START);
        const extrusion = Math.floor(t * t * MAX_EXTRUSION);
        if (extrusion < 2) continue;

        // Screen position of the top of the extruded column
        const screenTop = y - extrusion;

        // Only draw if this column extends above the current horizon
        if (screenTop >= horizon) continue;

        // The visible portion is from screenTop to horizon-1
        const drawFrom = Math.max(0, screenTop);
        const drawTo = Math.min(N - 1, horizon - 1);

        // Slope for lighting (from elevation neighbors)
        const eL = x > 0 ? smoothElev[y * N + x - 1] : elev;
        const eR = x < N - 1 ? smoothElev[y * N + x + 1] : elev;
        const eU = y > 0 ? smoothElev[(y - 1) * N + x] : elev;
        const eD = y < N - 1 ? smoothElev[(y + 1) * N + x] : elev;
        const slopeX = (eR - eL) * 0.5;
        const slopeY = (eD - eU) * 0.5;

        // Directional lighting (upper-left, -0.707, -0.707)
        const lightDot = slopeX * -0.707 + slopeY * -0.707;
        const baseLight = 0.55 + lightDot * 6.0;

        for (let sy = drawFrom; sy <= drawTo; sy++) {
          // Position within the extruded column (0=top, 1=base)
          const colT = extrusion > 0 ? (sy - screenTop) / extrusion : 0;

          // Pixels near the top of the column are the mountain surface;
          // pixels further down are the cliff face visible in 3/4 view
          const isSurface = colT < 0.15;
          const isCliffFace = colT >= 0.15;

          // Light varies: surface gets terrain-based light,
          // cliff face gets darkened based on depth
          let light: number;
          if (isSurface) {
            light = Math.max(0.25, Math.min(1.15, baseLight));
          } else {
            // Cliff face: darker toward bottom, with some lateral variation
            const cliffLight = baseLight * (1.0 - colT * 0.5);
            light = Math.max(0.2, Math.min(1.0, cliffLight));
          }

          // Quantize for pixel-art feel
          light = Math.floor(light * 5) / 5;

          // ---- Material selection ----
          const isAboveSnowLine = elev >= SNOW_LINE;
          const n1 = noise(x * 0.1, sy * 0.1);
          const n2 = noise2(x * 0.2 + sy * 0.15, sy * 0.2 - x * 0.1);

          let rgb: number;

          if (isAboveSnowLine && isSurface) {
            // Snow on surface of high peaks
            if (light > 0.9) rgb = SNOW_HIGHLIGHT;
            else if (light > 0.7) rgb = SNOW_BRIGHT;
            else if (light > 0.5) rgb = SNOW_MID;
            else if (light > 0.3) rgb = SNOW_SHADOW;
            else rgb = SNOW_DEEP_SHADOW;
          } else if (isAboveSnowLine && isCliffFace) {
            // High-altitude cliff face: mix of snow patches and rock
            const snowPatch = n1 > -0.1 + colT * 0.8;
            if (snowPatch) {
              if (light > 0.7) rgb = SNOW_BRIGHT;
              else if (light > 0.4) rgb = SNOW_MID;
              else rgb = SNOW_SHADOW;
            } else {
              // Exposed rock on cliff face
              if (n2 > 0.2) {
                rgb = light > 0.5 ? ROCK_WARM_HOT : ROCK_WARM_LIGHT;
              } else if (n2 > -0.2) {
                rgb = light > 0.5 ? ROCK_WARM_LIGHT : ROCK_WARM_MID;
              } else {
                rgb = light > 0.4 ? ROCK_WARM_MID : ROCK_WARM_DARK;
              }
            }
          } else if (isSurface) {
            // Lower mountain surface (below snow line): rock
            if (n2 > 0.2) {
              rgb = light > 0.6 ? ROCK_WARM_HOT : ROCK_WARM_LIGHT;
            } else if (n2 > -0.2) {
              rgb = light > 0.5 ? ROCK_WARM_LIGHT : ROCK_WARM_MID;
            } else {
              rgb = light > 0.4 ? ROCK_WARM_MID : ROCK_WARM_DARK;
            }
          } else {
            // Lower cliff face: cool shadow tones
            if (n2 > 0.3) {
              rgb = light > 0.5 ? ROCK_COOL_LIGHT : ROCK_COOL_MID;
            } else {
              rgb = light > 0.4 ? ROCK_COOL_MID : ROCK_COOL_DARK;
            }
          }

          // Slight edge highlight at the very top of visible column
          if (sy === drawFrom && isSurface) {
            light = Math.min(1.2, light + 0.15);
          }

          pixels[sy * N + x] = applyBrightness(rgb, light);
        }

        // Update horizon
        horizon = Math.min(horizon, drawFrom);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Rocky crags at high elevation (below snow line)
  // -----------------------------------------------------------------------
  private _renderCrags(
    pixels: Uint32Array,
    elevGrid: Float32Array,
    N: number,
    rng: () => number,
    noise: NoiseFunction2D,
  ): void {
    const step = 8;
    const CRAG_DENSITY = 0.003;

    for (let py = step; py < N - step; py += step) {
      for (let px = step; px < N - step; px += step) {
        const elev = elevGrid[py * N + px];
        if (elev < CRAG_MIN_ELEV || elev >= SNOW_LINE) continue;

        const chance = CRAG_DENSITY * ((elev - CRAG_MIN_ELEV) / (SNOW_LINE - CRAG_MIN_ELEV));
        if (rng() > chance) continue;

        const cragW = 3 + Math.floor(rng() * 6);
        const cragH = 4 + Math.floor(rng() * 6);
        this._renderCrag(pixels, px, py, cragW, cragH, N, rng, noise);
      }
    }
  }

  private _renderCrag(
    pixels: Uint32Array,
    cx: number,
    cy: number,
    width: number,
    height: number,
    N: number,
    rng: () => number,
    noise: NoiseFunction2D,
  ): void {
    for (let dy = -height; dy <= 0; dy++) {
      const t = 1 - (-dy / height);
      const rowHW = Math.max(1, Math.floor(width * t / 2));
      const edgeNoise = noise(cx * 0.15 + dy * 0.3, cy * 0.15) * 1.5;
      const adjustedHW = Math.max(1, rowHW + Math.floor(edgeNoise));

      for (let dx = -adjustedHW; dx <= adjustedHW; dx++) {
        const px = cx + dx;
        const py = cy + dy;
        if (px < 0 || px >= N || py < 0 || py >= N) continue;

        const relX = adjustedHW > 0 ? dx / adjustedHW : 0;
        const light = 0.55 + relX * -0.707 * 0.5 + (t - 0.5) * -0.707 * 0.4;
        const lightClamped = Math.max(0.3, Math.min(1.0, light));

        const n = noise(px * 0.2, py * 0.2);
        let rgb: number;
        if (n > 0.3) rgb = CRAG_HIGHLIGHT;
        else if (n > 0) rgb = CRAG_LIGHT;
        else if (n > -0.3) rgb = CRAG_MID;
        else rgb = CRAG_DARK;

        pixels[py * N + px] = applyBrightness(rgb, lightClamped);
      }
    }
  }
}
