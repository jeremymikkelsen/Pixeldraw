import { createNoise2D } from 'simplex-noise';
import { TopographyGenerator, mulberry32, TerrainType } from './TopographyGenerator';
import { HydrologyGenerator } from './HydrologyGenerator';
import { packABGR, applyBrightness } from './TerrainPalettes';

// ---------------------------------------------------------------------------
// River delta and protected harbor generation at major river mouths
// ---------------------------------------------------------------------------

// Colors
const MARSH_COLORS = [0x4a6830, 0x587838, 0x5a8040, 0x688848];
const SAND_DUNE_COLORS = [0xc0a870, 0xd0b880, 0xdcc890, 0xe8d8a0];
const DELTA_WATER = [0x2a6888, 0x347a9e, 0x3a8aaa];
const MUD_COLORS = [0x6a5c40, 0x786848, 0x887850];

// ---------------------------------------------------------------------------
// RiverDeltaRenderer
// ---------------------------------------------------------------------------
export class RiverDeltaRenderer {

  render(
    pixels: Uint32Array,
    topo: TopographyGenerator,
    hydro: HydrologyGenerator,
    resolution: number,
    seed: number,
  ): void {
    const rng = mulberry32(seed ^ 0xde17a);
    const rngNoise = mulberry32(seed ^ 0x71de);
    const noise = createNoise2D(rngNoise);
    const N = resolution;
    const scale = topo.size / N;
    const { points } = topo.mesh;

    // Find river mouths: last land region before ocean in each river
    const mouths: { px: number; py: number; flow: number; dirX: number; dirY: number }[] = [];

    for (const path of hydro.rivers) {
      if (path.length < 5) continue; // only rivers of meaningful length

      // Find the river mouth (last land cell)
      let mouthIdx = -1;
      for (let i = path.length - 1; i >= 0; i--) {
        const t = topo.terrainType[path[i]];
        if (t !== 'ocean' && t !== 'water') {
          mouthIdx = i;
          break;
        }
      }
      if (mouthIdx < 0) continue;

      const rMouth = path[mouthIdx];
      const px = Math.floor(points[rMouth].x / scale);
      const py = Math.floor(points[rMouth].y / scale);
      const flow = hydro.flowAccumulation[rMouth];

      // Only significant rivers get deltas
      if (flow < 80) continue;

      // Compute river direction at mouth
      const lookback = Math.min(3, mouthIdx);
      const rUpstream = path[mouthIdx - lookback];
      const dirX = points[rMouth].x - points[rUpstream].x;
      const dirY = points[rMouth].y - points[rUpstream].y;
      const len = Math.sqrt(dirX * dirX + dirY * dirY) || 1;

      mouths.push({
        px, py,
        flow,
        dirX: dirX / len,
        dirY: dirY / len,
      });
    }

    // Render each river mouth
    for (const mouth of mouths) {
      if (mouth.flow > 150) {
        // Large river: delta or harbor
        if (rng() < 0.5) {
          this._renderDelta(pixels, mouth, N, rng, noise);
        } else {
          this._renderHarbor(pixels, mouth, N, rng, noise);
        }
      } else {
        // Medium river: small delta/marsh
        this._renderSmallDelta(pixels, mouth, N, rng, noise);
      }
    }
  }

