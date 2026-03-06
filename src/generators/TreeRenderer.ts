import PoissonDiskSampling from 'fast-2d-poisson-disk-sampling';
import { TopographyGenerator, mulberry32 } from './TopographyGenerator';
import { HydrologyGenerator } from './HydrologyGenerator';
import { packABGR } from './TerrainPalettes';
import { Season } from '../state/Season';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const LIGHT_DIR_X = -0.707;
const LIGHT_DIR_Y = -0.707;
const MIN_TREE_SPACING = 5;
const MAX_TREE_SPACING = 14;
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
  // Small conifer (3×14) — narrow spire, ~2x taller
  { w: 3, h: 14, data: [
    _, C, _,
    _, C, _,
    C, C, C,
    _, C, _,
    C, C, C,
    _, C, _,
    _, C, _,
    C, C, C,
    _, C, _,
    C, C, C,
    C, C, C,
    _, T, _,
    _, T, _,
    _, T, _,
  ]},
  // Small conifer variant (3×14)
  { w: 3, h: 14, data: [
    _, C, _,
    _, C, _,
    C, C, C,
    _, C, _,
    C, C, C,
    C, C, C,
    _, C, _,
    C, C, C,
    _, C, _,
    C, C, C,
    C, C, C,
    _, T, _,
    _, T, _,
    _, T, _,
  ]},
  // Medium conifer (5×18) — layered tiers, ~2x taller
  { w: 5, h: 18, data: [
    _, _, C, _, _,
    _, _, C, _, _,
    _, C, C, C, _,
    _, _, C, _, _,
    _, C, C, C, _,
    C, C, C, C, C,
    _, _, C, _, _,
    _, C, C, C, _,
    C, C, C, C, C,
    _, _, C, _, _,
    _, C, C, C, _,
    C, C, C, C, C,
    _, C, C, C, _,
    C, C, C, C, C,
    _, C, C, C, _,
    _, _, T, _, _,
    _, _, T, _, _,
    _, _, T, _, _,
  ]},
  // Medium conifer variant (5×18)
  { w: 5, h: 18, data: [
    _, _, C, _, _,
    _, _, C, _, _,
    _, C, C, C, _,
    C, C, C, C, C,
    _, _, C, _, _,
    _, _, C, _, _,
    _, C, C, C, _,
    C, C, C, C, C,
    _, _, C, _, _,
    _, C, C, C, _,
    C, C, C, C, C,
    _, C, C, C, _,
    C, C, C, C, C,
    _, C, C, C, _,
    _, _, T, _, _,
    _, _, T, _, _,
    _, _, T, _, _,
    _, _, T, _, _,
  ]},
  // Large conifer (7×20) — tall layered, ~2x taller
  { w: 7, h: 20, data: [
    _, _, _, C, _, _, _,
    _, _, _, C, _, _, _,
    _, _, C, C, C, _, _,
    _, _, _, C, _, _, _,
    _, _, C, C, C, _, _,
    _, C, C, C, C, C, _,
    _, _, _, C, _, _, _,
    _, _, C, C, C, _, _,
    _, C, C, C, C, C, _,
    C, C, C, C, C, C, C,
    _, _, C, C, C, _, _,
    _, C, C, C, C, C, _,
    C, C, C, C, C, C, C,
    _, C, C, C, C, C, _,
    C, C, C, C, C, C, C,
    _, _, C, C, C, _, _,
    _, _, _, T, _, _, _,
    _, _, _, T, _, _, _,
    _, _, _, T, _, _, _,
    _, _, _, T, _, _, _,
  ]},
];

