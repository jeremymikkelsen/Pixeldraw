import { createNoise2D, type NoiseFunction2D } from 'simplex-noise';
import { TopographyGenerator, mulberry32 } from './TopographyGenerator';
import { applyBrightness } from './TerrainPalettes';

// ---------------------------------------------------------------------------
// Mountain peak rendering — volumetric 3/4 iso projection
// Reference aesthetic: massive rock masses with snow, strong directional
// lighting, exposed brown/orange cliff faces, blue-tinted snow shadows,
// jagged irregular silhouettes, diagonal striations.
// ---------------------------------------------------------------------------

const SNOW_LINE = 0.61;
const CRAG_MIN_ELEV = 0.45;

// ---- Rock palette: warm brown/orange tones (like reference) ----
const ROCK_WARM_DARK   = 0x5a3c28;  // deep brown shadow
const ROCK_WARM_MID    = 0x7a5438;  // brown
const ROCK_WARM_LIGHT  = 0x9a7048;  // warm tan
const ROCK_WARM_HOT    = 0xb08050;  // orange-brown highlight

const ROCK_COOL_DARK   = 0x3a3840;  // blue-gray deep shadow
const ROCK_COOL_MID    = 0x585060;  // gray
const ROCK_COOL_LIGHT  = 0x787078;  // light gray

// ---- Snow palette: blue-tinted shadows, warm highlights ----
const SNOW_DEEP_SHADOW = 0x8098b8;  // blue shadow in crevices
const SNOW_SHADOW      = 0xa0b8d0;  // shadow side
const SNOW_MID         = 0xc8d8e8;  // mid-tone
const SNOW_BRIGHT      = 0xe0ecf4;  // lit
const SNOW_HIGHLIGHT   = 0xf0f8ff;  // direct highlight

// ---- Crag palette ----
const CRAG_DARK      = 0x585040;
const CRAG_MID       = 0x706850;
const CRAG_LIGHT     = 0x888068;
const CRAG_HIGHLIGHT = 0xa09880;

interface Peak {
  px: number;
  py: number;
  elevation: number;
  size: number;
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

    // 2. Find and render mountain peaks
    const peaks = this._findPeaks(elevGrid, N, rng);
    peaks.sort((a, b) => a.py - b.py); // painter's order (north first)

