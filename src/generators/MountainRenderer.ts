import { createNoise2D, type NoiseFunction2D } from 'simplex-noise';
import { TopographyGenerator, mulberry32 } from './TopographyGenerator';
import { applyBrightness, packABGR } from './TerrainPalettes';
import { Season } from '../state/Season';

// ---------------------------------------------------------------------------
// Terrain Extrusion Renderer (two-pass displacement + gap interpolation)
//
// Pass 1: every source pixel is copied to its extruded screen position.
// Pass 2: empty gaps are filled — small gaps darken surface above, large
//          gaps show rock cliff-face material.
// ---------------------------------------------------------------------------

// Default snow/rock lines (summer) — shifted by season
const SNOW_LINE_DEFAULT = 0.62;
const ROCK_LINE_DEFAULT = 0.48;

// Season-dependent snow/rock line offsets
function getSnowLine(season: Season): number {
  switch (season) {
    case Season.Winter: return 0.38;  // snow much lower
    case Season.Spring: return 0.52;  // snow retreating
    case Season.Fall:   return 0.80;  // minimal snow — late dry season
    default:            return SNOW_LINE_DEFAULT;
  }
}

function getRockLine(season: Season): number {
  switch (season) {
    case Season.Winter: return 0;     // no exposed rock in winter — all snow
    case Season.Spring: return 0.42;
    case Season.Fall:   return 0.52;  // more exposed rock, less snow
    default:            return ROCK_LINE_DEFAULT;
  }
}

// Maximum upward extrusion in pixels for the highest elevation
const MAX_EXTRUSION = 150;

// Snow palette (0xRRGGBB — packed to ABGR when written)
const SNOW_SHADOW    = 0xa0b8d0;
const SNOW_MID       = 0xc8d8e8;
const SNOW_BRIGHT    = 0xe0ecf4;
const SNOW_HIGHLIGHT = 0xf0f8ff;

// Rock surface palette (exposed stone between treeline and snow)
const ROCK_DARK   = 0x5a4838;
const ROCK_MID    = 0x7a6048;
const ROCK_LIGHT  = 0x8a7258;
const ROCK_WARM   = 0x9a7850;

// Minimum gap height (in pixels) to show cliff-face rock material.
// Smaller gaps just darken the surface pixel above.
const CLIFF_GAP_THRESHOLD = 6;

// Cliff face palette for large drops
const CLIFF_DARK   = 0x4a3828;
const CLIFF_MID    = 0x6a5038;
const CLIFF_LIGHT  = 0x8a6848;
const CLIFF_HOT    = 0xa07850;

// Cool gray rock for snow-zone cliffs
const CLIFF_SNOW_DARK  = 0x585060;
const CLIFF_SNOW_MID   = 0x787078;
const CLIFF_SNOW_LIGHT = 0x989090;

// Helper: pack a snow constant (0xRRGGBB) into ABGR with alpha=255
function packSnow(rgb: number): number {
  return applyBrightness(rgb, 1.0);
}

// ---------------------------------------------------------------------------
export class MountainRenderer {
  extrusionMap: Int16Array | null = null;
  // Inverse map: for each screen pixel, which source flat index was mapped there.
  // -1 means no source (gap-fill or empty).
  screenToSource: Int32Array | null = null;
  resolution = 0;

  private _snowLine = SNOW_LINE_DEFAULT;
  private _rockLine = ROCK_LINE_DEFAULT;
  private _season: Season = Season.Summer;

  render(
    pixels: Uint32Array,
    topo: TopographyGenerator,
    resolution: number,
    seed: number,
    treeMask?: Uint8Array,
    season: Season = Season.Summer,
  ): void {
    this._snowLine = getSnowLine(season);
    this._rockLine = getRockLine(season);
    this._season = season;
    const rngNoise = mulberry32(seed ^ 0x904e);
    const noise = createNoise2D(rngNoise);
    const rngNoise2 = mulberry32(seed ^ 0x1234);
    const noise2 = createNoise2D(rngNoise2);
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

    this._extrudeTerrain(pixels, elevGrid, N, noise, noise2, treeMask);
  }

