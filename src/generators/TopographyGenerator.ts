/**
 * TopographyGenerator
 *
 * Implements the Voronoi-polygon terrain approach described in
 * http://www-cs-students.stanford.edu/~amitp/game-programming/polygon-map-generation/
 *
 * Pipeline:
 *  1. Poisson-disk sample the canvas → region centres
 *  2. Build a DualMesh (Delaunay + derived Voronoi)
 *  3. Assign elevation per region using simplex noise + radial gradient
 *  4. Classify regions into terrain types
 *  5. Render Voronoi cells with Phaser Graphics, draw onto a RenderTexture
 */

import PoissonDiskSampling from 'fast-2d-poisson-disk-sampling';
import { createNoise2D } from 'simplex-noise';
import { DualMesh, Point } from './DualMesh';

// ---------------------------------------------------------------------------
// Seeded PRNG (Mulberry32) — returns a () => number factory
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

// ---------------------------------------------------------------------------
// Terrain types & colours (pixel-art palette)
// ---------------------------------------------------------------------------
export type TerrainType = 'ocean' | 'coast' | 'lowland' | 'highland' | 'rock' | 'cliff' | 'water';

const TERRAIN_COLORS: Record<TerrainType, number> = {
  ocean:    0x2a4a6b,
  water:    0x3a7ca5,
  coast:    0x7aac6a,
  lowland:  0x4a8c40,
  highland: 0x3a6c30,
  rock:     0x8c8070,
  cliff:    0xa09080,
};

// ---------------------------------------------------------------------------
// TopographyGenerator
// ---------------------------------------------------------------------------
export class TopographyGenerator {
  private readonly size: number;
  private readonly seed: number;

  private mesh!: DualMesh;
  private elevation!: Float32Array;    // per region, 0..1
  private terrainType!: TerrainType[]; // per region

  constructor(size: number, seed: number) {
    this.size = size;
    this.seed = seed;
    this._build();
  }

  // -------------------------------------------------------------------------
  // Public: rasterize the terrain data into a pixel buffer
  // -------------------------------------------------------------------------
  rasterize(resolution: number): Uint32Array {
    const pixels = new Uint32Array(resolution * resolution);
    const scale = this.size / resolution;
    const { points } = this.mesh;
    const numRegions = this.mesh.numRegions;

    // Spatial grid for fast nearest-region lookup
    const cellSize = 40;
    const gridW = Math.ceil(this.size / cellSize);
    const grid: number[][] = new Array(gridW * gridW);
    for (let i = 0; i < grid.length; i++) grid[i] = [];

    for (let r = 0; r < numRegions; r++) {
      const gx = Math.min(Math.floor(points[r].x / cellSize), gridW - 1);
      const gy = Math.min(Math.floor(points[r].y / cellSize), gridW - 1);
      if (gx >= 0 && gy >= 0) {
        grid[gy * gridW + gx].push(r);
      }
    }

    for (let py = 0; py < resolution; py++) {
      const wy = (py + 0.5) * scale;
      const gy = Math.floor(wy / cellSize);
      for (let px = 0; px < resolution; px++) {
        const wx = (px + 0.5) * scale;
        const gx = Math.floor(wx / cellSize);

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

        // Pack as ABGR for little-endian Uint32 → ImageData compatibility
        const color = TERRAIN_COLORS[this.terrainType[bestR]];
        const r = (color >> 16) & 0xff;
        const g = (color >> 8) & 0xff;
        const b = color & 0xff;
        pixels[py * resolution + px] = (255 << 24) | (b << 16) | (g << 8) | r;
      }
    }

    return pixels;
  }

  // -------------------------------------------------------------------------
  // Build pipeline
  // -------------------------------------------------------------------------
  private _build(): void {
    const points = this._samplePoints();
    this.mesh = new DualMesh(points);
    this.elevation = this._computeElevation();
    this.terrainType = this._classifyTerrain();
  }

  private _samplePoints(): Point[] {
    const rng = mulberry32(this.seed);

    const pds = new PoissonDiskSampling({
      shape: [this.size, this.size],
      minDistance: 18,
      maxDistance: 36,
      tries: 20,
    }, rng);

    const rawPoints = pds.fill() as [number, number][];
    const interior: Point[] = rawPoints.map(([x, y]) => ({ x, y }));

    // Add a ring of ghost points just outside the canvas so that all
    // interior Voronoi cells are fully enclosed (no clipped/open polygons).
    const boundary: Point[] = [];
    const step = 24;
    const pad = -step / 2;
    const far = this.size + step / 2;
    for (let v = pad; v <= far; v += step) {
      boundary.push({ x: v,    y: pad  });
      boundary.push({ x: v,    y: far  });
      boundary.push({ x: pad,  y: v    });
      boundary.push({ x: far,  y: v    });
    }

    return [...interior, ...boundary];
  }

  private _computeElevation(): Float32Array {
    const { numRegions, points } = this.mesh;
    const rng = mulberry32(this.seed ^ 0xdeadbeef);
    const noise = createNoise2D(rng);
    const elevation = new Float32Array(numRegions);
    const cx = this.size / 2;
    const cy = this.size / 2;
    const maxDist = Math.sqrt(cx * cx + cy * cy);

    for (let r = 0; r < numRegions; r++) {
      const { x, y } = points[r];

      // Multi-octave noise
      const nx = x / this.size - 0.5;
      const ny = y / this.size - 0.5;
      const n =
        0.60 * noise(nx * 2,  ny * 2)  +
        0.25 * noise(nx * 4,  ny * 4)  +
        0.10 * noise(nx * 8,  ny * 8)  +
        0.05 * noise(nx * 16, ny * 16);
      const normalised = (n + 1) / 2; // 0..1

      // Radial falloff — use Chebyshev distance so edges stay ocean
      const dx = Math.abs(x - cx) / cx;  // 0 at centre, 1 at edge
      const dy = Math.abs(y - cy) / cy;
      const dist = Math.max(dx, dy);      // Chebyshev: corners and edges both reach 1
      const maskNoise = (noise(nx * 1.5, ny * 1.5) + 1) / 2;
      // Push land inward; maskNoise adds coastline irregularity
      const islandMask = 1 - Math.pow(dist * (1.15 - 0.25 * maskNoise), 2.5);

      elevation[r] = Math.max(0, Math.min(1, normalised * 0.45 + islandMask * 0.55));
    }

    return elevation;
  }

  private _classifyTerrain(): TerrainType[] {
    const { numRegions } = this.mesh;
    const terrain: TerrainType[] = new Array(numRegions);

    for (let r = 0; r < numRegions; r++) {
      const e = this.elevation[r];
      if (e < 0.25)      terrain[r] = 'ocean';
      else if (e < 0.32) terrain[r] = 'water';
      else if (e < 0.38) terrain[r] = 'coast';
      else if (e < 0.55) terrain[r] = 'lowland';
      else if (e < 0.70) terrain[r] = 'highland';
      else if (e < 0.82) terrain[r] = 'rock';
      else               terrain[r] = 'cliff';
    }

    return terrain;
  }

}
