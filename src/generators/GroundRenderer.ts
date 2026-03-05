import { createNoise2D } from 'simplex-noise';
import { TopographyGenerator } from './TopographyGenerator';
import { type TerrainType, mulberry32, LIGHT_DIR_X, LIGHT_DIR_Y } from './utils';
import { HydrologyGenerator } from './HydrologyGenerator';
import { PALETTES, BAYER_4X4, applyBrightness } from './TerrainPalettes';
import { SpatialGrid } from './SpatialGrid';

// Terrain type ↔ integer index for typed-array storage
const TERRAIN_INDEX: Record<TerrainType, number> = {
  ocean: 0, water: 1, coast: 2, lowland: 3, highland: 4, rock: 5, cliff: 6,
};
const INDEX_TERRAIN: TerrainType[] = [
  'ocean', 'water', 'coast', 'lowland', 'highland', 'rock', 'cliff',
];

// Lighting
const LIGHT_STRENGTH = 3.0;
const LIGHT_BASE = 0.75;
const LIGHT_STEPS = 5;

// Border dithering
const DITHER_RANGE = 6;

export class GroundRenderer {
  regionGrid: Uint16Array | null = null;

  render(topo: TopographyGenerator, resolution: number, hydro?: HydrologyGenerator): Uint32Array {
    const { size, seed, mesh, terrainType: regionTerrain } = topo;
    const { points } = mesh;

    const N = resolution;
    const totalPixels = N * N;
    const scale = size / N;

    // Noise functions — must match TopographyGenerator seeds exactly
    const rngElev = mulberry32(seed ^ 0xdeadbeef);
    const elevNoise = createNoise2D(rngElev);
    const rngDetail = mulberry32(seed ^ 0xcafebabe);
    const detailNoise = createNoise2D(rngDetail);

    // ------------------------------------------------------------------
    // Spatial grid for nearest-region lookup
    // ------------------------------------------------------------------
    const spatialGrid = new SpatialGrid(points, size);

    // ------------------------------------------------------------------
    // Phase 1A: Region assignment + per-pixel elevation
    // ------------------------------------------------------------------
    const terrainGrid = new Uint8Array(totalPixels);
    const elevationGrid = new Float32Array(totalPixels);
    const regionGrid = hydro ? new Uint16Array(totalPixels) : null;

    for (let py = 0; py < N; py++) {
      const wy = (py + 0.5) * scale;
      for (let px = 0; px < N; px++) {
        const i = py * N + px;
        const wx = (px + 0.5) * scale;

        const bestR = spatialGrid.nearestRegion(wx, wy);

        terrainGrid[i] = TERRAIN_INDEX[regionTerrain[bestR]];
        if (regionGrid) regionGrid[i] = bestR;

        // Per-pixel elevation (shared formula via TopographyGenerator.elevationAt)
        elevationGrid[i] = topo.elevationAt(wx, wy, elevNoise);
      }
    }

    this.regionGrid = regionGrid;

    // ------------------------------------------------------------------
    // Phase 1B: Slope via central differences
    // ------------------------------------------------------------------
    const slopeX = new Float32Array(totalPixels);
    const slopeY = new Float32Array(totalPixels);

    for (let py = 0; py < N; py++) {
      for (let px = 0; px < N; px++) {
        const i = py * N + px;
        const left  = px > 0     ? elevationGrid[i - 1] : elevationGrid[i];
        const right = px < N - 1 ? elevationGrid[i + 1] : elevationGrid[i];
        const up    = py > 0     ? elevationGrid[i - N] : elevationGrid[i];
        const down  = py < N - 1 ? elevationGrid[i + N] : elevationGrid[i];
        slopeX[i] = (right - left) / 2;
        slopeY[i] = (down - up) / 2;
      }
    }

    // ------------------------------------------------------------------
    // Phase 1C: Border distance + border terrain (chamfer distance)
    // ------------------------------------------------------------------
    const borderDist = new Float32Array(totalPixels);
    const borderTerrain = new Uint8Array(totalPixels);
    const MAX_DIST = DITHER_RANGE + 1;

    // Initialize: border pixels = 0, interior = MAX_DIST
    for (let py = 0; py < N; py++) {
      for (let px = 0; px < N; px++) {
        const i = py * N + px;
        const t = terrainGrid[i];
        let isBorder = false;
        let neighborT = t;

        if (px > 0 && terrainGrid[i - 1] !== t)     { isBorder = true; neighborT = terrainGrid[i - 1]; }
        if (px < N-1 && terrainGrid[i + 1] !== t)    { isBorder = true; neighborT = terrainGrid[i + 1]; }
        if (py > 0 && terrainGrid[i - N] !== t)      { isBorder = true; neighborT = terrainGrid[i - N]; }
        if (py < N-1 && terrainGrid[i + N] !== t)    { isBorder = true; neighborT = terrainGrid[i + N]; }

        if (isBorder) {
          borderDist[i] = 0;
          borderTerrain[i] = neighborT;
        } else {
          borderDist[i] = MAX_DIST;
          borderTerrain[i] = t;
        }
      }
    }

    // Forward pass (top-left → bottom-right)
    for (let py = 0; py < N; py++) {
      for (let px = 0; px < N; px++) {
        const i = py * N + px;
        if (py > 0) {
          const above = i - N;
          const d = borderDist[above] + 1;
          if (d < borderDist[i]) {
            borderDist[i] = d;
            borderTerrain[i] = borderTerrain[above];
          }
        }
        if (px > 0) {
          const left = i - 1;
          const d = borderDist[left] + 1;
          if (d < borderDist[i]) {
            borderDist[i] = d;
            borderTerrain[i] = borderTerrain[left];
          }
        }
      }
    }

    // Backward pass (bottom-right → top-left)
    for (let py = N - 1; py >= 0; py--) {
      for (let px = N - 1; px >= 0; px--) {
        const i = py * N + px;
        if (py < N - 1) {
          const below = i + N;
          const d = borderDist[below] + 1;
          if (d < borderDist[i]) {
            borderDist[i] = d;
            borderTerrain[i] = borderTerrain[below];
          }
        }
        if (px < N - 1) {
          const right = i + 1;
          const d = borderDist[right] + 1;
          if (d < borderDist[i]) {
            borderDist[i] = d;
            borderTerrain[i] = borderTerrain[right];
          }
        }
      }
    }

    // ------------------------------------------------------------------
    // Phase 2: Pixel shader
    // ------------------------------------------------------------------
    const pixels = new Uint32Array(totalPixels);

    for (let py = 0; py < N; py++) {
      for (let px = 0; px < N; px++) {
        const i = py * N + px;
        const terrain = INDEX_TERRAIN[terrainGrid[i]];
        const palette = PALETTES[terrain];
        const wx = (px + 0.5) * scale;
        const wy = (py + 0.5) * scale;

        // 1. Base color from detail noise
        const dn = detailNoise(wx * palette.detailFreq, wy * palette.detailFreq);
        const t = (dn + 1) / 2; // 0..1
        const palIdx = Math.min(
          Math.floor(t * palette.detailAmp * palette.base.length),
          palette.base.length - 1,
        );
        let baseRGB = palette.base[palIdx];

        // 2. Moisture tinting (dry = shift toward brown/yellow, wet = richer green)
        if (hydro && regionGrid && (terrain === 'lowland' || terrain === 'highland' || terrain === 'coast')) {
          const moisture = hydro.moisture[regionGrid[i]];
          // Dryness factor: 0 = fully wet, 1 = bone dry
          const dryness = 1 - Math.min(1, moisture / 0.7);
          if (dryness > 0.05) {
            let r = (baseRGB >> 16) & 0xff;
            let g = (baseRGB >> 8) & 0xff;
            let b = baseRGB & 0xff;
            // Shift toward warm brown/tan: increase red, decrease green/blue
            const shift = dryness * 0.55;
            r = Math.min(255, Math.floor(r + (0x8a - r) * shift));
            g = Math.floor(g + (0x7a - g) * shift);
            b = Math.floor(b + (0x50 - b) * shift);
            baseRGB = (r << 16) | (g << 8) | b;
          }
        }

        // 3. Elevation shading (directional light from upper-left)
        // (moisture tinting applied above in step 2)
        const dot = slopeX[i] * LIGHT_DIR_X + slopeY[i] * LIGHT_DIR_Y;
        let lightFactor = LIGHT_BASE + dot * LIGHT_STRENGTH;
        lightFactor = Math.max(0.35, Math.min(1.0, lightFactor));
        // Quantize for pixel-art stepped shading
        lightFactor = Math.floor(lightFactor * LIGHT_STEPS) / LIGHT_STEPS;

        // 3. Border dithering
        const bd = borderDist[i];
        if (bd < DITHER_RANGE) {
          const threshold = BAYER_4X4[(py % 4) * 4 + (px % 4)] / 16;
          const blendChance = 1.0 - bd / DITHER_RANGE;
          if (blendChance > threshold) {
            const nbrTerrain = INDEX_TERRAIN[borderTerrain[i]];
            const nbrPalette = PALETTES[nbrTerrain];
            const nIdx = Math.min(
              Math.floor(t * nbrPalette.detailAmp * nbrPalette.base.length),
              nbrPalette.base.length - 1,
            );
            baseRGB = nbrPalette.base[nIdx];
          }
        }

        pixels[i] = applyBrightness(baseRGB, lightFactor);
      }
    }

    return pixels;
  }

}
