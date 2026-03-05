import type { Point } from './DualMesh';

/**
 * Accelerated nearest-Voronoi-region lookup using a uniform grid.
 *
 * Construction: O(R) to bucket R region centres.
 * Query: O(1) amortised — searches a 5×5 neighbourhood of grid cells.
 */
export class SpatialGrid {
  private readonly _grid: number[][];
  private readonly _gridW: number;
  private readonly _cellSize: number;
  private readonly _points: Point[];

  constructor(points: Point[], size: number, cellSize = 40) {
    this._cellSize = cellSize;
    this._points = points;
    this._gridW = Math.ceil(size / cellSize);

    const totalCells = this._gridW * this._gridW;
    this._grid = new Array(totalCells);
    for (let i = 0; i < totalCells; i++) this._grid[i] = [];

    for (let r = 0; r < points.length; r++) {
      const gx = Math.min(Math.floor(points[r].x / cellSize), this._gridW - 1);
      const gy = Math.min(Math.floor(points[r].y / cellSize), this._gridW - 1);
      if (gx >= 0 && gy >= 0) {
        this._grid[gy * this._gridW + gx].push(r);
      }
    }
  }

  /** Find nearest region index for world-space coordinate (wx, wy). */
  nearestRegion(wx: number, wy: number): number {
    const gx = Math.floor(wx / this._cellSize);
    const gy = Math.floor(wy / this._cellSize);
    let bestR = 0;
    let bestD = Infinity;

    for (let dy = -2; dy <= 2; dy++) {
      const cy = gy + dy;
      if (cy < 0 || cy >= this._gridW) continue;
      for (let dx = -2; dx <= 2; dx++) {
        const cx = gx + dx;
        if (cx < 0 || cx >= this._gridW) continue;
        for (const r of this._grid[cy * this._gridW + cx]) {
          const d = (this._points[r].x - wx) ** 2 + (this._points[r].y - wy) ** 2;
          if (d < bestD) { bestD = d; bestR = r; }
        }
      }
    }

    return bestR;
  }
}