// ---------------------------------------------------------------------------
// Bare tree templates (winter deciduous) — dendritic branching patterns
// All non-transparent pixels use T (trunk/branch color)
// ---------------------------------------------------------------------------
const BARE_TEMPLATES: SpriteTemplate[] = [
  // Small — leaning single branch
  { w: 5, h: 7, data: [
    _, _, _, T, _,
    _, _, T, _, _,
    _, T, T, _, _,
    _, _, T, _, _,
    _, _, T, _, _,
    _, _, T, _, _,
    _, _, T, _, _,
  ]},
  // Small — forked top
  { w: 5, h: 8, data: [
    _, T, _, T, _,
    _, T, _, T, _,
    _, _, T, _, _,
    _, _, T, _, _,
    _, _, T, _, _,
    _, _, T, _, _,
    _, _, T, _, _,
    _, _, T, _, _,
  ]},
  // Small — three prongs
  { w: 5, h: 8, data: [
    T, _, T, _, T,
    _, T, T, T, _,
    _, _, T, _, _,
    _, _, T, _, _,
    _, _, T, _, _,
    _, _, T, _, _,
    _, _, T, _, _,
    _, _, T, _, _,
  ]},
  // Small — bent trunk with stub
  { w: 5, h: 7, data: [
    _, _, T, _, _,
    _, _, T, T, _,
    _, _, T, _, _,
    _, T, T, _, _,
    _, _, T, _, _,
    _, _, T, _, _,
    _, _, T, _, _,
  ]},
  // Medium — layered branches alternating sides
  { w: 7, h: 10, data: [
    _, _, _, T, _, _, _,
    _, _, T, T, _, _, _,
    _, _, _, T, T, _, _,
    _, _, T, T, _, _, _,
    _, _, _, T, _, T, _,
    _, T, _, T, _, _, _,
    _, _, _, T, _, _, _,
    _, _, _, T, _, _, _,
    _, _, _, T, _, _, _,
    _, _, _, T, _, _, _,
  ]},
  // Medium — upswept branches
  { w: 7, h: 10, data: [
    _, T, _, _, _, T, _,
    _, _, T, _, T, _, _,
    _, _, T, _, T, _, _,
    _, _, _, T, _, _, _,
    _, _, _, T, _, _, _,
    _, _, T, T, T, _, _,
    _, _, _, T, _, _, _,
    _, _, _, T, _, _, _,
    _, _, _, T, _, _, _,
    _, _, _, T, _, _, _,
  ]},
  // Medium — asymmetric reaching
  { w: 7, h: 11, data: [
    T, _, _, _, _, _, _,
    _, T, _, _, _, T, _,
    _, _, T, _, T, _, _,
    _, _, T, T, _, _, _,
    _, _, _, T, _, _, _,
    _, _, _, T, T, _, _,
    _, _, _, T, _, _, _,
    _, _, _, T, _, _, _,
    _, _, _, T, _, _, _,
    _, _, _, T, _, _, _,
    _, _, _, T, _, _, _,
  ]},
  // Medium — candelabra
  { w: 7, h: 10, data: [
    _, T, _, T, _, T, _,
    _, T, _, T, _, T, _,
    _, _, T, T, T, _, _,
    _, _, _, T, _, _, _,
    _, _, _, T, _, _, _,
    _, _, _, T, _, _, _,
    _, _, _, T, _, _, _,
    _, _, _, T, _, _, _,
    _, _, _, T, _, _, _,
    _, _, _, T, _, _, _,
  ]},
  // Large — wide oak silhouette with sub-branches
  { w: 9, h: 12, data: [
    _, T, _, _, _, _, _, T, _,
    _, _, T, _, _, _, T, _, _,
    T, _, _, T, _, T, _, _, T,
    _, T, _, _, T, _, _, T, _,
    _, _, T, _, T, _, T, _, _,
    _, _, _, T, T, T, _, _, _,
    _, _, _, _, T, _, _, _, _,
    _, _, _, _, T, _, _, _, _,
    _, _, _, _, T, _, _, _, _,
    _, _, _, _, T, _, _, _, _,
    _, _, _, _, T, _, _, _, _,
    _, _, _, _, T, _, _, _, _,
  ]},
  // Large — elm shape, drooping outer branches
  { w: 9, h: 13, data: [
    _, _, T, _, _, _, T, _, _,
    _, T, _, _, _, _, _, T, _,
    _, T, _, _, T, _, _, T, _,
    _, _, T, _, T, _, T, _, _,
    _, _, _, T, T, T, _, _, _,
    _, _, _, _, T, _, _, _, _,
    _, _, _, T, T, _, _, _, _,
    _, _, _, _, T, _, _, _, _,
    _, _, _, _, T, _, _, _, _,
    _, _, _, _, T, _, _, _, _,
    _, _, _, _, T, _, _, _, _,
    _, _, _, _, T, _, _, _, _,
    _, _, _, _, T, _, _, _, _,
  ]},
  // Large — twisted with horizontal reach
  { w: 9, h: 12, data: [
    _, _, _, _, _, _, T, _, _,
    _, T, _, _, _, T, _, _, _,
    _, _, T, _, _, _, T, _, _,
    _, _, _, T, _, T, _, T, _,
    _, T, _, _, T, _, _, _, _,
    _, _, T, T, T, _, _, _, _,
    _, _, _, T, _, _, _, _, _,
    _, _, _, T, _, _, _, _, _,
    _, _, _, T, _, _, _, _, _,
    _, _, _, T, _, _, _, _, _,
    _, _, _, T, _, _, _, _, _,
    _, _, _, T, _, _, _, _, _,
  ]},
];

