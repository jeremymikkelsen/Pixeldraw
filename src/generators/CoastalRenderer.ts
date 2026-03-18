import { createNoise2D } from 'simplex-noise';
import { TopographyGenerator, TerrainType, mulberry32 } from './TopographyGenerator';
import { HydrologyGenerator } from './HydrologyGenerator';
import { packABGR, applyBrightness } from './TerrainPalettes';
import { Season } from '../state/Season';

// ---------------------------------------------------------------------------
// Beach palette (sandy colors, dark → light)
// ---------------------------------------------------------------------------
// Beach colors per season
const BEACH_COLORS_BY_SEASON: Record<Season, number[]> = {
  [Season.Spring]: [0xb09860, 0xc0a870, 0xd0b880, 0xdcc890, 0xe8d8a0],
  [Season.Summer]: [0xb09860, 0xc0a870, 0xd0b880, 0xdcc890, 0xe8d8a0],
  [Season.Fall]:   [0xa08850, 0xb09860, 0xc0a870, 0xccb880, 0xd8c890],
  [Season.Winter]: [0x8a7858, 0x9a8868, 0xa89878, 0xb4a888, 0xc0b898],
};

// Ocean effect colors per season
function getOceanColors(season: Season) {
  if (season === Season.Winter) {
    return {
      sparkleDim:    packABGR(0x38, 0x60, 0x88),
      sparkleMid:    packABGR(0x58, 0x88, 0xb0),
      sparkleBright: packABGR(0x90, 0xc0, 0xd8),
      waveFoam:      packABGR(0xb8, 0xd0, 0xd8),
      waveBright:    packABGR(0xd0, 0xe0, 0xe8),
    };
  }
  return {
    sparkleDim:    packABGR(0x50, 0x80, 0xa8),
    sparkleMid:    packABGR(0x80, 0xb0, 0xd0),
    sparkleBright: packABGR(0xc0, 0xe0, 0xf0),
    waveFoam:      packABGR(0xd0, 0xe8, 0xf0),
    waveBright:    packABGR(0xe8, 0xf4, 0xf8),
  };
}

// Default colors for backward compatibility
const BEACH_COLORS = BEACH_COLORS_BY_SEASON[Season.Summer];
const SPARKLE_DIM = packABGR(0x50, 0x80, 0xa8);
const SPARKLE_MID = packABGR(0x80, 0xb0, 0xd0);
const SPARKLE_BRIGHT = packABGR(0xc0, 0xe0, 0xf0);
const WAVE_FOAM = packABGR(0xd0, 0xe8, 0xf0);
const WAVE_BRIGHT = packABGR(0xe8, 0xf4, 0xf8);

// Sea stack rock colors
const STACK_DARK = 0x504840;
const STACK_MID = 0x686058;
const STACK_LIGHT = 0x807870;
const STACK_HIGHLIGHT = 0x989088;

// ---------------------------------------------------------------------------
// Pixel metadata for animated effects
// ---------------------------------------------------------------------------
export interface CoastalPixel {
  idx: number;
  type: 'sparkle' | 'wave' | 'shorewave';
  phase: number;    // animation phase offset
  intensity: number; // 0-1, how strong the effect is
  dist: number;     // distance from land (for shore wave rolling)
}

// ---------------------------------------------------------------------------
// CoastalRenderer
// ---------------------------------------------------------------------------
// Wet sand colors per season (darker beach tones visible when wave recedes)
const WET_SAND_BY_SEASON: Record<Season, number> = {
  [Season.Spring]: packABGR(0x90, 0x80, 0x50),
  [Season.Summer]: packABGR(0x90, 0x80, 0x50),
  [Season.Fall]:   packABGR(0x80, 0x70, 0x48),
  [Season.Winter]: packABGR(0x68, 0x60, 0x48),
};

export class CoastalRenderer {
  private _animatedPixels: CoastalPixel[] = [];
  private _baseColors: Map<number, number> = new Map(); // idx -> original ABGR color
  extrusionMap: Int16Array | null = null;
  private _resolution = 0;

