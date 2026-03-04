declare module 'delaunator' {
  export default class Delaunator<T extends ArrayLike<number>> {
    static from(coords: ArrayLike<number>): Delaunator<Float64Array>;
    static from<P>(
      points: ArrayLike<P>,
      getX: (p: P) => number,
      getY: (p: P) => number
    ): Delaunator<Float64Array>;

    readonly triangles: Uint32Array;
    readonly halfedges: Int32Array;
    readonly hull: Uint32Array;
    readonly coords: T;

    constructor(coords: T);
    update(): void;
  }
}

declare module 'fast-2d-poisson-disk-sampling' {
  interface PoissonDiskSamplingOptions {
    shape: [number, number];
    minDistance: number;
    maxDistance?: number;
    tries?: number;
  }
  export default class PoissonDiskSampling {
    constructor(options: PoissonDiskSamplingOptions, rng?: () => number);
    fill(): [number, number][];
    reset(): void;
  }
}
