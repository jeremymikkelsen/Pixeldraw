import { createNoise2D } from 'simplex-noise';
import { TopographyGenerator, TerrainType, mulberry32, MAP_SCALE } from './TopographyGenerator';
import { HydrologyGenerator } from './HydrologyGenerator';
import { PALETTES, BAYER_4X4, applyBrightness, packABGR } from './TerrainPalettes';

// Terrain type ↔ integer index for typed-array storage
const TERRAIN_INDEX: Record<TerrainType, number> = {
  ocean: 0, water: 1, coast: 2, lowland: 3, highland: 4, rock: 5, cliff: 6,
};
const INDEX_TERRAIN: TerrainType[] = [
  'ocean', 'water', 'coast', 'lowland', 'highland', 'rock', 'cliff',
];

// Lighting
const LIGHT_DIR_X = -0.707;
const LIGHT_DIR_Y = -0.707;
const LIGHT_STRENGTH = 3.0;
const LIGHT_BASE = 0.75;
const LIGHT_STEPS = 5;

// Border dithering
const DITHER_RANGE = 6;

export class GroundRenderer {

  render(topo: TopographyGenerator, resolution: number): Uint32Array {
    const { size, seed, mesh, terrainType: regionTerrain } = topo;
    const { points } = mesh;
    const numRegions = mesh.numRegions;

    const N = resolution;
    const totalPixels = N * N;
    const scale = size / N;

    // Noise functions — must match TopographyGenerator seeds exactly
    const rngElev = mulberry32(seed ^ 0xdeadbeef);
    const elevNoise = createNoise2D(rngElev);
    const rngDetail = mulberry32(seed ^ 0xcafebabe);
    const detailNoise = createNoise2D(rngDetail);

    // MAP_SCALE offset for elevation (same as TopographyGenerator)
    const totalSize = size * MAP_SCALE;
    const offset = (totalSize - size) / 2;
    const halfTotal = totalSize / 2;

    // ------------------------------------------------------------------
    // Spatial grid for nearest-region lookup
    // ------------------------------------------------------------------
    const cellSize = 40;
    const gridW = Math.ceil(size / cellSize);
    const grid: number[][] = new Array(gridW * gridW);
    for (let i = 0; i < grid.length; i++) grid[i] = [];

    for (let r = 0; r < numRegions; r++) {
      const gx = Math.min(Math.floor(points[r].x / cellSize), gridW - 1);
      const gy = Math.min(Math.floor(points[r].y / cellSize), gridW - 1);
      if (gx >= 0 && gy >= 0) {
        grid[gy * gridW + gx].push(r);
      }
    }

    // ------------------------------------------------------------------
    // Phase 1A: Region assignment + per-pixel elevation
    // ------------------------------------------------------------------
    const terrainGrid = new Uint8Array(totalPixels);
    const elevationGrid = new Float32Array(totalPixels);

    for (let py = 0; py < N; py++) {
      const wy = (py + 0.5) * scale;
      const gy = Math.floor(wy / cellSize);
      for (let px = 0; px < N; px++) {
        const i = py * N + px;
        const wx = (px + 0.5) * scale;
        const gx = Math.floor(wx / cellSize);

        // Nearest region lookup
        let bestR = 0;
        let bestD = Infinity;
        for (let dy = -2; dy <= 2; dy++) {
          const cy = gy + dy;
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

        terrainGrid[i] = TERRAIN_INDEX[regionTerrain[bestR]];

        // Per-pixel elevation (same formula as TopographyGenerator._computeElevation)
        const fmx = wx + offset;
        const fmy = wy + offset;
        const nx = fmx / totalSize - 0.5;
        const ny = fmy / totalSize - 0.5;
        const n =
          0.60 * elevNoise(nx * 2,  ny * 2)  +
          0.25 * elevNoise(nx * 4,  ny * 4)  +
          0.10 * elevNoise(nx * 8,  ny * 8)  +
          0.05 * elevNoise(nx * 16, ny * 16);
        const normalised = (n + 1) / 2;

        const dmx = Math.abs(fmx - halfTotal) / halfTotal;
        const dmy = Math.abs(fmy - halfTotal) / halfTotal;
        const dist = Math.max(dmx, dmy);
        const maskNoise = (elevNoise(nx * 1.5, ny * 1.5) + 1) / 2;
        const islandMask = 1 - Math.pow(dist * (1.15 - 0.25 * maskNoise), 2.5);

        elevationGrid[i] = Math.max(0, Math.min(1, normalised * 0.45 + islandMask * 0.55));
      }
    }

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

        // 2. Elevation shading (directional light from upper-left)
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

  /**
   * Draw rivers onto an existing pixel buffer.
   * Uses Bresenham thick lines between region centers along each river path,
   * with width scaled by log(flowAccumulation).
   */
  renderRivers(
    pixels: Uint32Array,
    topo: TopographyGenerator,
    hydro: HydrologyGenerator,
    resolution: number,
  ): void {
    const { points } = topo.mesh;
    const scale = topo.size / resolution;
    const N = resolution;

    // River color palette: darker = deeper/wider
    const RIVER_COLORS = [
      packABGR(0x2a, 0x70, 0x90),  // narrow streams
      packABGR(0x28, 0x65, 0x88),
      packABGR(0x25, 0x5c, 0x80),  // wide rivers
    ];

    const maxAccum = Math.max(1, Math.max(...Array.from(hydro.flowAccumulation)));

    for (const path of hydro.rivers) {
      for (let si = 0; si < path.length - 1; si++) {
        const rA = path[si];
        const rB = path[si + 1];

        // World coords → pixel coords
        const x0 = Math.floor(points[rA].x / scale);
        const y0 = Math.floor(points[rA].y / scale);
        const x1 = Math.floor(points[rB].x / scale);
        const y1 = Math.floor(points[rB].y / scale);

        // Width from flow accumulation (1–3 pixels), sqrt for gentler ramp
        const flow = Math.max(hydro.flowAccumulation[rA], hydro.flowAccumulation[rB]);
        const t = Math.sqrt(flow / maxAccum);
        const width = Math.max(1, Math.min(3, Math.round(1 + t * 2)));

        // Color: darker for wider rivers
        const ci = Math.min(RIVER_COLORS.length - 1, Math.floor(t * RIVER_COLORS.length));
        const color = RIVER_COLORS[ci];

        // Bresenham line with thickness
        this._drawThickLine(pixels, N, x0, y0, x1, y1, width, color);
      }
    }
  }

  private _drawThickLine(
    pixels: Uint32Array, N: number,
    x0: number, y0: number, x1: number, y1: number,
    width: number, color: number,
  ): void {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let cx = x0, cy = y0;
    const r = (width - 1) >> 1; // half-width for stamping

    while (true) {
      // Stamp a filled square of radius r
      for (let oy = -r; oy <= r; oy++) {
        const py = cy + oy;
        if (py < 0 || py >= N) continue;
        for (let ox = -r; ox <= r; ox++) {
          const px = cx + ox;
          if (px < 0 || px >= N) continue;
          pixels[py * N + px] = color;
        }
      }

      if (cx === x1 && cy === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 < dx)  { err += dx; cy += sy; }
    }
  }
}
