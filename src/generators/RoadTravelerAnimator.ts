/**
 * RoadTravelerAnimator — horse+cart and foot travelers on roads between capitals.
 *
 * Travelers follow the pre-computed road paths (region-index sequences) converted
 * to pixel waypoints. They move at a steady pace, looping back and forth.
 *
 * Horse+cart sprite (5×3):
 *   _ H _ _ _     H = horse head (brown)
 *   H H C C C     C = cart body (wood)
 *   _ L _ W W     L = legs, W = wheels
 *
 * Walking person (2×3):
 *   H _     H = head
 *   B B     B = body
 *   _ L     L = legs
 */

import { mulberry32 } from './TopographyGenerator';
import { TopographyGenerator } from './TopographyGenerator';
import { packABGR } from './TerrainPalettes';
import { Season } from '../state/Season';
import type { RoadSegment } from './RoadGenerator';

// ── Colors ───────────────────────────────────────────────────────────────────
const HORSE_HEAD = packABGR(0x6a, 0x42, 0x22);
const HORSE_BODY = packABGR(0x5a, 0x38, 0x1c);
const HORSE_LEG  = packABGR(0x3a, 0x28, 0x14);
const CART_BODY  = packABGR(0x8a, 0x6c, 0x44);
const CART_WHEEL = packABGR(0x4a, 0x3a, 0x28);
const PERSON_HEAD = packABGR(0xc8, 0xa8, 0x80);
const PERSON_BODY = packABGR(0x4a, 0x5a, 0x78);
const PERSON_LEG  = packABGR(0x5a, 0x48, 0x38);

const _ = -1;

// Horse+cart facing right (5×3)
const CART_RIGHT: { w: number; h: number; cells: number[][] } = {
  w: 5, h: 3,
  cells: [
    [_, 0, _, _, _],
    [0, 1, 2, 2, 2],
    [_, 3, _, 4, 4],
  ],
};
const CART_COLORS_R = [HORSE_HEAD, HORSE_BODY, CART_BODY, HORSE_LEG, CART_WHEEL];

// Horse+cart facing left (5×3)
const CART_LEFT: { w: number; h: number; cells: number[][] } = {
  w: 5, h: 3,
  cells: [
    [_, _, _, 0, _],
    [2, 2, 2, 1, 0],
    [4, 4, _, 3, _],
  ],
};
const CART_COLORS_L = [HORSE_HEAD, HORSE_BODY, CART_BODY, HORSE_LEG, CART_WHEEL];

// Person facing right (2×3)
const PERSON_RIGHT: { w: number; h: number; cells: number[][] } = {
  w: 2, h: 3,
  cells: [
    [0, _],
    [1, 1],
    [_, 2],
  ],
};
const PERSON_COLORS_R = [PERSON_HEAD, PERSON_BODY, PERSON_LEG];

// Person facing left (2×3)
const PERSON_LEFT: { w: number; h: number; cells: number[][] } = {
  w: 2, h: 3,
  cells: [
    [_, 0],
    [1, 1],
    [2, _],
  ],
};
const PERSON_COLORS_L = [PERSON_HEAD, PERSON_BODY, PERSON_LEG];

// ── Waypoint ─────────────────────────────────────────────────────────────────
interface Waypoint {
  px: number;
  py: number;
}

// ── Traveler ─────────────────────────────────────────────────────────────────
interface Traveler {
  waypoints: Waypoint[];
  totalDist: number;       // total path length in pixels
  speed: number;           // pixels per millisecond
  offset: number;          // starting position offset along path (0..totalDist)
  isCart: boolean;
}

// ── Public ───────────────────────────────────────────────────────────────────
export class RoadTravelerAnimator {
  extrusionMap: Int16Array | null = null;

  private _travelers: Traveler[] = [];
  private _N: number;
  private _season: Season;
  private _dirty: { screenIdx: number; srcIdx: number; color: number }[] = [];

