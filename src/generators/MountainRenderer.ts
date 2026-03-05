import { createNoise2D } from 'simplex-noise';
import { TopographyGenerator, mulberry32 } from './TopographyGenerator';
import { packABGR, applyBrightness } from './TerrainPalettes';

// ---------------------------------------------------------------------------
// Mountain peak rendering — 3/4 isometric projection above snow line
// ---------------------------------------------------------------------------

// Snow line threshold (matches TreeRenderer)
const SNOW_LINE = 0.61;
const CRAG_MIN_ELEV = 0.45;

// Mountain color zones (RGB hex)
const ROCK_FACE_DARK = 0x504840;
const ROCK_FACE_MID = 0x686058;
const ROCK_FACE_LIGHT = 0x807870;
const ROCK_STRIATION_DARK = 0x585048;
const ROCK_STRIATION_LIGHT = 0x908878;

const SNOW_SHADOW = 0xb8c8d8;
const SNOW_MID = 0xd0dce8;
const SNOW_BRIGHT = 0xe8f0f8;
const SNOW_HIGHLIGHT = 0xf8fcff;

const CRAG_DARK = 0x605848;
const CRAG_MID = 0x787060;
const CRAG_LIGHT = 0x908878;
const CRAG_HIGHLIGHT = 0xa8a090;

// Light direction (upper-left, matching GroundRenderer)
const LIGHT_DIR_X = -0.707;
const LIGHT_DIR_Y = -0.707;

interface Peak {
  px: number;      // pixel x
  py: number;      // pixel y
  elevation: number;
  size: number;    // peak radius in pixels
}

