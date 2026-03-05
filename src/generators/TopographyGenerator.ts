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
import { mulberry32, MAP_SCALE, type TerrainType } from './utils';

// Re-export for downstream consumers
export { mulberry32, MAP_SCALE, type TerrainType } from './utils';

export class TopographyGenerator {
  readonly size: number;
  readonly seed: number;

  readonly mesh!: DualMesh;
  readonly elevation!: Float32Array;    // per region, 0..1
  readonly terrainType!: TerrainType[]; // per region

  constructor(size: number, seed: number) {
    this.size = size;
    this.seed = seed;
    this._build();
  }

  // -------------------------------------------------------------------------
  // Build pipeline
  // -------------------------------------------------------------------------
  private _build(): void {
    const points = this._samplePoints();
    (this as any).mesh = new DualMesh(points);
    (this as any).elevation = this._computeElevation();
    (this as any).terrainType = this._classifyTerrain();
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

  /**
   * Compute raw elevation at an arbitrary world-space (x, y).
   * Uses multi-octave simplex noise + island mask — the same formula used
   * for per-region elevation but without the edge fade (which is only
   * applied at the region level).
   *
   * @param noise A noise2D function seeded with `seed ^ 0xdeadbeef`.
   */
  elevationAt(x: number, y: number, noise: (x: number, y: number) => number): number {
    const totalSize = this.size * MAP_SCALE;
    const offset = (totalSize - this.size) / 2;
    const halfTotal = totalSize / 2;

    const wx = x + offset;
    const wy = y + offset;
    const nx = wx / totalSize - 0.5;
    const ny = wy / totalSize - 0.5;

    const n =
      0.60 * noise(nx * 2,  ny * 2)  +
      0.25 * noise(nx * 4,  ny * 4)  +
      0.10 * noise(nx * 8,  ny * 8)  +
      0.05 * noise(nx * 16, ny * 16);
    const normalised = (n + 1) / 2;

    const dx = Math.abs(wx - halfTotal) / halfTotal;
    const dy = Math.abs(wy - halfTotal) / halfTotal;
    const dist = Math.max(dx, dy);
    const maskNoise = (noise(nx * 1.5, ny * 1.5) + 1) / 2;
    const islandMask = 1 - Math.pow(dist * (1.15 - 0.25 * maskNoise), 2.5);

    return Math.max(0, Math.min(1, normalised * 0.45 + islandMask * 0.55));
  }

  private _computeElevation(): Float32Array {
    const { numRegions, points } = this.mesh;
    const rng = mulberry32(this.seed ^ 0xdeadbeef);
    const noise = createNoise2D(rng);
    const elevation = new Float32Array(numRegions);

    for (let r = 0; r < numRegions; r++) {
      const { x, y } = points[r];
      let e = this.elevationAt(x, y, noise);

      // Force ocean at map edges — smooth fade over outer 60px
      const edgeDist = Math.min(x, y, this.size - x, this.size - y);
      const EDGE_FADE = 60;
      if (edgeDist < EDGE_FADE) {
        e *= Math.max(0, edgeDist / EDGE_FADE);
      }

      elevation[r] = e;
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