    for (const peak of peaks) {
      this._renderPeak(pixels, peak, N, rng, noise, noise2);
    }
  }

  // -----------------------------------------------------------------------
  // Find peaks: few, well-spaced, large
  // -----------------------------------------------------------------------
  private _findPeaks(elevGrid: Float32Array, N: number, rng: () => number): Peak[] {
    const SEARCH_RADIUS = 120;
    const MAX_PEAKS = 4;
    const placed: Peak[] = [];

    const candidates: { px: number; py: number; elev: number }[] = [];
    const step = 8;
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

      // Bigger peaks: 40-80px radius
      const size = 40 + Math.floor((c.elev - SNOW_LINE) / (1 - SNOW_LINE) * 40);
      placed.push({ px: c.px, py: c.py, elevation: c.elev, size });
    }

    return placed;
  }

  // -----------------------------------------------------------------------
  // Render a single volumetric mountain peak
  // -----------------------------------------------------------------------
  private _renderPeak(
    pixels: Uint32Array,
    peak: Peak,
    N: number,
    rng: () => number,
    noise: NoiseFunction2D,
    noise2: NoiseFunction2D,
  ): void {
    const { px: cx, py: cy, size } = peak;

    // The mountain is a 3D mass. We define it as a height field:
    // at each (x,y) pixel, we compute a "local height" above the base.
    // The peak apex is offset north (upward) from the center for 3/4 view.
    const apexOffsetY = -size * 0.5;  // apex is north of center

    // The mountain base is an irregular ellipse
    const baseRadiusX = size * 1.1;
    const baseRadiusY = size * 0.8;
    const peakHeight = size * 1.6; // vertical extent in pixels

    // Multiple sub-peaks for irregular silhouette
    const subPeakCount = 2 + Math.floor(rng() * 3);
    const subPeaks: { dx: number; dy: number; h: number; r: number }[] = [];
    // Main peak
    subPeaks.push({ dx: 0, dy: apexOffsetY, h: 1.0, r: size * 0.6 });
    for (let i = 0; i < subPeakCount; i++) {
      const angle = rng() * Math.PI * 2;
      const dist = size * (0.2 + rng() * 0.5);
      subPeaks.push({
        dx: Math.cos(angle) * dist,
        dy: Math.sin(angle) * dist * 0.6 + apexOffsetY * (0.3 + rng() * 0.5),
        h: 0.4 + rng() * 0.5,
        r: size * (0.3 + rng() * 0.3),
      });
    }

    // Render bounding box
    const minX = Math.max(0, Math.floor(cx - baseRadiusX - 10));
    const maxX = Math.min(N - 1, Math.ceil(cx + baseRadiusX + 10));
    const minY = Math.max(0, Math.floor(cy + apexOffsetY - peakHeight * 0.3));
    const maxY = Math.min(N - 1, Math.ceil(cy + baseRadiusY + 5));

    // First pass: compute height field for the mountain
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const heightField = new Float32Array(w * h);

    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const lx = px - minX;
        const ly = py - minY;

        // Distance from base center, normalized by ellipse radii
        const relX = (px - cx) / baseRadiusX;
        const relY = (py - cy) / baseRadiusY;
        const baseDist = Math.sqrt(relX * relX + relY * relY);

        if (baseDist > 1.3) continue; // well outside base

        // Height is sum of sub-peak contributions (smooth max)
        let maxH = 0;
        for (const sp of subPeaks) {
          const dx = px - (cx + sp.dx);
          const dy = py - (cy + sp.dy);
          const d = Math.sqrt(dx * dx + dy * dy);
          const falloff = Math.max(0, 1 - d / sp.r);
          const contribution = sp.h * falloff * falloff; // quadratic falloff
          if (contribution > maxH) maxH = contribution;
        }

        // Noise-perturbed edges for irregular silhouette
        const edgeNoise = noise(px * 0.08, py * 0.08) * 0.15;
        const baseShape = Math.max(0, 1 - baseDist + edgeNoise);
        const localHeight = maxH * baseShape;

        if (localHeight > 0.01) {
          heightField[ly * w + lx] = localHeight;
        }
      }
    }

    // Second pass: render with lighting, color zones, snow/rock
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const lx = px - minX;
        const ly = py - minY;
        const localH = heightField[ly * w + lx];
        if (localH < 0.01) continue;

        // Compute surface normal from height field (for lighting)
        const hL = lx > 0 ? heightField[ly * w + lx - 1] : localH;
        const hR = lx < w - 1 ? heightField[ly * w + lx + 1] : localH;
        const hU = ly > 0 ? heightField[(ly - 1) * w + lx] : localH;
        const hD = ly < h - 1 ? heightField[(ly + 1) * w + lx] : localH;

        const slopeX = (hR - hL) * 0.5;
        const slopeY = (hD - hU) * 0.5;

        // Steepness (for determining rock vs snow)
        const steepness = Math.sqrt(slopeX * slopeX + slopeY * slopeY);

        // Directional lighting (upper-left)
        const lightDot = slopeX * -0.707 + slopeY * -0.707;
        const rawLight = 0.55 + lightDot * 3.5;
        // Quantize for pixel-art look
        const light = Math.max(0.2, Math.min(1.15,
          Math.floor(rawLight * 6) / 6));

        // Position relative to center
        const relX = (px - cx) / baseRadiusX;

        // ---- Determine material: snow or rock ----
        // Snow on top surfaces (low steepness), more on lit side (left)
        // Rock on steep faces and shadow side
        const snowFactor =
          localH * 1.2                          // higher = more snow
          - steepness * 4.0                     // steep = exposed rock
          + (relX < 0 ? 0.15 : -0.15)          // snow favors lit side
          + noise(px * 0.12, py * 0.12) * 0.2; // natural variation

        const isSnow = snowFactor > 0.35;

        // ---- Rock face: warm tones on lit side, cool on shadow ----
        let rgb: number;
        if (isSnow) {
          // Snow with blue-tinted shadows
          if (light > 0.95) rgb = SNOW_HIGHLIGHT;
          else if (light > 0.75) rgb = SNOW_BRIGHT;
          else if (light > 0.55) rgb = SNOW_MID;
          else if (light > 0.35) rgb = SNOW_SHADOW;
          else rgb = SNOW_DEEP_SHADOW;
        } else {
          // Rock face material
          const isLitSide = relX < 0.1;

          // Diagonal striations for geological texture
          const striationFreq = 0.25;
          const striation = noise2(
            (px * striationFreq + py * striationFreq * 0.7),
            (py * striationFreq - px * striationFreq * 0.3),
          );

          if (isLitSide) {
            // Warm brown/orange tones on lit side (like reference)
            if (striation > 0.3) {
              rgb = light > 0.6 ? ROCK_WARM_HOT : ROCK_WARM_LIGHT;
            } else if (striation > -0.2) {
              rgb = light > 0.6 ? ROCK_WARM_LIGHT : ROCK_WARM_MID;
            } else {
              rgb = light > 0.5 ? ROCK_WARM_MID : ROCK_WARM_DARK;
            }
          } else {
            // Cool gray/blue tones on shadow side
            if (striation > 0.3) {
              rgb = light > 0.5 ? ROCK_COOL_LIGHT : ROCK_COOL_MID;
            } else {
              rgb = light > 0.5 ? ROCK_COOL_MID : ROCK_COOL_DARK;
            }
          }

          // Crevice darkening in valleys of the height field
          if (localH < 0.15 && steepness > 0.05) {
            rgb = ROCK_COOL_DARK;
          }
        }

        // Edge darkening for silhouette pop
        const edgeDist = Math.min(
          lx > 0 ? heightField[ly * w + lx - 1] : 0,
          lx < w - 1 ? heightField[ly * w + lx + 1] : 0,
          ly > 0 ? heightField[(ly - 1) * w + lx] : 0,
          ly < h - 1 ? heightField[(ly + 1) * w + lx] : 0,
        );
        const edgeFactor = edgeDist < 0.02 ? 0.65 : 1.0;

        pixels[py * N + px] = applyBrightness(rgb, light * edgeFactor);
      }
    }

    // ---- Ridge lines from apex for sharp geological detail ----
    this._drawRidgeLines(pixels, peak, N, rng, noise, heightField, minX, minY, w, h);
  }

  // -----------------------------------------------------------------------
  // Ridge lines: sharp highlight/shadow pairs radiating from apex
  // -----------------------------------------------------------------------
  private _drawRidgeLines(
    pixels: Uint32Array,
    peak: Peak,
    N: number,
    rng: () => number,
    noise: NoiseFunction2D,
    heightField: Float32Array,
    hfMinX: number,
    hfMinY: number,
    hfW: number,
    hfH: number,
  ): void {
    const apexX = peak.px;
    const apexY = peak.py - peak.size * 0.5;
    const ridgeCount = 3 + Math.floor(rng() * 3);

    for (let r = 0; r < ridgeCount; r++) {
      const angle = (r / ridgeCount) * Math.PI * 1.5 + rng() * 0.6 + Math.PI * 0.2;
      const length = peak.size * (0.4 + rng() * 0.7);

      let x = apexX;
      let y = apexY;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle) * 0.55; // foreshortened

      for (let step = 0; step < length; step++) {
        const ix = Math.floor(x);
        const iy = Math.floor(y);
        if (ix < 0 || ix >= N || iy < 0 || iy >= N) break;

        // Only draw on mountain pixels
        const lx = ix - hfMinX;
        const ly = iy - hfMinY;
        if (lx < 0 || lx >= hfW || ly < 0 || ly >= hfH) break;
        if (heightField[ly * hfW + lx] < 0.05) break;

        const t = step / length; // 0=apex, 1=end
        const isSnowZone = t < 0.4;

        // Highlight pixel (ridge crest)
        const highlightRGB = isSnowZone ? SNOW_BRIGHT : ROCK_WARM_LIGHT;
        pixels[iy * N + ix] = applyBrightness(highlightRGB, 0.95 - t * 0.2);

        // Shadow pixel on downslope side
        const perpX = Math.round(-dy);
        const perpY = Math.round(dx);
        const sx = ix + perpX;
        const sy = iy + perpY;
        if (sx >= 0 && sx < N && sy >= 0 && sy < N) {
          const slx = sx - hfMinX;
          const sly = sy - hfMinY;
          if (slx >= 0 && slx < hfW && sly >= 0 && sly < hfH &&
              heightField[sly * hfW + slx] > 0.02) {
            const shadowRGB = isSnowZone ? SNOW_DEEP_SHADOW : ROCK_COOL_DARK;
            pixels[sy * N + sx] = applyBrightness(shadowRGB, 0.5);
          }
        }

        x += dx + noise(x * 0.05, y * 0.05) * 0.3; // slight meander
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
      const t = 1 - (-dy / height); // 0 at top, 1 at base
      const rowHW = Math.max(1, Math.floor(width * t / 2));

      // Noise-perturbed edge
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