  // -----------------------------------------------------------------------
  // River delta: multiple channels, marsh, jutting into water
  // -----------------------------------------------------------------------
  private _renderDelta(
    pixels: Uint32Array,
    mouth: { px: number; py: number; flow: number; dirX: number; dirY: number },
    N: number,
    rng: () => number,
    noise: (x: number, y: number) => number,
  ): void {
    const { px, py, dirX, dirY, flow } = mouth;
    const deltaSize = Math.floor(10 + (flow / 300) * 15);

    // Draw multiple distributary channels
    const channelCount = 3 + Math.floor(rng() * 3);
    for (let c = 0; c < channelCount; c++) {
      const spreadAngle = (c / (channelCount - 1) - 0.5) * 1.2;
      const cdx = dirX * Math.cos(spreadAngle) - dirY * Math.sin(spreadAngle);
      const cdy = dirX * Math.sin(spreadAngle) + dirY * Math.cos(spreadAngle);

      let x = px, y = py;
      const length = deltaSize * (0.6 + rng() * 0.6);

      for (let step = 0; step < length; step++) {
        const ix = Math.floor(x);
        const iy = Math.floor(y);
        if (ix < 0 || ix >= N || iy < 0 || iy >= N) break;

        // Water channel
        const waterWidth = Math.max(1, 2 - Math.floor(step / (length * 0.5)));
        for (let w = -waterWidth; w <= waterWidth; w++) {
          const wx = ix + Math.floor(cdy * w);
          const wy = iy - Math.floor(cdx * w);
          if (wx >= 0 && wx < N && wy >= 0 && wy < N) {
            const ci = Math.floor(rng() * DELTA_WATER.length);
            pixels[wy * N + wx] = applyBrightness(DELTA_WATER[ci], 0.8 + rng() * 0.2);
          }
        }

        // Marsh/mud on either side
        for (let w = -3; w <= 3; w++) {
          if (Math.abs(w) <= waterWidth) continue;
          const mx = ix + Math.floor(cdy * w);
          const my = iy - Math.floor(cdx * w);
          if (mx >= 0 && mx < N && my >= 0 && my < N) {
            const nv = noise(mx * 0.1, my * 0.1);
            if (nv > -0.2) {
              const colors = nv > 0.3 ? MARSH_COLORS : MUD_COLORS;
              const ci = Math.floor(rng() * colors.length);
              pixels[my * N + mx] = applyBrightness(colors[ci], 0.75 + rng() * 0.25);
            }
          }
        }

        x += cdx;
        y += cdy;
        // Add slight meander
        x += noise(x * 0.05, y * 0.05) * 0.5;
        y += noise(x * 0.05 + 100, y * 0.05) * 0.5;
      }
    }

    // Sand dunes at the outer edge
    for (let i = 0; i < deltaSize * 3; i++) {
      const angle = rng() * Math.PI * 2;
      const dist = deltaSize * (0.7 + rng() * 0.4);
      const dx = px + Math.floor(dirX * dist + Math.cos(angle) * 3);
      const dy = py + Math.floor(dirY * dist + Math.sin(angle) * 3);
      if (dx >= 0 && dx < N && dy >= 0 && dy < N) {
        const ci = Math.floor(rng() * SAND_DUNE_COLORS.length);
        pixels[dy * N + dx] = applyBrightness(SAND_DUNE_COLORS[ci], 0.85 + rng() * 0.15);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Protected harbor: sand barriers creating enclosed shallow water
  // -----------------------------------------------------------------------
  private _renderHarbor(
    pixels: Uint32Array,
    mouth: { px: number; py: number; flow: number; dirX: number; dirY: number },
    N: number,
    rng: () => number,
    noise: (x: number, y: number) => number,
  ): void {
    const { px, py, dirX, dirY, flow } = mouth;
    const harborSize = Math.floor(8 + (flow / 300) * 12);

    // Sand barrier arcs on either side of the river mouth
    const perpX = -dirY;
    const perpY = dirX;

    for (let side = -1; side <= 1; side += 2) {
      const armLength = harborSize * (0.8 + rng() * 0.4);
      const curveAmount = 0.08 + rng() * 0.06;

      let x = px + side * perpX * 3;
      let y = py + side * perpY * 3;
      let angle = Math.atan2(dirY, dirX) + side * 0.3;

      for (let step = 0; step < armLength; step++) {
        const ix = Math.floor(x);
        const iy = Math.floor(y);
        if (ix < 0 || ix >= N || iy < 0 || iy >= N) break;

        // Sand barrier (2-3 pixels wide)
        for (let w = -1; w <= 1; w++) {
          const sx = ix + Math.floor(perpX * w * 0.5);
          const sy = iy + Math.floor(perpY * w * 0.5);
          if (sx >= 0 && sx < N && sy >= 0 && sy < N) {
            const ci = Math.floor(rng() * SAND_DUNE_COLORS.length);
            pixels[sy * N + sx] = applyBrightness(SAND_DUNE_COLORS[ci], 0.85 + rng() * 0.15);
          }
        }

        // Curve inward to form harbor mouth
        angle += -side * curveAmount;
        x += Math.cos(angle);
        y += Math.sin(angle);
      }
    }

    // Tidal marsh areas near the harbor
    for (let i = 0; i < harborSize * 4; i++) {
      const angle = rng() * Math.PI * 2;
      const dist = rng() * harborSize * 0.6;
      const mx = Math.floor(px + perpX * dist * Math.cos(angle) + dirX * 2);
      const my = Math.floor(py + perpY * dist * Math.cos(angle) + dirY * 2);
      if (mx >= 0 && mx < N && my >= 0 && my < N) {
        const nv = noise(mx * 0.1, my * 0.1);
        if (nv > 0) {
          const ci = Math.floor(rng() * MARSH_COLORS.length);
          pixels[my * N + mx] = applyBrightness(MARSH_COLORS[ci], 0.75 + rng() * 0.25);
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Small delta: simple marsh at medium river mouths
  // -----------------------------------------------------------------------
  private _renderSmallDelta(
    pixels: Uint32Array,
    mouth: { px: number; py: number; flow: number; dirX: number; dirY: number },
    N: number,
    rng: () => number,
    noise: (x: number, y: number) => number,
  ): void {
    const { px, py, dirX, dirY } = mouth;
    const size = 5 + Math.floor(rng() * 5);

    // Small marsh/mud area at mouth
    for (let dy = -size; dy <= size; dy++) {
      for (let dx = -size; dx <= size; dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > size) continue;

        // Bias toward the river direction
        const proj = dx * dirX + dy * dirY;
        if (proj < -2) continue; // don't go too far upstream

        const mx = px + dx;
        const my = py + dy;
        if (mx < 0 || mx >= N || my < 0 || my >= N) continue;

        const nv = noise(mx * 0.1, my * 0.1);
        if (nv > -0.3 && rng() < 0.7) {
          const colors = nv > 0.2 ? MARSH_COLORS : MUD_COLORS;
          const ci = Math.floor(rng() * colors.length);
          pixels[my * N + mx] = applyBrightness(colors[ci], 0.75 + rng() * 0.25);
        }
      }
    }
  }
}
