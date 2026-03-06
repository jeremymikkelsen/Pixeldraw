# Pixeldraw: Medieval Duchy Management Game — Master Plan

## Context

Pixeldraw is evolving from a procedural terrain generator into a full turn-based medieval duchy management game. The player controls one of 9 duchies on a procedurally generated island, managing economics, population, resources, and diplomacy under a king. The game emphasizes realistic economic constraints, seasonal cycles, and the tension between different economic paradigms (control, incentive, market). The aesthetic is pixel-art with animated elements, ambient audio, and an atmospheric "escapist" feel.

---

## Current State (Already Implemented)

The terrain engine is largely complete (~3,600 lines across 13 files):

- **Voronoi terrain generation** — TopographyGenerator, DualMesh, ~3000-5000 regions
- **Hydrology** — rain shadow, rivers, flow accumulation, moisture
- **Ground rendering** — biome colors, slope lighting, moisture tinting
- **Coastal rendering** — beaches, sea stacks, sparkles, wave animation
- **River animation** — flowing water, rapids, foam, rocks, logs
- **River deltas** — distributary channels, harbors, marshes at river mouths
- **Trees** — Poisson-sampled deciduous + conifer with shadows, directional lighting
- **Mountain extrusion** — faux-3D displacement, snow peaks, exposed rock, cliff faces
- **Camera** — keyboard + touch pan/zoom, mobile-friendly
- **Debug overlays** — elevation, moisture, air moisture
- **Region hover** — extrusion-aware mouse-to-tile mapping via screenToSource

**What does NOT exist yet**: game state, entity system, buildings, duchies, UI, turns, economy, population, save/load, audio, multiplayer. The codebase is purely a terrain renderer.

**Tech stack**: Phaser 3.88 + TypeScript + Vite. Map is a single 1536x1536 Uint32Array pixel buffer displayed as a Phaser Sprite.

---

## Phase 1: Game State Foundation + Duchies + Basic UI

**Milestone**: 9 colored duchy territories on the map. Click a tile to see info. "End Turn" advances the season. Season displayed in top bar.

### 1.1 Architecture — New Files

```
src/
  state/
    GameState.ts          — Central game state (serializable, separate from rendering)
    Season.ts             — Season enum + helpers
    Duchy.ts              — Duchy data model
    DuchyGenerator.ts     — Duchy placement algorithm
    ResourceTypes.ts      — Resource enums (food, wood, stone, etc.)
  renderers/
    DuchyRenderer.ts      — Duchy boundary + territory tint overlay
  ui/
    UIManager.ts          — DOM-based UI coordinator
    TopBar.ts             — Season, year, duchy crest, food counter
    ContextPanel.ts       — Bottom panel: tile info, options
```

### 1.2 GameState (Central State Object)

```typescript
interface GameState {
  seed: number;
  turn: number;             // 0-indexed absolute turn
  season: Season;           // Spring | Summer | Fall | Winter
  year: number;             // floor(turn / 4) + 1
  topo: TopographyGenerator;
  hydro: HydrologyGenerator;
  duchies: Duchy[];         // 9 duchies
  regionToDuchy: Int8Array; // per-region: duchy index or -1
}
```

- Created by factory `createGameState(seed)` that runs TopographyGenerator + HydrologyGenerator + DuchyGenerator
- Pure data — renderers read state, never own it
- Serializable (for future save/load and multiplayer)
- Refactor MapScene._generateMap to separate state creation from rendering

### 1.3 DuchyGenerator Algorithm

1. Filter valid land regions (lowland/highland/coast, not ocean/water/rock/cliff)
2. Tag regions with river access (appears in hydro.rivers paths) and forest (elevation in tree range)
3. Place 9 seeds on ~3x3 grid, each near rivers and forests
4. Simultaneous BFS growth (round-robin, 1 region per duchy per step) to 10 regions each
5. Validate: each duchy has river tile + forested tile + export tile (coast or major river)
6. Build regionToDuchy Int8Array

