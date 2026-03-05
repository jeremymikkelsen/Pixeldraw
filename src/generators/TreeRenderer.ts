import PoissonDiskSampling from 'fast-2d-poisson-disk-sampling';
import { TopographyGenerator, mulberry32 } from './TopographyGenerator';
import { HydrologyGenerator } from './HydrologyGenerator';
import { packABGR } from './TerrainPalettes';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const LIGHT_DIR_X = -0.707;
const LIGHT_DIR_Y = -0.707;
const MIN_TREE_SPACING = 4;
const MAX_TREE_SPACING = 12;
const MIN_MOISTURE = 0.15;
const SHADOW_OFFSET_X = 1;
const SHADOW_OFFSET_Y = 0;
const SHADOW_DARKEN = 0.55;
const RIVER_BUFFER = 4;           // extra pixels around rivers to avoid
const EDGE_MARGIN = 8;
const OCEAN_FADE_MARGIN = 60;     // match the 60px ocean edge fade

// Elevation thresholds for tree type blending (adjusted for pow(2.2) elevation curve)
// Lowland (< 0.25): sparse plains with occasional deciduous
// Highland (0.25–0.45): dense deciduous forest
// Rock (0.45–0.61): dense conifer forest up to treeline
const DECIDUOUS_ONLY_BELOW = 0.34;
const CONIFER_ONLY_ABOVE = 0.42;
const SNOW_LINE = 0.61;           // no trees above this elevation

// ---------------------------------------------------------------------------
// Tree pixel cell types
// ---------------------------------------------------------------------------
const _  = 0;  // transparent
const T  = 1;  // trunk
const C  = 2;  // canopy (shade determined at render time)

// ---------------------------------------------------------------------------
// Sprite templates: [width, height, ...pixels row-major]
// ---------------------------------------------------------------------------
type SpriteTemplate = { w: number; h: number; data: number[] };

const DECIDUOUS_TEMPLATES: SpriteTemplate[] = [
  // Small deciduous (5×7) — compact round canopy
  { w: 5, h: 7, data: [
    _, C, C, C, _,
    C, C, C, C, C,
    C, C, C, C, C,
    C, C, C, C, C,
    _, C, C, C, _,
    _, _, T, _, _,
    _, _, T, _, _,
  ]},
  // Small deciduous variant (5×7) — scalloped
  { w: 5, h: 7, data: [
    _, _, C, _, _,
    _, C, C, C, _,
    C, C, C, C, C,
    C, C, C, C, C,
    _, C, C, C, _,
    _, _, T, _, _,
    _, _, T, _, _,
  ]},
  // Medium deciduous (7×9) — taller with visible trunk
  { w: 7, h: 9, data: [
    _, _, C, C, C, _, _,
    _, C, C, C, C, C, _,
    C, C, C, C, C, C, C,
    C, C, C, C, C, C, C,
    C, C, C, C, C, C, C,
    _, C, C, C, C, C, _,
    _, _, C, C, C, _, _,
    _, _, _, T, _, _, _,
    _, _, _, T, _, _, _,
  ]},
  // Medium deciduous variant (7×9) — clustered
  { w: 7, h: 9, data: [
    _, _, C, C, _, _, _,
    _, C, C, C, C, _, _,
    C, C, C, C, C, C, _,
    C, C, C, C, C, C, C,
    C, C, C, C, C, C, C,
    _, C, C, C, C, C, _,
    _, _, C, C, C, _, _,
    _, _, _, T, _, _, _,
    _, _, _, T, _, _, _,
  ]},
  // Large deciduous (7×10) — tall with scalloped canopy
  { w: 7, h: 10, data: [
    _, _, _, C, _, _, _,
    _, _, C, C, C, _, _,
    _, C, C, C, C, C, _,
    C, C, C, C, C, C, C,
    C, C, C, C, C, C, C,
    C, C, C, C, C, C, C,
    _, C, C, C, C, C, _,
    _, _, C, C, C, _, _,
    _, _, _, T, _, _, _,
    _, _, _, T, _, _, _,
  ]},
];

