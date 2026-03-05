# Pixeldraw

Procedurally generated pixel-art terrain maps built with TypeScript and Phaser 3.

[Live Demo](https://pixeldraw-livid.vercel.app/) — press SPACE to regenerate

## Quick Start

```bash
npm install
npx vite --port 3000
```

## Architecture

### Generation Pipeline

```
Seed
 └─ TopographyGenerator  — Voronoi mesh + elevation + terrain classification
     └─ HydrologyGenerator  — precipitation → flow → rivers → soil moisture
         ├─ GroundRenderer   — two-phase pixel art terrain rendering
         ├─ TreeRenderer     — procedural tree placement + sprite stamping
         └─ RiverAnimator    — pre-computed river pixels, per-frame animation
              └─ MapScene    — Phaser scene: display, input, overlays
```

### Data Layer (Voronoi mesh)

**TopographyGenerator** — Poisson-disk samples the canvas, builds a Delaunay/Voronoi dual mesh (`DualMesh`), computes per-region elevation via multi-octave simplex noise + island mask, classifies terrain by elevation thresholds. Exposes `elevationAt(x, y, noise)` for per-pixel elevation lookups by downstream renderers.

**HydrologyGenerator** — Simulates terrain hydrology on the Voronoi mesh:
1. Precipitation with westerly-wind rain shadow + orographic uplift
2. Sink filling via priority flood
3. Flow direction (steepest descent) + flow accumulation
4. River network extraction (threshold-based, head-traced)
5. Soil moisture (weighted blend of precipitation, river proximity, drainage)

### Render Layer (pixel art)

**GroundRenderer** — Two-phase pixel renderer (1024x1024):
- Phase 1A: Per-pixel region lookup (`SpatialGrid`) + elevation from noise
- Phase 1B: Slope via central differences (dE/dx, dE/dy)
- Phase 1C: Border distance field (chamfer transform) + neighbor terrain tracking
- Phase 2: Pixel shader — palette lookup (detail noise) + moisture tinting + directional lighting (5-step quantized) + Bayer 4x4 border dithering

**TreeRenderer** — Poisson-disk candidates, filtered by terrain/elevation/moisture, density-modulated. Sorted by Y for painter's algorithm. Shadow pass (elliptical darkening) then sprite pass (directional canopy shading). Deciduous vs conifer blended by elevation.

**RiverAnimator** — Pre-computes river pixel positions + metadata (flow direction, elevation, width tier, phase). Per-frame: sine wave animation, rapids foam sparkles at high elevation, rocks and logs as static decorations.

### Shared Utilities

**utils.ts** — `mulberry32` PRNG, `TerrainType`, `isWater()`, shared constants (`MAP_SCALE`, `RIVER_THRESHOLD`, `LIGHT_DIR_X/Y`)

**SpatialGrid** — Accelerated nearest-Voronoi-region lookup using a 40px uniform grid. O(R) construction, O(1) amortised queries.

**TerrainPalettes** — 5-shade terrain palettes (dark→light), `BAYER_4X4` dither matrix, `packABGR()` / `applyBrightness()` color utilities.

### Scene Layer

**MapScene** — Phaser scene that orchestrates generation, manages the canvas texture + sprite, handles input (scroll, zoom, regenerate), runs the river animation loop, manages debug overlays (moisture/elevation), and highlights the hovered Voronoi region.

## Terrain Types & Elevation Thresholds

| Type | Elevation Range | Description |
|------|----------------|-------------|
| ocean | < 0.25 | Deep water |
| water | 0.25 – 0.32 | Shallow water |
| coast | 0.32 – 0.38 | Beach/shoreline |
| lowland | 0.38 – 0.55 | Grassland/forest floor |
| highland | 0.55 – 0.70 | Dense forest/hills |
| rock | 0.70 – 0.82 | Rocky terrain |
| cliff | >= 0.82 | Mountain peaks |

## Key Technical Details

- **Resolution**: 1024x1024 pixels rasterized, displayed at 2048x2048 world units with `pixelArt: true`
- **Pixel format**: ABGR Uint32 (little-endian ImageData compatibility)
- **Noise seeds**: elevation `seed ^ 0xdeadbeef`, detail `seed ^ 0xcafebabe`, hydrology `seed ^ 0xf100d`
- **Light direction**: upper-left (-0.707, -0.707), 5-step quantized shading
- **River threshold**: flow accumulation >= 25 to form visible river
- **Tree placement**: Poisson-disk (4-12px spacing), filtered by terrain/moisture/elevation

## Controls

| Key | Action |
|-----|--------|
| Arrow keys | Scroll map |
| +/- | Zoom in/out |
| SPACE | Regenerate with new seed |
| 9 | Toggle elevation overlay |
| 0 | Toggle moisture overlay |

## File Map

```
src/
  main.ts                           — Phaser game bootstrap (1024x1024, WebGL)
  scenes/
    MapScene.ts                      — Main scene: generation + display + input
  generators/
    utils.ts                         — Shared PRNG, types, constants
    SpatialGrid.ts                   — Nearest-region lookup acceleration
    DualMesh.ts                      — Delaunay/Voronoi dual mesh
    TopographyGenerator.ts           — Voronoi mesh + elevation + terrain
    HydrologyGenerator.ts            — Precipitation, flow, rivers, moisture
    GroundRenderer.ts                — Two-phase pixel art terrain renderer
    TreeRenderer.ts                  — Procedural tree placement + rendering
    RiverAnimator.ts                 — Animated river pixels (waves, foam, rocks)
    TerrainPalettes.ts               — Color palettes + dither utilities
  types/
    modules.d.ts                     — Type declarations for delaunator, poisson-disk
```

## Dependencies

- **Phaser 3.88** — game framework (WebGL rendering, input, camera)
- **delaunator** — Delaunay triangulation
- **fast-2d-poisson-disk-sampling** — spatial sampling for region centres + tree placement
- **simplex-noise** — multi-octave elevation + detail noise

## Future Work

- Water rendering (waves, shore foam, depth shading)
- Ground details (flowers, small rocks, grass)
- Rock outcrops / cliff faces
- Paths / roads
- River improvements (wider deltas, branching)
