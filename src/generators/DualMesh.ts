/**
 * Minimal dual-mesh built on top of a Delaunay triangulation.
 *
 * Terminology follows redblobgames/mapgen4:
 *   r  = region  (Voronoi cell / point from Poisson sampling)
 *   t  = triangle (Delaunay triangle, also a Voronoi vertex)
 *   e  = half-edge
 *
 * Key relationships:
 *   Each triangle t has a centroid that becomes a Voronoi vertex.
 *   Each region r owns the Voronoi cell whose vertices are the
 *   centroids of the triangles that share point r.
 */
import Delaunator from 'delaunator';

export interface Point { x: number; y: number; }

function triangleOfEdge(e: number): number { return Math.floor(e / 3); }
function nextHalfEdge(e: number): number { return (e % 3 === 2) ? e - 2 : e + 1; }
function prevHalfEdge(e: number): number { return (e % 3 === 0) ? e + 2 : e - 1; }

export class DualMesh {
  // Input points (region centers)
  readonly points: Point[];
  // Delaunay output
  readonly delaunay: Delaunator<Float64Array>;

  // Voronoi vertex (= triangle centroid) positions
  readonly triCenters: Point[];

  constructor(points: Point[]) {
    this.points = points;

    const coords = new Float64Array(points.length * 2);
    for (let i = 0; i < points.length; i++) {
      coords[i * 2] = points[i].x;
      coords[i * 2 + 1] = points[i].y;
    }

    this.delaunay = new Delaunator(coords);
    this.triCenters = this._buildTriCenters();
  }

  get numRegions(): number { return this.points.length; }
  get numTriangles(): number { return this.delaunay.triangles.length / 3; }
  get numEdges(): number { return this.delaunay.triangles.length; }

  // Half-edges adjacent to triangle t
  edgesOfTriangle(t: number): [number, number, number] {
    return [3 * t, 3 * t + 1, 3 * t + 2];
  }

  // Region (point index) at the start of half-edge e
  regionOfEdge(e: number): number {
    return this.delaunay.triangles[e];
  }

  // Triangle on the other side of half-edge e (or -1 for boundary)
  oppositeTriangle(e: number): number {
    const opp = this.delaunay.halfedges[e];
    return opp === -1 ? -1 : triangleOfEdge(opp);
  }

  // All triangles that share region r (in order around r)
  trianglesAroundRegion(r: number): number[] {
    const result: number[] = [];
    // Find one half-edge pointing TO r
    let startEdge = -1;
    for (let e = 0; e < this.numEdges; e++) {
      if (this.delaunay.triangles[e] === r) { startEdge = e; break; }
    }
    if (startEdge === -1) return result;

    // Walk around r using outgoing half-edges.
    // For outgoing edge e (triangles[e] === r):
    //   prevHalfEdge(e) is the edge arriving at r in this triangle.
    //   halfedges[prevHalfEdge(e)] is the corresponding outgoing edge from r
    //   in the adjacent triangle (or -1 on the hull).
    let e = startEdge;
    do {
      result.push(triangleOfEdge(e));
      const opp = this.delaunay.halfedges[prevHalfEdge(e)];
      if (opp === -1) break;
      e = opp;
    } while (e !== startEdge);

    return result;
  }

  // Voronoi cell polygon for region r (array of {x,y})
  voronoiPolygon(r: number): Point[] {
    return this.trianglesAroundRegion(r).map(t => this.triCenters[t]);
  }

  // Neighbours of region r
  neighborRegions(r: number): number[] {
    const result: number[] = [];
    for (let e = 0; e < this.numEdges; e++) {
      if (this.delaunay.triangles[e] === r) {
        const opp = this.delaunay.halfedges[e];
        if (opp !== -1) {
          result.push(this.delaunay.triangles[opp]);
        }
      }
    }
    return result;
  }

  private _buildTriCenters(): Point[] {
    const { triangles } = this.delaunay;
    const n = triangles.length / 3;
    const centers: Point[] = new Array(n);
    for (let t = 0; t < n; t++) {
      const a = triangles[3 * t];
      const b = triangles[3 * t + 1];
      const c = triangles[3 * t + 2];
      centers[t] = {
        x: (this.points[a].x + this.points[b].x + this.points[c].x) / 3,
        y: (this.points[a].y + this.points[b].y + this.points[c].y) / 3,
      };
    }
    return centers;
  }
}