  get animatedPixels(): CoastalPixel[] { return this._animatedPixels; }

  /**
   * Render beaches, sea stacks onto the pixel buffer (static pass).
   * Also collects animated pixel metadata for sparkles and waves.
   */
  private _season: Season = Season.Summer;

  render(
    pixels: Uint32Array,
    topo: TopographyGenerator,
    hydro: HydrologyGenerator,
    resolution: number,
    seed: number,
    season: Season = Season.Summer,
    riverMask?: Uint8Array,
  ): void {
    this._season = season;
    const rng = mulberry32(seed ^ 0xbeac0000);
    const N = resolution;
    this._resolution = N;
    const scale = topo.size / N;
    const { points, numRegions } = topo.mesh;

    // Build spatial grid for nearest-region lookup
    const cellSize = 40;
    const gridW = Math.ceil(topo.size / cellSize);
    const grid: number[][] = new Array(gridW * gridW);
    for (let i = 0; i < grid.length; i++) grid[i] = [];
    for (let r = 0; r < numRegions; r++) {
      const gx = Math.min(Math.floor(points[r].x / cellSize), gridW - 1);
      const gy = Math.min(Math.floor(points[r].y / cellSize), gridW - 1);
      if (gx >= 0 && gy >= 0) grid[gy * gridW + gx].push(r);
    }

    // Noise for beach edge variation and sparkle placement
    const rngNoise = mulberry32(seed ^ 0x5a4d);
    const beachNoise = createNoise2D(rngNoise);

    // ----------------------------------------------------------------
    // Pass 1: Identify coastline pixels and paint beaches
    // ----------------------------------------------------------------
    // We need to know which pixels are ocean and which are land
    const isOcean = new Uint8Array(N * N);
    const elevation = new Float32Array(N * N);

    for (let py = 0; py < N; py++) {
      for (let px = 0; px < N; px++) {
        const i = py * N + px;
        const wx = (px + 0.5) * scale;
        const wy = (py + 0.5) * scale;
        const gx = Math.floor(wx / cellSize);
        const gyCur = Math.floor(wy / cellSize);

        let bestR = 0;
        let bestD = Infinity;
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

        const terrain = topo.terrainType[bestR];
        if (terrain === 'ocean' || terrain === 'water') {
          isOcean[i] = 1;
        }
        elevation[i] = topo.elevation[bestR];
      }
    }

    // Compute distance from ocean for each land pixel (chamfer distance)
    const oceanDist = new Float32Array(N * N).fill(255);
    // Also compute distance from land for each ocean pixel
    const landDist = new Float32Array(N * N).fill(255);

    // Initialize borders
    for (let py = 0; py < N; py++) {
      for (let px = 0; px < N; px++) {
        const i = py * N + px;
        if (isOcean[i]) {
          // Check if adjacent to land
          if ((px > 0 && !isOcean[i - 1]) ||
              (px < N - 1 && !isOcean[i + 1]) ||
              (py > 0 && !isOcean[i - N]) ||
              (py < N - 1 && !isOcean[i + N])) {
            landDist[i] = 0;
          }
        } else {
          // Check if adjacent to ocean
          if ((px > 0 && isOcean[i - 1]) ||
              (px < N - 1 && isOcean[i + 1]) ||
              (py > 0 && isOcean[i - N]) ||
              (py < N - 1 && isOcean[i + N])) {
            oceanDist[i] = 0;
          }
        }
      }
    }

    // Forward + backward chamfer passes for both distance fields
    for (let py = 0; py < N; py++) {
      for (let px = 0; px < N; px++) {
        const i = py * N + px;
        if (py > 0) {
          if (oceanDist[i - N] + 1 < oceanDist[i]) oceanDist[i] = oceanDist[i - N] + 1;
          if (landDist[i - N] + 1 < landDist[i]) landDist[i] = landDist[i - N] + 1;
        }
        if (px > 0) {
          if (oceanDist[i - 1] + 1 < oceanDist[i]) oceanDist[i] = oceanDist[i - 1] + 1;
          if (landDist[i - 1] + 1 < landDist[i]) landDist[i] = landDist[i - 1] + 1;
        }
      }
    }
    for (let py = N - 1; py >= 0; py--) {
      for (let px = N - 1; px >= 0; px--) {
        const i = py * N + px;
        if (py < N - 1) {
          if (oceanDist[i + N] + 1 < oceanDist[i]) oceanDist[i] = oceanDist[i + N] + 1;
          if (landDist[i + N] + 1 < landDist[i]) landDist[i] = landDist[i + N] + 1;
        }
        if (px < N - 1) {
          if (oceanDist[i + 1] + 1 < oceanDist[i]) oceanDist[i] = oceanDist[i + 1] + 1;
          if (landDist[i + 1] + 1 < landDist[i]) landDist[i] = landDist[i + 1] + 1;
        }
      }
    }

    // ----------------------------------------------------------------
    // Layout from ocean inward:
    //   ocean → water → swells → foam (over dynamic sand) → cobble → grass
    // No static sand — sand only appears dynamically when waves recede.
    // ----------------------------------------------------------------
    const SAND_ZONE = 3; // ocean pixels near shore where sand shows on wave recede
    const COBBLE_SHADES = [0x787880, 0x888890, 0x94949c, 0xa0a0a8, 0xacacb4];

    // Cobble rock border — 1-2px on land pixels at the water's edge
    for (let py = 0; py < N; py++) {
      for (let px = 0; px < N; px++) {
        const i = py * N + px;
        if (isOcean[i]) continue;
        if (riverMask && riverMask[i]) continue;

        const dist = oceanDist[i];
        if (dist > 3) continue;

        const wx = (px + 0.5) * scale;
        const wy = (py + 0.5) * scale;
        const cobbleWidth = 1.0 + (beachNoise(wx * 0.03, wy * 0.03) + 1) * 0.5; // 1-2px

        if (dist <= cobbleWidth) {
          const cobbleN = beachNoise(wx * 0.15, wy * 0.15);
          const ci = Math.min(COBBLE_SHADES.length - 1,
            Math.floor(((cobbleN + 1) / 2) * COBBLE_SHADES.length));
          pixels[i] = applyBrightness(COBBLE_SHADES[ci], 0.85 + cobbleN * 0.1);
        }
      }
    }

    // ----------------------------------------------------------------
    // Collect ocean sparkle pixels
    // ----------------------------------------------------------------
    const SPARKLE_DENSITY = season === Season.Winter ? 0.008 : 0.004;

    for (let py = 0; py < N; py++) {
      for (let px = 0; px < N; px++) {
        const i = py * N + px;
        if (!isOcean[i]) continue;

        // Sparkles: scattered across ocean
        if (rng() < SPARKLE_DENSITY) {
          const wx = (px + 0.5) * scale;
          const wy = (py + 0.5) * scale;
          this._animatedPixels.push({
            idx: i,
            type: 'sparkle',
            phase: beachNoise(wx * 0.02, wy * 0.02) * 20 + px * 0.1 + py * 0.1,
            intensity: 0.3 + rng() * 0.7,
            dist: 0,
          });
          this._baseColors.set(i, pixels[i]);
        }
      }
    }

    // Wave zone size — used by both whitecaps and shore waves
    const WAVE_ZONE = season === Season.Winter ? 12 : 10;

    // ----------------------------------------------------------------
    // Winter whitecaps: wave-type pixels scattered across open ocean
    // ----------------------------------------------------------------
    if (season === Season.Winter) {
      const WHITECAP_DENSITY = 0.006;
      for (let py = 0; py < N; py++) {
        for (let px = 0; px < N; px++) {
          const i = py * N + px;
          if (!isOcean[i]) continue;
          if (landDist[i] <= WAVE_ZONE) continue; // not near shore, those get regular waves
          if (rng() < WHITECAP_DENSITY) {
            const wx = (px + 0.5) * scale;
            const wy = (py + 0.5) * scale;
            this._animatedPixels.push({
              idx: i,
              type: 'wave',
              phase: beachNoise(wx * 0.01, wy * 0.01) * 15 + px * 0.2 + py * 0.15,
              intensity: 0.4 + rng() * 0.5,
              dist: 0,
            });
            if (!this._baseColors.has(i)) {
              this._baseColors.set(i, pixels[i]);
            }
          }
        }
      }
    }

    // ----------------------------------------------------------------
    // Collect wave pixels (ocean pixels near shore)
    // ----------------------------------------------------------------
    // Shore waves + swells: cover all ocean pixels from shore to WAVE_ZONE.
    // Close to shore (over sand): breaking waves with foam.
    // Further out: rolling swells that build into the breaking waves.

    for (let py = 0; py < N; py++) {
      for (let px = 0; px < N; px++) {
        const i = py * N + px;
        if (!isOcean[i]) continue;
        if (riverMask && riverMask[i]) continue;

        const dist = landDist[i];
        if (dist > WAVE_ZONE) continue;

        const wx = (px + 0.5) * scale;
        const wy = (py + 0.5) * scale;
        const waveIntensity = 1.0 - dist / WAVE_ZONE;

        this._animatedPixels.push({
          idx: i,
          type: 'shorewave',
          phase: beachNoise(wx * 0.008, wy * 0.008) * 4,
          intensity: waveIntensity,
          dist,
        });
        if (!this._baseColors.has(i)) {
          this._baseColors.set(i, pixels[i]);
        }
      }
    }

    // ----------------------------------------------------------------
    // Sea stacks: rocky outcroppings in shallow ocean
    // ----------------------------------------------------------------
    this._renderSeaStacks(pixels, isOcean, landDist, N, scale, rng, beachNoise);
  }