const CONIFER_TEMPLATES: SpriteTemplate[] = [
  // Small conifer (3×7) — narrow spire
  { w: 3, h: 7, data: [
    _, C, _,
    _, C, _,
    C, C, C,
    _, C, _,
    C, C, C,
    _, T, _,
    _, T, _,
  ]},
  // Small conifer variant (3×7)
  { w: 3, h: 7, data: [
    _, C, _,
    C, C, C,
    _, C, _,
    C, C, C,
    C, C, C,
    _, T, _,
    _, T, _,
  ]},
  // Medium conifer (5×9) — layered tiers
  { w: 5, h: 9, data: [
    _, _, C, _, _,
    _, _, C, _, _,
    _, C, C, C, _,
    C, C, C, C, C,
    _, _, C, _, _,
    _, C, C, C, _,
    C, C, C, C, C,
    _, _, T, _, _,
    _, _, T, _, _,
  ]},
  // Medium conifer variant (5×9)
  { w: 5, h: 9, data: [
    _, _, C, _, _,
    _, C, C, C, _,
    C, C, C, C, C,
    _, _, C, _, _,
    _, C, C, C, _,
    C, C, C, C, C,
    _, C, C, C, _,
    _, _, T, _, _,
    _, _, T, _, _,
  ]},
  // Large conifer (5×10) — tall layered
  { w: 5, h: 10, data: [
    _, _, C, _, _,
    _, _, C, _, _,
    _, C, C, C, _,
    C, C, C, C, C,
    _, _, C, _, _,
    _, C, C, C, _,
    C, C, C, C, C,
    _, C, C, C, _,
    _, _, T, _, _,
    _, _, T, _, _,
  ]},
];

// ---------------------------------------------------------------------------
// Color palettes
// ---------------------------------------------------------------------------
interface TreePalette {
  canopy: number[];   // 5 shades: shadow → highlight (RGB hex)
  trunk: number[];    // 2 shades: light (left), dark (right)
}

const DECIDUOUS_PALETTES: TreePalette[] = [
  { // Standard green
    canopy: [0x1f4a22, 0x2d6630, 0x3a8040, 0x50a048, 0x68b850],
    trunk:  [0x8a7860, 0x5a4a38],
  },
  { // Yellow-green
    canopy: [0x2a5028, 0x387038, 0x4a8c48, 0x60a458, 0x78bc60],
    trunk:  [0x907c62, 0x604e3c],
  },
  { // Dark emerald
    canopy: [0x1a4028, 0x285a30, 0x347040, 0x44884a, 0x58a058],
    trunk:  [0x887060, 0x584838],
  },
];

const CONIFER_PALETTES: TreePalette[] = [
  { // Dark blue-green
    canopy: [0x1a3822, 0x244a2a, 0x2e5c32, 0x3a6e3a, 0x4a8044],
    trunk:  [0x6a5840, 0x4a3828],
  },
  { // Forest green
    canopy: [0x1c3c20, 0x264e2a, 0x306034, 0x3c723e, 0x4c8648],
    trunk:  [0x705c44, 0x4c3c2a],
  },
];

// ---------------------------------------------------------------------------
// Tree instance
// ---------------------------------------------------------------------------
interface TreeInstance {
  px: number;       // pixel x of trunk base
  py: number;       // pixel y of trunk base
  template: SpriteTemplate;
  palette: TreePalette;
  flipped: boolean;
}

// ---------------------------------------------------------------------------
// TreeRenderer
// ---------------------------------------------------------------------------
export class TreeRenderer {