  // -----------------------------------------------------------------------
  private _extrudeTerrain(
    pixels: Uint32Array,
    elevGrid: Float32Array,
    N: number,
    noise: NoiseFunction2D,
    noise2: NoiseFunction2D,
    treeMask?: Uint8Array,
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

    // Pre-paint snow and rock onto buffer — but SKIP tree pixels
    for (let i = 0; i < N * N; i++) {
      const elev = smoothElev[i];
      // Don't paint over trees
      if (treeMask && treeMask[i]) continue;

      if (elev >= this._snowLine) {
        // Snow: only the highest peaks
        const px = i % N, py = (i - px) / N;
        const n = noise(px * 0.15, py * 0.15);
        const snowVal = 0.7 + n * 0.2;
        if (snowVal > 0.85) pixels[i] = packSnow(SNOW_HIGHLIGHT);
        else if (snowVal > 0.7) pixels[i] = packSnow(SNOW_BRIGHT);
        else if (snowVal > 0.55) pixels[i] = packSnow(SNOW_MID);
        else pixels[i] = packSnow(SNOW_SHADOW);
      } else if (elev >= this._rockLine) {
        // Exposed rock between treeline and snow
        const px = i % N, py = (i - px) / N;
        const n = noise2(px * 0.12, py * 0.12);
        const n2 = noise(px * 0.08, py * 0.08);
        if (this._season === Season.Winter) {
          // Winter: snow covers everything above rock line (which is 0)
          // Use snow palette instead of brown rock
          const snowVal = 0.6 + n * 0.2;
          if (snowVal > 0.75) pixels[i] = packSnow(SNOW_MID);
          else if (snowVal > 0.55) pixels[i] = packSnow(SNOW_SHADOW);
          else pixels[i] = packSnow(SNOW_SHADOW);
        } else {
          // Mix snow patches into upper rock zone
          const snowChance = (elev - this._rockLine) / (this._snowLine - this._rockLine);
          if (n2 > 0.3 && snowChance > 0.6) {
            pixels[i] = packSnow(SNOW_SHADOW);
          } else {
            let rgb: number;
            if (n > 0.3) rgb = ROCK_WARM;
            else if (n > 0.0) rgb = ROCK_LIGHT;
            else if (n > -0.3) rgb = ROCK_MID;
            else rgb = ROCK_DARK;
            pixels[i] = applyBrightness(rgb, 1.0);
          }
        }
      }
    }

    // Snapshot source pixels (includes snow/rock/trees), then clear output
    const srcPixels = new Uint32Array(pixels);
    pixels.fill(0);

    // Build extrusion map
    const extMap = new Int16Array(N * N);
    for (let i = 0; i < N * N; i++) {
      extMap[i] = Math.floor(smoothElev[i] * smoothElev[i] * MAX_EXTRUSION);
    }
    this.extrusionMap = extMap;

    // Screen-to-source inverse map
    const s2s = new Int32Array(N * N).fill(-1);

    // --- Pass 1: Displacement ---
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
        const slopeX = (eR - eL) * 80;
        const slopeY = (eD - eU) * 80;
        const lightDot = slopeX * -0.707 + slopeY * -0.707;

        // Stronger shadow range for back-facing slopes
        const surfaceLight = 0.65 + lightDot * 0.6;
        const light = Math.max(0.35, Math.min(1.3, surfaceLight));

        if (elev >= this._snowLine && !(treeMask && treeMask[idx])) {
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
        s2s[sidx] = idx;
      }
    }

    this.screenToSource = s2s;