  constructor(
    roads: RoadSegment[],
    topo: TopographyGenerator,
    N: number,
    pixels: Uint32Array,
    seed: number,
    season: Season,
  ) {
    this._N = N;
    this._season = season;

    const rng = mulberry32(seed ^ 0x72a0e001);
    const scale = topo.size / N;
    const points = topo.mesh.points;

    for (const road of roads) {
      if (road.path.length < 3) continue;

      // Convert region path to pixel waypoints
      const waypoints: Waypoint[] = road.path.map(r => ({
        px: Math.floor(points[r].x / scale),
        py: Math.floor(points[r].y / scale),
      }));

      // Compute total distance
      let totalDist = 0;
      for (let i = 1; i < waypoints.length; i++) {
        const dx = waypoints[i].px - waypoints[i - 1].px;
        const dy = waypoints[i].py - waypoints[i - 1].py;
        totalDist += Math.sqrt(dx * dx + dy * dy);
      }

      if (totalDist < 20) continue;

      // Each road gets a horse+cart
      this._travelers.push({
        waypoints,
        totalDist,
        speed: 0.008 + rng() * 0.004,  // ~8-12 px/sec
        offset: rng() * totalDist,
        isCart: true,
      });

      // 50% chance of a walking person on the same road
      if (rng() > 0.5) {
        this._travelers.push({
          waypoints,
          totalDist,
          speed: 0.004 + rng() * 0.002,  // ~4-6 px/sec (slower)
          offset: rng() * totalDist,
          isCart: false,
        });
      }
    }
  }

  animate(pixels: Uint32Array, timeMs: number): void {
    const N = this._N;
    const ext = this.extrusionMap;

    // 1. Restore pixels from last frame
    for (const d of this._dirty) {
      pixels[d.screenIdx] = d.color;
    }
    this._dirty = [];
    // Track which screen pixels have already been saved this frame so we never
    // overwrite the first (original) color with a cart color on a second hit.
    const savedThisFrame = new Set<number>();

    // No travelers in winter
    if (this._season === Season.Winter) return;

    // 2. Draw each traveler
    for (const t of this._travelers) {
      // Ping-pong along the path
      const rawDist = (t.offset + timeMs * t.speed) % (t.totalDist * 2);
      const dist = rawDist <= t.totalDist ? rawDist : t.totalDist * 2 - rawDist;
      const goingForward = rawDist <= t.totalDist;

      // Find position along path
      let remaining = dist;
      let posX = t.waypoints[0].px;
      let posY = t.waypoints[0].py;
      let segDx = 0, segDy = 0;

      for (let i = 1; i < t.waypoints.length; i++) {
        const dx = t.waypoints[i].px - t.waypoints[i - 1].px;
        const dy = t.waypoints[i].py - t.waypoints[i - 1].py;
        const segLen = Math.sqrt(dx * dx + dy * dy);
        if (remaining <= segLen) {
          const frac = segLen > 0 ? remaining / segLen : 0;
          posX = Math.round(t.waypoints[i - 1].px + dx * frac);
          posY = Math.round(t.waypoints[i - 1].py + dy * frac);
          segDx = dx;
          segDy = dy;
          break;
        }
        remaining -= segLen;
        posX = t.waypoints[i].px;
        posY = t.waypoints[i].py;
        segDx = dx;
        segDy = dy;
      }

      // Determine facing from travel direction
      const facingRight = goingForward ? segDx >= 0 : segDx < 0;

      // Pick sprite
      let sprite: { w: number; h: number; cells: number[][] };
      let colors: number[];
      if (t.isCart) {
        sprite = facingRight ? CART_RIGHT : CART_LEFT;
        colors = facingRight ? CART_COLORS_R : CART_COLORS_L;
      } else {
        sprite = facingRight ? PERSON_RIGHT : PERSON_LEFT;
        colors = facingRight ? PERSON_COLORS_R : PERSON_COLORS_L;
      }

      // Stamp sprite centered on position
      const startX = posX - Math.floor(sprite.w / 2);
      const startY = posY - Math.floor(sprite.h / 2);

      for (let row = 0; row < sprite.h; row++) {
        for (let col = 0; col < sprite.w; col++) {
          const cell = sprite.cells[row][col];
          if (cell === _) continue;

          const px = startX + col;
          const py = startY + row;
          if (px < 0 || px >= N || py < 0 || py >= N) continue;

          const srcIdx = py * N + px;
          const screenIdx = this._screenIdx(srcIdx, N, ext);
          if (screenIdx < 0) continue;

          // Save original color for restore — only once per screenIdx per frame.
          // A second hit would save a cart color, causing a persistent artifact.
          if (!savedThisFrame.has(screenIdx)) {
            this._dirty.push({ screenIdx, srcIdx, color: pixels[screenIdx] });
            savedThisFrame.add(screenIdx);
          }
          pixels[screenIdx] = colors[cell];
        }
      }
    }
  }

  private _screenIdx(srcIdx: number, N: number, ext: Int16Array | null): number {
    if (!ext) return srcIdx;
    const px = srcIdx % N;
    const py = (srcIdx - px) / N;
    const screenY = py - ext[srcIdx];
    if (screenY < 0 || screenY >= N) return -1;
    return screenY * N + px;
  }
}