// ---------------------------------------------------------------------------
// Color palettes
// ---------------------------------------------------------------------------
interface TreePalette {
  canopy: number[];   // 5 shades: shadow → highlight (RGB hex)
  trunk: number[];    // 2 shades: light (left), dark (right)
}

// --- Summer (default) deciduous palettes ---
const DECIDUOUS_PALETTES_SUMMER: TreePalette[] = [
  { canopy: [0x1f4a22, 0x2d6630, 0x3a8040, 0x50a048, 0x68b850], trunk: [0x8a7860, 0x5a4a38] },
  { canopy: [0x2a5028, 0x387038, 0x4a8c48, 0x60a458, 0x78bc60], trunk: [0x907c62, 0x604e3c] },
  { canopy: [0x1a4028, 0x285a30, 0x347040, 0x44884a, 0x58a058], trunk: [0x887060, 0x584838] },
];

// --- Spring: bright fresh greens, ~15% of trees get pink blossoms ---
const DECIDUOUS_PALETTES_SPRING: TreePalette[] = [
  { canopy: [0x2a6028, 0x3a7c38, 0x4c9848, 0x60b058, 0x78c868], trunk: [0x8a7860, 0x5a4a38] },
  { canopy: [0x306830, 0x408840, 0x52a050, 0x68b860, 0x80cc70], trunk: [0x907c62, 0x604e3c] },
  { canopy: [0x245828, 0x347030, 0x448840, 0x58a04c, 0x6cb85c], trunk: [0x887060, 0x584838] },
];
// Blossom palette: pink/white flowers
const DECIDUOUS_PALETTES_BLOSSOM: TreePalette[] = [
  { canopy: [0xc07090, 0xd088a0, 0xe0a0b8, 0xecb8cc, 0xf4d0e0], trunk: [0x8a7860, 0x5a4a38] },
  { canopy: [0xb86888, 0xcc80a0, 0xdc98b4, 0xe8b0c8, 0xf0c8d8], trunk: [0x907c62, 0x604e3c] },
];

// --- Fall: oranges, reds, golden yellows ---
const DECIDUOUS_PALETTES_FALL: TreePalette[] = [
  { canopy: [0x8a3818, 0xa04820, 0xb86028, 0xcc7830, 0xe09038], trunk: [0x8a7860, 0x5a4a38] },
  { canopy: [0x904420, 0xa85828, 0xc07030, 0xd48838, 0xe8a040], trunk: [0x907c62, 0x604e3c] },
  { canopy: [0x7a3020, 0x943828, 0xac4430, 0xc05038, 0xd46040], trunk: [0x887060, 0x584838] },
  { canopy: [0x886020, 0xa07828, 0xb89030, 0xc8a438, 0xd8b840], trunk: [0x8a7860, 0x5a4a38] },
];

// --- Winter: bare branches — dark wood that contrasts against white snow ---
const DECIDUOUS_PALETTES_WINTER: TreePalette[] = [
  { canopy: [0x2a2018, 0x3a2c20, 0x483828, 0x584830, 0x685838], trunk: [0x3a2c20, 0x281c14] },
  { canopy: [0x2c2218, 0x3c2e22, 0x4a3a2a, 0x5a4a32, 0x6a5a3a], trunk: [0x382a1e, 0x261a12] },
];

// --- Conifer palettes per season ---
const CONIFER_PALETTES_SUMMER: TreePalette[] = [
  { canopy: [0x1a3822, 0x244a2a, 0x2e5c32, 0x3a6e3a, 0x4a8044], trunk: [0x6a5840, 0x4a3828] },
  { canopy: [0x1c3c20, 0x264e2a, 0x306034, 0x3c723e, 0x4c8648], trunk: [0x705c44, 0x4c3c2a] },
];

const CONIFER_PALETTES_SPRING: TreePalette[] = [
  { canopy: [0x1e4024, 0x28542e, 0x326838, 0x3e7c42, 0x50904c], trunk: [0x6a5840, 0x4a3828] },
  { canopy: [0x204428, 0x2a5830, 0x346c3a, 0x408044, 0x52944e], trunk: [0x705c44, 0x4c3c2a] },
];