    // --- Pass 2: Interpolate gaps ---
    for (let x = 0; x < N; x++) {
      let lastColor = 0;
      let lastElev = 0;
      let lastSourceIdx = -1;
      let gapStart = -1;

      for (let sy = 0; sy < N; sy++) {
        const sidx = sy * N + x;
        if (pixels[sidx] !== 0) {
          if (gapStart >= 0 && lastColor !== 0) {
            this._fillGap(pixels, s2s, x, gapStart, sy, lastColor, lastElev,
              lastSourceIdx, N, noise, noise2);
          }
          lastColor = pixels[sidx];
          const srcIdx = s2s[sidx];
          if (srcIdx >= 0) {
            lastElev = smoothElev[srcIdx];
            lastSourceIdx = srcIdx;
          }
          gapStart = -1;
        } else if (lastColor !== 0) {
          if (gapStart < 0) gapStart = sy;
        }
      }
      if (gapStart >= 0 && lastColor !== 0) {
        this._fillGap(pixels, s2s, x, gapStart, N, lastColor, lastElev,
          lastSourceIdx, N, noise, noise2);
      }
    }
  }

  // Fill a vertical gap in a column.
  // Small gaps: darken the surface color (gentle slope).
  // Large gaps: rock cliff-face material.
  private _fillGap(
    pixels: Uint32Array,
    s2s: Int32Array,
    x: number,
    gapTop: number,
    gapBot: number,
    surfaceColor: number,
    elev: number,
    sourceIdx: number,
    N: number,
    noise: NoiseFunction2D,
    noise2: NoiseFunction2D,
  ): void {
    const gapHeight = gapBot - gapTop;

    // Unpack the surface color (ABGR)
    const sr = (surfaceColor) & 0xff;
    const sg = (surfaceColor >> 8) & 0xff;
    const sb = (surfaceColor >> 16) & 0xff;

    for (let gy = gapTop; gy < gapBot; gy++) {
      const t = (gy - gapTop) / Math.max(1, gapHeight);
      const gidx = gy * N + x;

      // Propagate source index for hover lookup
      if (sourceIdx >= 0) s2s[gidx] = sourceIdx;

      if (gapHeight >= CLIFF_GAP_THRESHOLD && t > 0.25) {
        // Rock cliff face for the lower 75%
        const cliffT = (t - 0.25) / 0.75;
        let light = 0.65 - cliffT * 0.2;
        light = Math.floor(light * 6) / 6;
        const n = noise(x * 0.18, gy * 0.18);
        const n2 = noise2(x * 0.12, gy * 0.12);
        let rgb: number;
        if (elev >= this._snowLine) {
          // Snow-zone cliff: cool gray rock with occasional snow
          if (n2 > 0.4 && cliffT < 0.3) rgb = SNOW_MID;
          else if (n > 0.2) rgb = CLIFF_SNOW_LIGHT;
          else if (n > -0.2) rgb = CLIFF_SNOW_MID;
          else rgb = CLIFF_SNOW_DARK;
        } else if (this._season === Season.Winter) {
          // Winter: snow-covered cliff faces everywhere below snow line
          if (n2 > 0.3 && cliffT < 0.4) rgb = SNOW_SHADOW;
          else if (n > 0.2) rgb = CLIFF_SNOW_LIGHT;
          else if (n > -0.2) rgb = CLIFF_SNOW_MID;
          else rgb = CLIFF_SNOW_DARK;
        } else if (elev >= this._rockLine) {
          // Rock zone: warm brown stone
          if (n2 > 0.3) rgb = CLIFF_HOT;
          else if (n > 0.1) rgb = CLIFF_LIGHT;
          else if (n > -0.2) rgb = CLIFF_MID;
          else rgb = CLIFF_DARK;
        } else {
          // Lower elevation
          if (n > 0.2) rgb = CLIFF_LIGHT;
          else if (n > -0.2) rgb = CLIFF_MID;
          else rgb = CLIFF_DARK;
        }
        pixels[gidx] = applyBrightness(rgb, light);
      } else {
        // Small gap or top portion: darken the surface color
        const darken = 1.0 - t * 0.4;
        pixels[gidx] = packABGR(
          Math.max(0, Math.floor(sr * darken)),
          Math.max(0, Math.floor(sg * darken)),
          Math.max(0, Math.floor(sb * darken)),
        );
      }
    }
  }
}