Needs: `DualMesh.neighborRegions(r)` for adjacency. Extract `HydrologyGenerator._buildAdjacency()` into shared `src/utils/adjacency.ts`.

### 1.4 DuchyRenderer

- **Territory tint**: blend 15-20% duchy color into ground pixels (using regionGrid for lookup)
- **Boundary lines**: 2px border between different-duchy regions (check 4-neighbors)
- Runs after GroundRenderer, before TreeRenderer in pipeline

### 1.5 UI (DOM-based, not Phaser)

DOM for proper mobile layout (CSS flexbox, media queries, pixel font).

- **TopBar** (fixed top): "Year 1, Spring" | duchy crest | food placeholder
- **ContextPanel** (slides from bottom on mobile, sidebar on desktop): terrain type, duchy name, elevation
- **End Turn button**: advances season, updates top bar
- **UIManager**: bridges Phaser pointer events → DOM updates

### 1.6 MapScene Refactoring

Split `_generateMap` into:
- `_initializeGame(seed)` — creates GameState
- `_renderMap()` — produces pixel buffer from state (calls all renderers)

### 1.7 Verification
- Run `npm run dev`, see 9 colored duchy territories with borders
- Click a tile → context panel shows duchy name + terrain info
- Click "End Turn" → season advances in top bar

---

## Phase 2: Visual Tweaks + Seasonal Rendering

**Milestone**: End Turn cycles through visually distinct seasons. Conifers are taller. Ground dithering removed.

### Features
- **Season enum** drives palette selection for all renderers
- **Spring**: extra green grass, pink blossoms on ~15% of deciduous trees, snow on hilltops
- **Summer**: yellowing grass in dry areas, lighter ocean, snow only on highest peaks
- **Fall**: orange/red/yellow deciduous canopies, normal snow
- **Winter**: snow everywhere (gradient by elevation), bare deciduous trees, choppy ocean with whitecaps
- **Conifer trees ~2x taller** (verify/adjust templates in TreeRenderer)
- **Remove ground transition dithering** (ensure palette index per-region, not per-pixel at boundaries)

### Modified Files
- `GroundRenderer.ts` — accept Season, adjust palettes
- `TreeRenderer.ts` — seasonal palette variants, bare winter trees, spring blossoms
- `MountainRenderer.ts` — adjust snow line by season
- `CoastalRenderer.ts` — winter whitecaps, summer lighter water

### Verification
- Cycle through 4 seasons, visually confirm each looks distinct
- Trees change: blossoms → green → fall colors → bare branches
- Snow coverage changes with season

---

## Phase 3: Roads, Trails, and Basic Buildings

**Milestone**: Stone roads connect duchy capitals. Manor houses on capital tiles. Small houses and starting fields visible.

### Features
- **Major roads**: A* pathfinding between duchy capitals over Voronoi adjacency. 4px gray cobblestone, slight color variation. Built on cell edges, rounded corners.
- **Trails**: 1px brown dirt paths auto-generated from buildings. Variable color.
- **Bridges**: small stone/wood arch where roads cross rivers
- **Manor houses**: ~20x20px procedural pixel art, duchy-colored flags/crests
- **Small houses**: ~5x7px (tree-sized), duchy-colored roof accents
- **Starting pasture + field**: simple fenced/tilled areas

### New Files
- `src/state/Building.ts` — building type enum, instance data
- `src/state/Road.ts` — road segment data
- `src/generators/RoadGenerator.ts` — A* pathfinding on Voronoi adjacency
- `src/renderers/RoadRenderer.ts` — draws roads, trails, bridges on pixel buffer
- `src/renderers/BuildingRenderer.ts` — procedural building sprites + painter's algorithm

### Verification
- Roads visibly connect all 9 duchy capitals
- Manor houses fill capital tiles with duchy-colored details
- Small houses, pasture, field visible in each duchy

---

## Phase 4: Agriculture + Forestry Visuals

**Milestone**: Fields show seasonal crop growth. Pastures have fences and cows. Orchards bloom and bear fruit. Woodcutters fell trees.

