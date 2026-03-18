import { createNoise2D } from 'simplex-noise';
import { TopographyGenerator, TerrainType, mulberry32, MAP_SCALE } from './TopographyGenerator';
import { HydrologyGenerator } from './HydrologyGenerator';
import { getPalettes, applyBrightness, packABGR } from './TerrainPalettes';
import { Season } from '../state/Season';

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
const LIGHT_STRENGTH = 1.5;
const LIGHT_BASE = 0.82;
const LIGHT_STEPS = 5;

export class GroundRenderer {
  regionGrid: Uint16Array | null = null;
  terrainGrid: Uint8Array | null = null;

  render(topo: TopographyGenerator, resolution: number, hydro?: HydrologyGenerator, season: Season = Season.Summer): Uint32Array {
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
    const regionGrid = hydro ? new Uint16Array(totalPixels) : null;

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
        if (regionGrid) regionGrid[i] = bestR;

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

    this.regionGrid = regionGrid;
    this.terrainGrid = terrainGrid;

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
    // Phase 2: Pixel shader
    // ------------------------------------------------------------------
    const pixels = new Uint32Array(totalPixels);
    const palettes = getPalettes(season);

    for (let py = 0; py < N; py++) {
      for (let px = 0; px < N; px++) {
        const i = py * N + px;
        const terrain = INDEX_TERRAIN[terrainGrid[i]];
        const palette = palettes[terrain];
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
        // Skip in winter — snow covers everything, no brown dryness showing through
        if (season !== Season.Winter && hydro && regionGrid && (terrain === 'lowland' || terrain === 'highland' || terrain === 'coast')) {
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

        // 3. Winter snow coverage on land — blanket coverage with sparse green patches
        let isSnow = false;
        if (season === Season.Winter && terrain !== 'ocean' && terrain !== 'water') {
          // Mid-frequency noise for moderate-sized grass patches
          const patchNoise = detailNoise(wx * 0.02, wy * 0.02);
          // Higher frequency to add organic edges
          const edgeNoise = detailNoise(wx * 0.06, wy * 0.06);
          // Very selective: only ~3-5% of land shows through as grass
          const greenPatch = (patchNoise > 0.7) && (edgeNoise > 0.4);
          if (!greenPatch) {
            isSnow = true;
          }
        }

        // 4. Elevation shading (directional light from upper-left)
        const dot = slopeX[i] * LIGHT_DIR_X + slopeY[i] * LIGHT_DIR_Y;
        let lightFactor = LIGHT_BASE + dot * LIGHT_STRENGTH;
        if (isSnow) {
          // Snow: select shade from palette based on light + noise,
          // matching MountainRenderer's approach (no brightness dimming).
          // Base of 1.0 so flat lowland gets a mix of HIGHLIGHT and BRIGHT,
          // matching the bright mountain snow appearance.
          lightFactor = 1.0 + (lightFactor - LIGHT_BASE) * 0.25;
          const snowNoise = detailNoise(wx * 0.03, wy * 0.03);
          const snowLight = lightFactor + snowNoise * 0.15;
          if (snowLight > 1.05) baseRGB = 0xf0f8ff;      // SNOW_HIGHLIGHT
          else if (snowLight > 0.85) baseRGB = 0xe0ecf4;  // SNOW_BRIGHT
          else if (snowLight > 0.65) baseRGB = 0xc8d8e8;  // SNOW_MID
          else baseRGB = 0xa0b8d0;                         // SNOW_SHADOW
          pixels[i] = applyBrightness(baseRGB, 1.0);
        } else {
          lightFactor = Math.max(0.60, Math.min(1.0, lightFactor));
          // Quantize for pixel-art stepped shading
          lightFactor = Math.floor(lightFactor * LIGHT_STEPS) / LIGHT_STEPS;
          pixels[i] = applyBrightness(baseRGB, lightFactor);
        }
      }
    }

    return pixels;
  }

  /**
   * Draw rivers onto an existing pixel buffer.
   * Uses Bresenham thick lines between region centers along each river path,
   * with width scaled by log(flowAccumulation).
   * Returns a Uint8Array river mask (N*N) with 1s wherever river pixels are drawn.
   */
  renderRivers(
    pixels: Uint32Array,
    topo: TopographyGenerator,
    hydro: HydrologyGenerator,
    resolution: number,
  ): Uint8Array {
    const { points } = topo.mesh;
    const scale = topo.size / resolution;
    const N = resolution;
    const riverMask = new Uint8Array(N * N);

    // River color palette: darker = deeper/wider
    const RIVER_COLORS = [
      packABGR(0x2a, 0x70, 0x90),  // narrow streams
      packABGR(0x28, 0x65, 0x88),
      packABGR(0x25, 0x5c, 0x80),  // wide rivers
    ];

    // Normalize flow in log space: map [RIVER_MIN..maxAccum] → [0..1]
    const RIVER_MIN = 25;
    const maxAccum = Math.max(RIVER_MIN + 1, Math.max(...Array.from(hydro.flowAccumulation)));
    const logMin = Math.log(RIVER_MIN);
    const logRange = Math.log(maxAccum) - logMin;

    // Per-pixel ocean clip: index 0 = ocean, 1 = water
    const tg = this.terrainGrid;

    for (const path of hydro.rivers) {
      for (let si = 0; si < path.length - 1; si++) {
        const rA = path[si];
        const rB = path[si + 1];

        const x0 = Math.floor(points[rA].x / scale);
        const y0 = Math.floor(points[rA].y / scale);
        const x1 = Math.floor(points[rB].x / scale);
        const y1 = Math.floor(points[rB].y / scale);

        // Width from flow accumulation (1–10 pixels), log-space normalization, 10% steps
        const flow = Math.max(RIVER_MIN, hydro.flowAccumulation[rA], hydro.flowAccumulation[rB]);
        const t = Math.min(1, (Math.log(flow) - logMin) / logRange);
        const width = Math.max(1, Math.ceil(t * 10));

        // Color: darker for wider rivers
        const ci = Math.min(RIVER_COLORS.length - 1, Math.floor(t * RIVER_COLORS.length));
        const color = RIVER_COLORS[ci];

        this._drawThickLine(pixels, N, x0, y0, x1, y1, width, color, riverMask, tg);
      }
    }

    return riverMask;
  }

  private _drawThickLine(
    pixels: Uint32Array, N: number,
    x0: number, y0: number, x1: number, y1: number,
    width: number, color: number,
    mask?: Uint8Array,
    terrainClip?: Uint8Array | null,
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
          const pidx = py * N + px;
          // Skip deep ocean pixels; allow rivers over shallow water so they reach the shore
          if (terrainClip && terrainClip[pidx] === 0) continue;
          pixels[pidx] = color;
          if (mask) mask[pidx] = 1;
        }
      }

      if (cx === x1 && cy === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 < dx)  { err += dx; cy += sy; }
    }
  }
}