const CONIFER_PALETTES_FALL: TreePalette[] = [
  { canopy: [0x1a3822, 0x244a2a, 0x2e5c32, 0x3a6e3a, 0x4a8044], trunk: [0x6a5840, 0x4a3828] },
  { canopy: [0x1c3c20, 0x264e2a, 0x306034, 0x3c723e, 0x4c8648], trunk: [0x705c44, 0x4c3c2a] },
];

// Winter conifers: snow-dusted, lighter tips
const CONIFER_PALETTES_WINTER: TreePalette[] = [
  { canopy: [0x1a3822, 0x2a4a30, 0x3a6040, 0x90b0a0, 0xc8dcd0], trunk: [0x6a5840, 0x4a3828] },
  { canopy: [0x1c3c20, 0x2c502e, 0x3c6438, 0x88a898, 0xc0d4c8], trunk: [0x705c44, 0x4c3c2a] },
];

function getDeciduousPalettes(season: Season, rng: () => number): TreePalette[] {
  switch (season) {
    case Season.Spring:
      // 15% chance of blossom palette
      return rng() < 0.15 ? DECIDUOUS_PALETTES_BLOSSOM : DECIDUOUS_PALETTES_SPRING;
    case Season.Fall:   return DECIDUOUS_PALETTES_FALL;
    case Season.Winter: return DECIDUOUS_PALETTES_WINTER;
    default:            return DECIDUOUS_PALETTES_SUMMER;
  }
}

function getConiferPalettes(season: Season): TreePalette[] {
  switch (season) {
    case Season.Spring: return CONIFER_PALETTES_SPRING;
    case Season.Fall:   return CONIFER_PALETTES_FALL;
    case Season.Winter: return CONIFER_PALETTES_WINTER;
    default:            return CONIFER_PALETTES_SUMMER;
  }
}

// Legacy aliases for backward compatibility
const DECIDUOUS_PALETTES = DECIDUOUS_PALETTES_SUMMER;
const CONIFER_PALETTES = CONIFER_PALETTES_SUMMER;

// ---------------------------------------------------------------------------
// Tree instance
// ---------------------------------------------------------------------------
interface TreeInstance {
  px: number;       // pixel x of trunk base
  py: number;       // pixel y of trunk base
  template: SpriteTemplate;
  palette: TreePalette;
  flipped: boolean;
  isConifer: boolean;
  season: Season;
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
    season: Season = Season.Summer,
  ): Uint8Array {
    const rng = mulberry32(seed ^ 0x7ee0000);
    const N = resolution;
    const scale = topo.size / N;
    const { points } = topo.mesh;
    const numRegions = topo.mesh.numRegions;

    // ------------------------------------------------------------------
    // 1. Spatial grid for nearest-region lookup (same as GroundRenderer)
    // ------------------------------------------------------------------
    const cellSize = 80;
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
      // Winter deciduous: use bare tree templates with dendritic branching
      const isBareWinter = season === Season.Winter && !isConifer;
      const templates = isConifer ? CONIFER_TEMPLATES : (isBareWinter ? BARE_TEMPLATES : DECIDUOUS_TEMPLATES);
      const palettes = isConifer ? getConiferPalettes(season) : getDeciduousPalettes(season, rng);
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
        flipped: rng() < 0.5,
        isConifer,
        season,
      });
    }

    // ------------------------------------------------------------------
    // 5. Sort by Y for painter's algorithm (north to south)
    // ------------------------------------------------------------------
    trees.sort((a, b) => a.py - b.py);

    // Tree mask: tracks which pixels are covered by tree sprites
    const treeMask = new Uint8Array(N * N);

    // ------------------------------------------------------------------
    // 6. Shadow pass (skip bare winter deciduous — no leaf canopy to cast shadow)
    // ------------------------------------------------------------------
    for (const tree of trees) {
      if (tree.season === Season.Winter && !tree.isConifer) continue;
      this._stampShadow(pixels, N, tree);
    }

    // ------------------------------------------------------------------
    // 7. Sprite pass (also marks tree mask)
    // ------------------------------------------------------------------
    for (const tree of trees) {
      this._stampSprite(pixels, N, tree, treeMask);
    }

    return treeMask;
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
  private _stampSprite(pixels: Uint32Array, N: number, tree: TreeInstance, treeMask?: Uint8Array): void {
    const { px: tx, py: ty, template, palette, flipped, isConifer, season } = tree;
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
        const idx = py * N + px;
        pixels[idx] = packABGR(r, g, b);
        if (treeMask) treeMask[idx] = 1;
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