### Features
- **Grain fields**: spring sprouts → summer rows → fall golden harvest → winter fallow
- **Pumpkin fields**: same cycle with orange pumpkins in fall
- **Pastures**: cedar split-rail fences, small cow sprites, seasonal behavior (barn vs muddy in winter)
- **Apple orchards**: 2 rows, 6 trees/tile. Spring pink flowers → summer red apples → fall picking (ladders) → winter bare
- **Woodcutter camps**: working radius overlay on hover, tree felling visual
- **Firewood cycle**: summer felled tree → fall stacks → winter depleted → spring gone
- **Forest growth**: sapling → small tree → big tree over 40 turns

### New Files
- `src/renderers/FieldRenderer.ts` — crop field seasonal sprites
- `src/renderers/PastureRenderer.ts` — fences, cows, hay, barns
- `src/renderers/OrchardRenderer.ts` — fruit tree seasonal sprites
- `src/state/Agriculture.ts` — per-region crop/growth data
- `src/state/Forestry.ts` — tree age, cutting state

---

## Phase 5: Core Economy + Population + UI

**Milestone**: Duchies have populations that consume food. Resources tracked. Building placement via UI. Resource panels visible.

### Features
- **Food system**: production, consumption, spoilage, corruption, animal theft
- **Non-food resources**: production, building use, processing, corruption
- **Population classes**: serf, indentured servant, free citizen, merchant
- **Three economic paradigms**: control, incentive, market (affects UI interaction model)
- **Transport**: river/road distance calculations for resource movement
- **Soil fertility**: depletion from crops, restoration from pasture/fallow

### New Files
- `src/state/Economy.ts` — resource stocks, production/consumption rates, spoilage
- `src/state/Population.ts` — population model, class transitions
- `src/state/EconomyParadigm.ts` — three modes affecting mechanics
- `src/ui/BuildMenu.ts` — building placement with valid tile highlighting
- `src/ui/ResourcePanel.ts` — food/resource flow display

---

## Phase 6: Processing Buildings + Animations

**Milestone**: Windmills spin, waterwheels turn, charcoal burners smoke. Full production chain from raw to processed goods.

### Features
- **Windmill**: animated Dutch-style spinning blades. Processes grain/timber/ore.
- **Water mill**: dam on river, waterwheel animation, pond upstream (2-4 tiles), sparkly water at base
- **Charcoal burner**: spring stacking → summer burning (smoke column) → fall unloading → winter idle. Soot spreads 10 tiles east over years.
- **Smelter**: orange forge glow, smoke every season
- All processing buildings: creamery, loom, butcher, smoker, tanner, smithy, shipyard, cider press, winery, meadery
- **Markets**: supply/demand pricing, transport costs

### New Files
- `src/renderers/AnimatedBuildingRenderer.ts` — per-frame windmill/waterwheel/smoke
- `src/state/ProductionChain.ts` — directed graph of resource transformations

---

## Phase 7: Military + King + Diplomacy

**Milestone**: King levies soldiers. Wars happen. Win/loss conditions work.

### Features
- King personality system (from pixelduchy codebase)
- Soldier levying (serfs=fodder, trained soldiers=effective)
- War events, land grants for iron/weapons/ships
- Win: conquer all duchies or king appoints successor
- Loss: die in battle or total collapse
- Military buildings: training grounds, barracks, guard towers, motte and bailey, stone keep

### New Files
- `src/state/King.ts`, `src/state/Diplomacy.ts`, `src/state/Military.ts`, `src/state/Combat.ts`

---

## Phase 8: Secret Resources + Random Events

**Milestone**: Hidden resources discoverable via pixel clues or prospecting. Random events challenge the player.

### Features
- 10 secret resources (gold, coal, iron ore, bog iron, wild fruit, fishery, slate, natural spring, hunting grounds, guano)
- Telltale pixels placed during terrain generation
- Prospecting mechanic via miner worker
- Random events: flooding, fire, plague, rats, pests, orchard bugs