  renderTrees(
    pixels: Uint32Array,
    topo: TopographyGenerator,
    hydro: HydrologyGenerator,
    resolution: number,
    seed: number,
  ): void {
    const rng = mulberry32(seed ^ 0x7ee0000);
    const N = resolution;
    const scale = topo.size / N;
    const { points } = topo.mesh;
    const numRegions = topo.mesh.numRegions;

    // ------------------------------------------------------------------
    // 1. Spatial grid for nearest-region lookup (same as GroundRenderer)
    // ------------------------------------------------------------------
    const cellSize = 40;
    const gridW = Math.ceil(topo.size / cellSize);
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
    // 2. Build river exclusion mask
    // ------------------------------------------------------------------
    const riverMask = this._buildRiverMask(topo, hydro, N);

    // ------------------------------------------------------------------
    // 3. Poisson disk sampling for candidate positions
    // ------------------------------------------------------------------
    const pds = new PoissonDiskSampling({
      shape: [N, N],
      minDistance: MIN_TREE_SPACING,
      maxDistance: MAX_TREE_SPACING,
      tries: 20,
    }, rng);
    const candidates = pds.fill();

    // ------------------------------------------------------------------
    // 4. Filter candidates and build tree instances
    // ------------------------------------------------------------------
    const trees: TreeInstance[] = [];

    for (const pt of candidates) {
      const px = Math.floor(pt[0]);
      const py = Math.floor(pt[1]);

      // Edge check
      if (px < EDGE_MARGIN || py < EDGE_MARGIN ||
          px >= N - EDGE_MARGIN || py >= N - EDGE_MARGIN) continue;

      // River avoidance
      if (riverMask[py * N + px]) continue;

      // Find nearest region
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

      // Terrain check: lowland, highland, and rock (up to snow line)
      const terrain = topo.terrainType[bestR];
      if (terrain !== 'lowland' && terrain !== 'highland' && terrain !== 'rock') continue;

      const elev = topo.elevation[bestR];
      if (elev >= SNOW_LINE) continue;  // above snow line = no trees

      // Moisture filter
      const moisture = hydro.moisture[bestR];
      if (moisture < MIN_MOISTURE) continue;

      // Elevation-based density:
      //   Lowland (< 0.25): sparse plains, ~10% keep for occasional trees
      //   Highland (0.25–0.45): dense deciduous forest, ramps up quickly
      //   Rock (0.45–SNOW_LINE): dense conifers right up to treeline
      let elevDensity: number;
      if (elev < 0.25) {
        // Plains: very sparse, scattered trees
        elevDensity = 0.10;
      } else if (elev < 0.30) {
        // Transition: ramp from sparse to dense
        const t = (elev - 0.25) / 0.05;
        elevDensity = 0.10 + 0.85 * t;
      } else {
        // Dense forest from highland through rock, right up to treeline
        elevDensity = 0.95;
      }

      // Combined thinning: elevation density × moisture
      const keepChance = elevDensity * (moisture * 0.7 + 0.3);
      if (rng() > keepChance) continue;

      // Determine tree type (all conifer on rock terrain)
      let isConifer: boolean;
      if (elev < DECIDUOUS_ONLY_BELOW) {
        isConifer = false;
      } else if (elev >= CONIFER_ONLY_ABOVE) {
        isConifer = true;
      } else {
        // Blend zone
        const t = (elev - DECIDUOUS_ONLY_BELOW) / (CONIFER_ONLY_ABOVE - DECIDUOUS_ONLY_BELOW);
        isConifer = rng() < t;
      }

      // Pick size based on moisture (wetter = bigger)
      const templates = isConifer ? CONIFER_TEMPLATES : DECIDUOUS_TEMPLATES;
      const palettes = isConifer ? CONIFER_PALETTES : DECIDUOUS_PALETTES;
      const sizeRoll = rng() + moisture * 0.3;
      let templateIdx: number;
      if (sizeRoll > 1.0) {
        // Large: last template
        templateIdx = templates.length - 1;
      } else if (sizeRoll > 0.5) {
        // Medium: middle templates
        templateIdx = Math.floor(templates.length * 0.4 + rng() * templates.length * 0.3);
      } else {
        // Small: first templates
        templateIdx = Math.floor(rng() * Math.ceil(templates.length * 0.4));
      }
      templateIdx = Math.min(templateIdx, templates.length - 1);

      trees.push({
        px,
        py,
        template: templates[templateIdx],
        palette: palettes[Math.floor(rng() * palettes.length)],
        flipped: false,
      });
    }

    // ------------------------------------------------------------------
    // 5. Sort by Y for painter's algorithm (north to south)
    // ------------------------------------------------------------------
    trees.sort((a, b) => a.py - b.py);

    // ------------------------------------------------------------------
    // 6. Shadow pass
    // ------------------------------------------------------------------
    for (const tree of trees) {
      this._stampShadow(pixels, N, tree);
    }

    // ------------------------------------------------------------------
    // 7. Sprite pass
    // ------------------------------------------------------------------
    for (const tree of trees) {
      this._stampSprite(pixels, N, tree);
    }
  }

  // -----------------------------------------------------------------------
  // Build river exclusion mask from hydro river paths
  // -----------------------------------------------------------------------
  private _buildRiverMask(
    topo: TopographyGenerator,
    hydro: HydrologyGenerator,
    resolution: number,
  ): Uint8Array {
    const N = resolution;
    const mask = new Uint8Array(N * N);
    const scale = topo.size / N;
    const { points } = topo.mesh;

    const RIVER_MIN = 25;
    const maxAccum = Math.max(RIVER_MIN + 1, Math.max(...Array.from(hydro.flowAccumulation)));
    const logMin = Math.log(RIVER_MIN);
    const logRange = Math.log(maxAccum) - logMin;

    for (const path of hydro.rivers) {
      for (let si = 0; si < path.length - 1; si++) {
        const rA = path[si];
        const rB = path[si + 1];
        const x0 = Math.floor(points[rA].x / scale);
        const y0 = Math.floor(points[rA].y / scale);
        const x1 = Math.floor(points[rB].x / scale);
        const y1 = Math.floor(points[rB].y / scale);

        const flow = Math.max(RIVER_MIN, hydro.flowAccumulation[rA], hydro.flowAccumulation[rB]);
        const t = Math.min(1, (Math.log(flow) - logMin) / logRange);
        const riverWidth = Math.max(1, Math.ceil(t * 6));
        const totalWidth = riverWidth + RIVER_BUFFER * 2;

        this._markThickLine(mask, N, x0, y0, x1, y1, totalWidth);
      }
    }
    return mask;
  }