  /**
   * Animate sparkles and waves — called every frame.
   */
  animate(pixels: Uint32Array, timeMs: number): void {
    const timeSec = timeMs / 1000;
    const ext = this.extrusionMap;
    const N = this._resolution;
    const colors = getOceanColors(this._season);
    // Winter: choppier waves (faster animation)
    const waveSpeed = this._season === Season.Winter ? 2.2 : 1.5;
    const sparkleSpeed = this._season === Season.Winter ? 1.2 : 0.8;

    for (let i = 0; i < this._animatedPixels.length; i++) {
      const cp = this._animatedPixels[i];

      // Remap to extruded screen position
      let outIdx = cp.idx;
      if (ext) {
        const px = cp.idx % N;
        const py = (cp.idx - px) / N;
        const screenY = py - ext[cp.idx];
        if (screenY < 0 || screenY >= N) continue;
        outIdx = screenY * N + px;
      }

      if (cp.type === 'sparkle') {
        const sparkle = Math.sin(cp.phase + timeSec * sparkleSpeed) *
                        Math.sin(cp.phase * 1.3 + timeSec * 0.3);
        if (sparkle > 0.5) {
          pixels[outIdx] = sparkle > 0.8 ? colors.sparkleBright :
                           sparkle > 0.65 ? colors.sparkleMid : colors.sparkleDim;
        } else {
          pixels[outIdx] = this._baseColors.get(cp.idx)!;
        }
      } else if (cp.type === 'wave') {
        // Open-ocean whitecaps: simple flicker
        const wave = Math.sin(cp.phase - timeSec * waveSpeed);
        const threshold = 0.6 - cp.intensity * 0.3;
        if (wave > threshold) {
          const bright = wave > threshold + 0.2;
          pixels[outIdx] = bright ? colors.waveBright : colors.waveFoam;
        } else {
          pixels[outIdx] = this._baseColors.get(cp.idx)!;
        }
      } else if (cp.type === 'shorewave') {
        // Rolling shore waves with swells building into breaking surf.
        // dist=0 is at the shore, higher dist = further out to sea.
        const WAVE_RANGE = 10;
        const SAND_ZONE = 3;
        const cycle = timeSec * 0.4 + cp.phase;
        const waveDist = ((Math.sin(cycle) + 1) / 2) * WAVE_RANGE;
        const distToFront = cp.dist - waveDist;

        if (cp.dist <= SAND_ZONE) {
          // Near-shore zone: foam segments over sand, water otherwise.
          // No static sand — base color IS the original water.
          const segmentNoise = Math.sin(cp.phase * 3.7) * Math.cos(cp.phase * 2.1 + timeSec * 0.15);
          const showFoam = segmentNoise > -0.2;

          if (showFoam && Math.abs(distToFront) < 1.5) {
            const bright = Math.abs(distToFront) < 0.5;
            pixels[outIdx] = bright ? colors.waveBright : colors.waveFoam;
          } else if (distToFront < 0) {
            // Shore side of wave: sand exposed as wave recedes
            pixels[outIdx] = WET_SAND_BY_SEASON[this._season];
          } else {
            // Ocean side of wave: original water color (perfect match)
            pixels[outIdx] = this._baseColors.get(cp.idx)!;
          }
        } else {
          // Open water: no brightening, just base color
          pixels[outIdx] = this._baseColors.get(cp.idx)!;
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Sea stacks: small rocky outcroppings scattered in shallow ocean
  // -----------------------------------------------------------------------
  private _renderSeaStacks(
    pixels: Uint32Array,
    isOcean: Uint8Array,
    landDist: Float32Array,
    N: number,
    scale: number,
    rng: () => number,
    noise: (x: number, y: number) => number,
  ): void {
    const SEA_STACK_COUNT = Math.floor(N * 0.015); // ~30 for 2048
    const MIN_LAND_DIST = 3;
    const MAX_LAND_DIST = 20;

    let placed = 0;
    let attempts = 0;
    const maxAttempts = SEA_STACK_COUNT * 20;

    while (placed < SEA_STACK_COUNT && attempts < maxAttempts) {
      attempts++;
      const px = Math.floor(rng() * N);
      const py = Math.floor(rng() * N);
      const i = py * N + px;

      if (!isOcean[i]) continue;
      const dist = landDist[i];
      if (dist < MIN_LAND_DIST || dist > MAX_LAND_DIST) continue;

      // Draw a small rock formation (2-5 pixels)
      const stackSize = 2 + Math.floor(rng() * 4);
      const stackHeight = 1 + Math.floor(rng() * 3);

      for (let dy = -stackHeight; dy <= 0; dy++) {
        const rowWidth = Math.max(1, stackSize + dy); // narrower at top
        for (let dx = -Math.floor(rowWidth / 2); dx <= Math.floor(rowWidth / 2); dx++) {
          const sx = px + dx;
          const sy = py + dy;
          if (sx < 0 || sx >= N || sy < 0 || sy >= N) continue;
          const si = sy * N + sx;
          if (!isOcean[si]) continue;

          // Directional shading (light from upper-left)
          let rgb: number;
          if (dx < 0 && dy < 0) rgb = STACK_HIGHLIGHT;
          else if (dx <= 0) rgb = STACK_LIGHT;
          else if (dy === 0) rgb = STACK_MID;
          else rgb = STACK_DARK;

          pixels[si] = applyBrightness(rgb, 0.9 + rng() * 0.2);
        }
      }

      // Add wave sparkle pixels around the sea stack
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const sx = px + dx;
          const sy = py + dy;
          if (sx < 0 || sx >= N || sy < 0 || sy >= N) continue;
          const si = sy * N + sx;
          if (!isOcean[si]) continue;
          if (Math.abs(dx) <= Math.floor(stackSize / 2) &&
              dy >= -stackHeight && dy <= 0) continue; // skip the rock itself

          if (rng() < 0.3) {
            const wx = (sx + 0.5) * scale;
            const wy = (sy + 0.5) * scale;
            this._animatedPixels.push({
              idx: si,
              type: 'wave',
              phase: noise(wx * 0.02, wy * 0.02) * 8 + sx * 0.2 + sy * 0.2,
              intensity: 0.7 + rng() * 0.3,
              dist: 0,
            });
            if (!this._baseColors.has(si)) {
              this._baseColors.set(si, pixels[si]);
            }
          }
        }
      }

      placed++;
    }
  }
}