### New Files
- `src/state/SecretResources.ts`, `src/state/Events.ts`

---

## Phase 9: AI Opponents

**Milestone**: AI duchies make decisions each turn. Single-player is playable.

### Features
- AI duchy management (build, produce, trade, military)
- Priority: feed population → build economy → military → expansion
- Free market AI: 1/4 of people check market each season, build toward demand

### New Files
- `src/ai/DuchyAI.ts`, `src/ai/EconomyAI.ts`, `src/ai/MilitaryAI.ts`

---

## Phase 10: Audio

**Milestone**: Ambient sounds contextual to camera position. Voice lines on events.

### Features
- Context-sensitive ambient: wind, rivers, mills, cows, mining, chopping, people murmurs
- Voice lines: "Feed your people my lord", "Chop chop", house-specific sayings
- Volume scales with zoom level and feature proximity

### New Files
- `src/audio/AudioManager.ts`, `src/audio/AmbientMixer.ts`

---

## Phase 11: Settings + Save/Load + Polish

**Milestone**: Full pre-game settings. Save/load. Performance optimization.

### Features
- Map seed input with preview
- Sliders for generation params (moisture, rivers, resource density)
- King selection, house selection (3 free, rest IAP)
- Alcohol toggle (wine/mead/cider → juice variants)
- Save/load via localStorage/IndexedDB
- Serialize GameState (typed arrays → base64, re-derive topo/hydro from seed)

---

## Phase 12: Multiplayer

**Milestone**: Multiple players via Supabase. Turn sync waits for all.

### Features
- Supabase Realtime for presence + turn sync
- Only player actions transmitted (deterministic state from seed + actions)
- AI controls non-player duchies

---

## Phase Dependencies

```
Phase 1 (State + Duchies + UI)  ← FOUNDATION, everything depends on this
  ├→ Phase 2 (Seasons)
  └→ Phase 3 (Roads + Buildings)
       └→ Phase 4 (Agriculture + Forestry)
            └→ Phase 5 (Economy + Population)
                 ├→ Phase 6 (Processing + Animations)
                 │    └→ Phase 7 (Military + King)
                 │         └→ Phase 8 (Secrets + Events)
                 │              └→ Phase 9 (AI)
                 └→ Phase 11 (Settings + Save/Load)
Phase 10 (Audio) — can start after Phase 6
Phase 12 (Multiplayer) — requires Phase 9
```

---

## Items Needing Discussion

1. **Building styles per house** — How distinctive should each house's buildings look? Just roof color + wall texture, or fundamentally different shapes?
2. **Map size** — Currently 1536px render / 3072 world. User note #25 says "double" but we already doubled from original. Confirm if another doubling is needed.
3. **pixelduchy codebase** — Need access to import house names, king personalities, duke/duchess data
4. **Pixel font** — User asked "let me know if I need to find a font." Yes, we'll need one for the pixel UI aesthetic.
5. **Building scale** — "We'll evaluate map size and scale as we get buildings designed." Need to prototype and iterate.
6. **Vineyards** — User note says "more labor intensive" but no specific mechanic. Define during Phase 4.
7. **Horse training** — Listed as "advanced tract" but mechanics not specified.
8. **IAP integration** — What platform? Web-only or also mobile app stores?

---

## Key Files to Modify

| File | Changes |
|------|---------|
| `src/scenes/MapScene.ts` | Refactor to use GameState, wire up UI events, integrate DuchyRenderer |
| `src/generators/GroundRenderer.ts` | Accept Season param, duchy overlay data |
| `src/generators/DualMesh.ts` | neighborRegions used by DuchyGenerator + RoadGenerator |
| `src/generators/HydrologyGenerator.ts` | Extract adjacency builder to shared utility |
| `src/generators/TreeRenderer.ts` | Seasonal palettes, conifer height |
| `src/generators/MountainRenderer.ts` | Season-dependent snow line |
| `src/generators/TerrainPalettes.ts` | Seasonal palette variants |