  // Bresenham thick line marking (writes 1s into mask)
  private _markThickLine(
    mask: Uint8Array, N: number,
    x0: number, y0: number, x1: number, y1: number,
    width: number,
  ): void {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let cx = x0, cy = y0;
    const r = (width - 1) >> 1;

    while (true) {
      for (let oy = -r; oy <= r; oy++) {
        const py = cy + oy;
        if (py < 0 || py >= N) continue;
        for (let ox = -r; ox <= r; ox++) {
          const px = cx + ox;
          if (px < 0 || px >= N) continue;
          mask[py * N + px] = 1;
        }
      }
      if (cx === x1 && cy === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 < dx)  { err += dx; cy += sy; }
    }
  }

  // -----------------------------------------------------------------------
  // Stamp shadow (darken ground pixels in ellipse below-right of tree)
  // -----------------------------------------------------------------------
  private _stampShadow(pixels: Uint32Array, N: number, tree: TreeInstance): void {
    const { px: tx, py: ty, template } = tree;
    const sw = Math.ceil(template.w * 0.7);
    const sh = Math.max(2, Math.ceil(template.h * 0.25));
    const sx = tx + SHADOW_OFFSET_X - Math.floor(sw / 2);
    const sy = ty + SHADOW_OFFSET_Y;

    for (let dy = 0; dy < sh; dy++) {
      for (let dx = 0; dx < sw; dx++) {
        const px = sx + dx;
        const py = sy + dy;
        if (px < 0 || px >= N || py < 0 || py >= N) continue;

        // Ellipse test
        const ex = (dx - sw / 2) / (sw / 2);
        const ey = (dy - sh / 2) / (sh / 2);
        if (ex * ex + ey * ey > 1.0) continue;

        const idx = py * N + px;
        pixels[idx] = darkenPixel(pixels[idx], SHADOW_DARKEN);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Stamp tree sprite with directional lighting
  // -----------------------------------------------------------------------
  private _stampSprite(pixels: Uint32Array, N: number, tree: TreeInstance): void {
    const { px: tx, py: ty, template, palette, flipped } = tree;
    const { w, h, data } = template;

    // Tree position: trunk base at (tx, ty), sprite extends upward
    const startX = tx - Math.floor(w / 2);
    const startY = ty - h + 1;

    // Find canopy bounding box center for lighting
    let canopyMinX = w, canopyMaxX = 0, canopyMinY = h, canopyMaxY = 0;
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        if (data[sy * w + sx] === C) {
          canopyMinX = Math.min(canopyMinX, sx);
          canopyMaxX = Math.max(canopyMaxX, sx);
          canopyMinY = Math.min(canopyMinY, sy);
          canopyMaxY = Math.max(canopyMaxY, sy);
        }
      }
    }
    const canopyCX = (canopyMinX + canopyMaxX) / 2;
    const canopyCY = (canopyMinY + canopyMaxY) / 2;
    const canopyRadX = Math.max(1, (canopyMaxX - canopyMinX) / 2);
    const canopyRadY = Math.max(1, (canopyMaxY - canopyMinY) / 2);

    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const srcX = flipped ? (w - 1 - sx) : sx;
        const cell = data[sy * w + srcX];
        if (cell === 0) continue;

        const px = startX + sx;
        const py = startY + sy;
        if (px < 0 || px >= N || py < 0 || py >= N) continue;

        let color: number;
        if (cell === T) {
          // Trunk: left side lighter, right side darker
          const trunkMid = Math.floor(w / 2);
          const localX = flipped ? (w - 1 - sx) : sx;
          color = localX <= trunkMid ? palette.trunk[0] : palette.trunk[1];
        } else {
          // Canopy: shade based on position relative to center + light direction
          const relX = (srcX - canopyCX) / canopyRadX;
          const relY = (sy - canopyCY) / canopyRadY;
          const lightDot = relX * LIGHT_DIR_X + relY * LIGHT_DIR_Y;
          // Map [-1..1] to [0..4]
          const shadeIdx = Math.max(0, Math.min(4,
            Math.floor((lightDot + 1) / 2 * 4.99)));
          color = palette.canopy[shadeIdx];
        }

        const r = (color >> 16) & 0xff;
        const g = (color >> 8) & 0xff;
        const b = color & 0xff;
        pixels[py * N + px] = packABGR(r, g, b);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function darkenPixel(abgr: number, factor: number): number {
  const r = Math.floor((abgr & 0xff) * factor);
  const g = Math.floor(((abgr >> 8) & 0xff) * factor);
  const b = Math.floor(((abgr >> 16) & 0xff) * factor);
  return (255 << 24) | (b << 16) | (g << 8) | r;
}