interface Crag {
  px: number;
  py: number;
  width: number;
  height: number;
}

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
    const N = resolution;
    const scale = topo.size / N;
    const { points, numRegions } = topo.mesh;

    // Build spatial grid
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

    // ----------------------------------------------------------------
    // 1. Find peak locations (local maxima above snow line)
    // ----------------------------------------------------------------
    const peaks = this._findPeaks(elevGrid, N, rng);

    // ----------------------------------------------------------------
    // 2. Render rocky crags at high elevation (below snow line)
    // ----------------------------------------------------------------
    this._renderCrags(pixels, elevGrid, N, scale, rng, noise);

    // ----------------------------------------------------------------
    // 3. Render mountain peaks (3/4 iso projection above snow line)
    // ----------------------------------------------------------------
    // Sort by Y so southern peaks overlay northern ones
    peaks.sort((a, b) => a.py - b.py);

    for (const peak of peaks) {
      this._renderPeak(pixels, peak, N, rng, noise);
    }
  }

  // -----------------------------------------------------------------------
  // Find peaks: local elevation maxima above snow line
  // -----------------------------------------------------------------------
  private _findPeaks(elevGrid: Float32Array, N: number, rng: () => number): Peak[] {
    const SEARCH_RADIUS = 80; // pixels — minimum distance between peaks
    const MAX_PEAKS = 8;      // cap total number of peaks
    const placed: Peak[] = [];

    // Collect all pixels above snow line, sort by elevation descending
    const candidates: { px: number; py: number; elev: number }[] = [];
    const step = 6; // sample every 6th pixel for speed
    for (let py = step; py < N - step; py += step) {
      for (let px = step; px < N - step; px += step) {
        const elev = elevGrid[py * N + px];
        if (elev >= SNOW_LINE) {
          candidates.push({ px, py, elev });
        }
      }
    }
    candidates.sort((a, b) => b.elev - a.elev);

    for (const c of candidates) {
      if (placed.length >= MAX_PEAKS) break;

      // Check distance from already placed peaks
      let tooClose = false;
      for (const p of placed) {
        const dx = c.px - p.px;
        const dy = c.py - p.py;
        if (dx * dx + dy * dy < SEARCH_RADIUS * SEARCH_RADIUS) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      // Peak size based on elevation (higher = larger peak)
      const size = 20 + Math.floor((c.elev - SNOW_LINE) / (1 - SNOW_LINE) * 40);

      placed.push({ px: c.px, py: c.py, elevation: c.elev, size });
    }

    return placed;
  }

  // -----------------------------------------------------------------------
  // Render a single mountain peak with 3/4 iso projection
  // -----------------------------------------------------------------------
  private _renderPeak(
    pixels: Uint32Array,
    peak: Peak,
    N: number,
    rng: () => number,
    noise: (x: number, y: number) => number,
  ): void {
    const { px: cx, py: cy, size, elevation } = peak;

    // Peak apex is offset north (upward) from center to create 3/4 perspective
    const apexY = cy - Math.floor(size * 1.2);
    const apexX = cx;

    // Draw from bottom to top so upper pixels overlay lower
    const baseWidth = size * 2;
    const peakHeight = Math.floor(size * 1.8);

    for (let y = cy + Math.floor(size * 0.3); y >= apexY; y--) {
      if (y < 0 || y >= N) continue;

      // How far up the peak are we (0 = base, 1 = apex)
      const t = 1 - (y - apexY) / peakHeight;
      const tClamped = Math.max(0, Math.min(1, t));

      // Width narrows toward apex
      const rowHalfWidth = Math.max(1, Math.floor(baseWidth * (1 - tClamped * 0.85) / 2));

      for (let x = cx - rowHalfWidth; x <= cx + rowHalfWidth; x++) {
        if (x < 0 || x >= N) continue;

        // Horizontal position relative to center (-1 to 1)
        const relX = rowHalfWidth > 0 ? (x - cx) / rowHalfWidth : 0;

        // Directional lighting: left side (negative x) is lit, right side shadowed
        const lightDot = relX * LIGHT_DIR_X + (tClamped - 0.5) * LIGHT_DIR_Y;
        const lightFactor = 0.5 + lightDot * 0.8;
        const light = Math.max(0.3, Math.min(1.1, lightFactor));

        // Noise for rock texture
        const n = noise(x * 0.15, y * 0.15);

        // Snow coverage: more at top, more on lit (left) side
        const snowChance = tClamped * 0.8 + (relX < 0 ? 0.2 : -0.1) + n * 0.15;
        const isSnow = snowChance > 0.35;

        let rgb: number;
        if (isSnow) {
          // Snow shading
          if (light > 0.8) rgb = SNOW_HIGHLIGHT;
          else if (light > 0.6) rgb = SNOW_BRIGHT;
          else if (light > 0.4) rgb = SNOW_MID;
          else rgb = SNOW_SHADOW;
        } else {
          // Rock face with striations
          const striationN = noise(x * 0.3, y * 0.5);
          if (striationN > 0.3) {
            rgb = light > 0.6 ? ROCK_STRIATION_LIGHT : ROCK_STRIATION_DARK;
          } else {
            if (light > 0.7) rgb = ROCK_FACE_LIGHT;
            else if (light > 0.45) rgb = ROCK_FACE_MID;
            else rgb = ROCK_FACE_DARK;
          }
        }

        // Edge darkening for silhouette definition
        const edgeDist = 1 - Math.abs(relX);
        const edgeFactor = edgeDist < 0.15 ? 0.7 + edgeDist * 2 : 1.0;

        pixels[y * N + x] = applyBrightness(rgb, light * edgeFactor);
      }
    }

    // Draw a few ridge lines radiating from apex for geological detail
    this._drawRidgeLines(pixels, peak, N, rng, noise);
  }

  // -----------------------------------------------------------------------
  // Ridge lines extending from peak
  // -----------------------------------------------------------------------
  private _drawRidgeLines(
    pixels: Uint32Array,
    peak: Peak,
    N: number,
    rng: () => number,
    noise: (x: number, y: number) => number,
  ): void {
    const apexX = peak.px;
    const apexY = peak.py - Math.floor(peak.size * 1.2);
    const ridgeCount = 2 + Math.floor(rng() * 2);

    for (let r = 0; r < ridgeCount; r++) {
      const angle = (r / ridgeCount) * Math.PI + rng() * 0.5 + Math.PI * 0.25;
      const length = peak.size * (0.5 + rng() * 0.8);

      let x = apexX;
      let y = apexY;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle) * 0.6; // foreshortened vertically

      for (let step = 0; step < length; step++) {
        const px = Math.floor(x);
        const py = Math.floor(y);
        if (px < 0 || px >= N || py < 0 || py >= N) break;

        // Ridge is a highlight line (snow or bright rock)
        const t = step / length;
        const ridgeLight = 1.0 - t * 0.3;
        const rgb = t < 0.5 ? SNOW_MID : ROCK_FACE_LIGHT;
        pixels[py * N + px] = applyBrightness(rgb, ridgeLight);

        // Shadow pixel on one side
        const shadowPx = px + 1;
        const shadowPy = py;
        if (shadowPx >= 0 && shadowPx < N && shadowPy >= 0 && shadowPy < N) {
          const si = shadowPy * N + shadowPx;
          pixels[si] = applyBrightness(ROCK_FACE_DARK, 0.6);
        }

        x += dx;
        y += dy;
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
    scale: number,
    rng: () => number,
    noise: (x: number, y: number) => number,
  ): void {
    const crags: Crag[] = [];
    const CRAG_DENSITY = 0.002; // probability per sampled pixel
    const step = 6;

    for (let py = step; py < N - step; py += step) {
      for (let px = step; px < N - step; px += step) {
        const elev = elevGrid[py * N + px];
        if (elev < CRAG_MIN_ELEV || elev >= SNOW_LINE) continue;

        // Higher elevation = more crags
        const chance = CRAG_DENSITY * ((elev - CRAG_MIN_ELEV) / (SNOW_LINE - CRAG_MIN_ELEV));
        if (rng() > chance) continue;

        const width = 3 + Math.floor(rng() * 5);
        const height = 3 + Math.floor(rng() * 5);
        crags.push({ px, py, width, height });
      }
    }

    for (const crag of crags) {
      this._renderCrag(pixels, crag, N, rng, noise);
    }
  }

  private _renderCrag(
    pixels: Uint32Array,
    crag: Crag,
    N: number,
    rng: () => number,
    noise: (x: number, y: number) => number,
  ): void {
    const { px: cx, py: cy, width, height } = crag;

    for (let dy = -height; dy <= 0; dy++) {
      // Width narrows toward top
      const t = 1 - (-dy / height); // 0 at top, 1 at base
      const rowHalfWidth = Math.max(1, Math.floor(width * t / 2));

      for (let dx = -rowHalfWidth; dx <= rowHalfWidth; dx++) {
        const px = cx + dx;
        const py = cy + dy;
        if (px < 0 || px >= N || py < 0 || py >= N) continue;

        const relX = rowHalfWidth > 0 ? dx / rowHalfWidth : 0;
        const light = 0.5 + relX * LIGHT_DIR_X * 0.6 + (t - 0.5) * LIGHT_DIR_Y * 0.4;
        const lightClamped = Math.max(0.35, Math.min(1.0, light));

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
