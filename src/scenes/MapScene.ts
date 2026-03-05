import Phaser from 'phaser';
import { TopographyGenerator } from '../generators/TopographyGenerator';
import { GroundRenderer } from '../generators/GroundRenderer';
import { HydrologyGenerator } from '../generators/HydrologyGenerator';
import { TreeRenderer } from '../generators/TreeRenderer';
import { RiverAnimator } from '../generators/RiverAnimator';
import { CoastalRenderer } from '../generators/CoastalRenderer';
import { MountainRenderer } from '../generators/MountainRenderer';
import { RiverDeltaRenderer } from '../generators/RiverDeltaRenderer';

const MAP_SIZE = 3072;
const PIXEL_RESOLUTION = 1536;

const SCROLL_SPEED = 300;
const ZOOM_SPEED = 0.03;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

export class MapScene extends Phaser.Scene {
  private mapSprite!: Phaser.GameObjects.Sprite;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private plusKey!: Phaser.Input.Keyboard.Key;
  private minusKey!: Phaser.Input.Keyboard.Key;
  private eqKey!: Phaser.Input.Keyboard.Key;

  // Persistent refs for river animation
  private _pixels!: Uint32Array;
  private _canvasTex!: Phaser.Textures.CanvasTexture;
  private _imageData!: ImageData;
  private _ctx!: CanvasRenderingContext2D;
  private _riverAnimator!: RiverAnimator;
  private _coastalRenderer!: CoastalRenderer;

  // Region hover highlight
  private _regionGrid!: Uint16Array | null;
  private _hoveredRegion = -1;
  private _highlightIndices: number[] = [];

  // Debug overlays
  private _moistureOverlay!: Uint32Array | null;
  private _elevationOverlay!: Uint32Array | null;
  private _airMoistureOverlay!: Uint32Array | null;
  private _activeOverlay: 'none' | 'moisture' | 'elevation' | 'airMoisture' = 'none';

  // Touch/mobile state
  private _isTouchDevice = false;
  private _lastPinchDist = 0;
  private _isDragging = false;
  private _dragStartX = 0;
  private _dragStartY = 0;
  private _camStartX = 0;
  private _camStartY = 0;

  constructor() {
    super({ key: 'MapScene' });
  }

  create(): void {
    this._generateMap(Date.now());

    // Camera setup
    const cam = this.cameras.main;
    cam.setBounds(0, 0, MAP_SIZE, MAP_SIZE);
    cam.centerOn(MAP_SIZE / 2, MAP_SIZE / 2);

    // Input — use =/- keys (regular keyboard, not numpad-only)
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.plusKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.PLUS);
    this.minusKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.MINUS);
    this.eqKey = this.input.keyboard!.addKey(187);  // =/+ key on US keyboards

    this.input.keyboard!.on('keydown-SPACE', () => {
      this._generateMap(Date.now());
    });

    this.input.keyboard!.on('keydown-ZERO', () => {
      this._activeOverlay = this._activeOverlay === 'moisture' ? 'none' : 'moisture';
    });

    this.input.keyboard!.on('keydown-NINE', () => {
      this._activeOverlay = this._activeOverlay === 'elevation' ? 'none' : 'elevation';
    });

    this.input.keyboard!.on('keydown-EIGHT', () => {
      this._activeOverlay = this._activeOverlay === 'airMoisture' ? 'none' : 'airMoisture';
    });

    // Touch / mobile support
    this._isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    this._setupTouchControls();

    // HUD text (fixed to camera via setScrollFactor)
    const hudLabel = this._isTouchDevice
      ? 'Drag to pan · Pinch to zoom · Buttons at bottom-right'
      : 'ARROWS scroll · +/- zoom · SPACE regenerate · 9 elevation · 0 moisture';
    this.add.text(8, 8, hudLabel, {
      fontSize: '13px',
      color: '#ffffff',
      backgroundColor: '#00000088',
      padding: { x: 6, y: 4 },
    }).setDepth(10).setScrollFactor(0);
  }

  update(time: number, delta: number): void {
    const cam = this.cameras.main;
    const dt = delta / 1000;
    const speed = SCROLL_SPEED / cam.zoom;

    // Arrow key scrolling
    if (this.cursors.left.isDown)  cam.scrollX -= speed * dt;
    if (this.cursors.right.isDown) cam.scrollX += speed * dt;
    if (this.cursors.up.isDown)    cam.scrollY -= speed * dt;
    if (this.cursors.down.isDown)  cam.scrollY += speed * dt;

    // +/- zoom (numpad plus OR =/+ key)
    if (this.plusKey.isDown || this.eqKey.isDown) cam.zoom = Math.min(MAX_ZOOM, cam.zoom * (1 + ZOOM_SPEED));
    if (this.minusKey.isDown) cam.zoom = Math.max(MIN_ZOOM, cam.zoom * (1 - ZOOM_SPEED));

    // Animate rivers
    if (this._riverAnimator) {
      const overlayBuf = this._activeOverlay === 'moisture' ? this._moistureOverlay
        : this._activeOverlay === 'elevation' ? this._elevationOverlay
        : this._activeOverlay === 'airMoisture' ? this._airMoistureOverlay
        : null;
      const src = overlayBuf ?? this._pixels;

      if (!overlayBuf) {
        this._riverAnimator.animate(this._pixels, time);
        if (this._coastalRenderer) {
          this._coastalRenderer.animate(this._pixels, time);
        }
      }

      new Uint8ClampedArray(this._imageData.data.buffer)
        .set(new Uint8Array(src.buffer));

      // Region hover highlight
      this._updateHoveredRegion();
      if (this._highlightIndices.length > 0) {
        const data = this._imageData.data;
        for (let k = 0; k < this._highlightIndices.length; k++) {
          const off = this._highlightIndices[k] << 2;
          data[off]     = Math.min(255, data[off]     + 25);
          data[off + 1] = Math.min(255, data[off + 1] + 25);
          data[off + 2] = Math.min(255, data[off + 2] + 25);
        }
      }

      this._ctx.putImageData(this._imageData, 0, 0);
      this._canvasTex.refresh();
    }
  }

  private _setupTouchControls(): void {
    const canvas = this.game.canvas;

    // Prevent default touch behavior (scroll, zoom, etc.)
    canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

    // Single-finger drag to pan
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (!this._isTouchDevice) return;
      this._isDragging = true;
      this._dragStartX = pointer.x;
      this._dragStartY = pointer.y;
      const cam = this.cameras.main;
      this._camStartX = cam.scrollX;
      this._camStartY = cam.scrollY;
    });

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (!this._isTouchDevice || !this._isDragging) return;
      const cam = this.cameras.main;
      const dx = (this._dragStartX - pointer.x) / cam.zoom;
      const dy = (this._dragStartY - pointer.y) / cam.zoom;
      cam.scrollX = this._camStartX + dx;
      cam.scrollY = this._camStartY + dy;
    });

    this.input.on('pointerup', () => {
      this._isDragging = false;
    });

    // Pinch to zoom (raw touch events for multi-touch)
    canvas.addEventListener('touchstart', (e: TouchEvent) => {
      if (e.touches.length === 2) {
        this._isDragging = false; // cancel pan during pinch
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        this._lastPinchDist = Math.hypot(dx, dy);
      }
    });

    canvas.addEventListener('touchmove', (e: TouchEvent) => {
      if (e.touches.length === 2 && this._lastPinchDist > 0) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.hypot(dx, dy);
        const scale = dist / this._lastPinchDist;
        const cam = this.cameras.main;
        cam.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.zoom * scale));
        this._lastPinchDist = dist;
      }
    });

    canvas.addEventListener('touchend', () => {
      this._lastPinchDist = 0;
    });

    // Wire up mobile HTML buttons
    const btnRegenerate = document.getElementById('btn-regenerate');
    const btnElevation = document.getElementById('btn-elevation');
    const btnMoisture = document.getElementById('btn-moisture');

    btnRegenerate?.addEventListener('click', () => {
      this._generateMap(Date.now());
    });
    btnElevation?.addEventListener('click', () => {
      this._activeOverlay = this._activeOverlay === 'elevation' ? 'none' : 'elevation';
    });
    btnMoisture?.addEventListener('click', () => {
      this._activeOverlay = this._activeOverlay === 'moisture' ? 'none' : 'moisture';
    });
  }

  private _updateHoveredRegion(): void {
    if (!this._regionGrid) return;

    const pointer = this.input.activePointer;
    const cam = this.cameras.main;
    const worldX = pointer.worldX;
    const worldY = pointer.worldY;

    // World coords → pixel coords
    const scale = MAP_SIZE / PIXEL_RESOLUTION;
    const px = Math.floor(worldX / scale);
    const py = Math.floor(worldY / scale);

    let region = -1;
    if (px >= 0 && px < PIXEL_RESOLUTION && py >= 0 && py < PIXEL_RESOLUTION) {
      region = this._regionGrid[py * PIXEL_RESOLUTION + px];
    }

    if (region !== this._hoveredRegion) {
      this._hoveredRegion = region;
      this._highlightIndices = [];
      if (region >= 0) {
        const grid = this._regionGrid;
        const total = PIXEL_RESOLUTION * PIXEL_RESOLUTION;
        for (let i = 0; i < total; i++) {
          if (grid[i] === region) this._highlightIndices.push(i);
        }
      }
    }
  }

  private _buildElevationOverlay(
    topo: TopographyGenerator,
    regionGrid: Uint16Array | null,
  ): Uint32Array | null {
    if (!regionGrid) return null;

    const N = PIXEL_RESOLUTION;
    const total = N * N;
    const overlay = new Uint32Array(total);

    // Low (deep green) → high (white) gradient
    for (let i = 0; i < total; i++) {
      const e = Math.min(1, Math.max(0, topo.elevation[regionGrid[i]]));
      const r = Math.floor(0x1a * (1 - e) + 0xff * e);
      const g = Math.floor(0x4a * (1 - e) + 0xff * e);
      const b = Math.floor(0x2a * (1 - e) + 0xff * e);
      overlay[i] = (255 << 24) | (b << 16) | (g << 8) | r; // ABGR
    }

    return overlay;
  }

  private _buildMoistureOverlay(
    hydro: HydrologyGenerator,
    regionGrid: Uint16Array | null,
  ): Uint32Array | null {
    if (!regionGrid) return null;

    const N = PIXEL_RESOLUTION;
    const total = N * N;
    const overlay = new Uint32Array(total);

    // Dry (warm tan) → wet (deep blue) gradient with wider color range
    // t=0 (dry): (0xB0, 0x85, 0x30)  t=1 (wet): (0x10, 0x30, 0xB0)
    for (let i = 0; i < total; i++) {
      const m = Math.min(1, Math.max(0, hydro.moisture[regionGrid[i]]));
      const r = Math.floor(0xb0 * (1 - m) + 0x10 * m);
      const g = Math.floor(0x85 * (1 - m) + 0x30 * m);
      const b = Math.floor(0x30 * (1 - m) + 0xb0 * m);
      overlay[i] = (255 << 24) | (b << 16) | (g << 8) | r; // ABGR
    }

    return overlay;
  }

  private _buildAirMoistureOverlay(
    hydro: HydrologyGenerator,
    regionGrid: Uint16Array | null,
  ): Uint32Array | null {
    if (!regionGrid) return null;

    const N = PIXEL_RESOLUTION;
    const total = N * N;
    const overlay = new Uint32Array(total);

    // Cyan (high air moisture) → red (depleted) gradient
    for (let i = 0; i < total; i++) {
      const m = Math.min(1, Math.max(0, hydro.airMoisture[regionGrid[i]]));
      const r = Math.floor(0xd0 * (1 - m) + 0x10 * m);
      const g = Math.floor(0x20 * (1 - m) + 0xb0 * m);
      const b = Math.floor(0x20 * (1 - m) + 0xd0 * m);
      overlay[i] = (255 << 24) | (b << 16) | (g << 8) | r; // ABGR
    }

    return overlay;
  }

  private _generateMap(seed: number): void {
    const topo = new TopographyGenerator(MAP_SIZE, seed);
    const hydro = new HydrologyGenerator(topo, seed);

    console.log('[Hydrology]', {
      regions: topo.mesh.numRegions,
      rivers: hydro.rivers.length,
      longestRiver: hydro.rivers[0]?.length ?? 0,
      precipRange: [
        Math.min(...Array.from(hydro.precipitation)),
        Math.max(...Array.from(hydro.precipitation)),
      ],
      moistureRange: [
        Math.min(...Array.from(hydro.moisture)),
        Math.max(...Array.from(hydro.moisture)),
      ],
    });

    const renderer = new GroundRenderer();
    const pixels = renderer.render(topo, PIXEL_RESOLUTION, hydro);

    // Beaches, ocean sparkles, sea stacks (before trees so trees overlay beaches)
    const coastalRenderer = new CoastalRenderer();
    coastalRenderer.render(pixels, topo, hydro, PIXEL_RESOLUTION, seed);

    // River deltas and harbors at river mouths
    const deltaRenderer = new RiverDeltaRenderer();
    deltaRenderer.render(pixels, topo, hydro, PIXEL_RESOLUTION, seed);

    // Static rivers (drawn before trees so tree canopies overlay rivers)
    renderer.renderRivers(pixels, topo, hydro, PIXEL_RESOLUTION);

    // Trees (returns mask of pixels covered by tree sprites)
    const treeRenderer = new TreeRenderer();
    const treeMask = treeRenderer.renderTrees(pixels, topo, hydro, PIXEL_RESOLUTION, seed);

    // Rocky crags and mountain peaks (after trees so peaks overlay trees)
    const mountainRenderer = new MountainRenderer();
    mountainRenderer.render(pixels, topo, PIXEL_RESOLUTION, seed);

    // River animator pre-computes pixel positions; skips tree-covered pixels
    const riverAnimator = new RiverAnimator(topo, hydro, PIXEL_RESOLUTION, seed, treeMask);
    riverAnimator.animate(pixels, 0);

    // Coastal animation first frame
    coastalRenderer.animate(pixels, 0);

    // Store refs for per-frame animation
    this._pixels = pixels;
    this._riverAnimator = riverAnimator;
    this._coastalRenderer = coastalRenderer;
    this._regionGrid = renderer.regionGrid;
    this._hoveredRegion = -1;
    this._highlightIndices = [];
    this._moistureOverlay = this._buildMoistureOverlay(hydro, renderer.regionGrid);
    this._elevationOverlay = this._buildElevationOverlay(topo, renderer.regionGrid);
    this._airMoistureOverlay = this._buildAirMoistureOverlay(hydro, renderer.regionGrid);
    this._activeOverlay = 'none';

    const texKey = 'topo';

    if (this.textures.exists(texKey)) {
      this.textures.remove(texKey);
    }

    const canvasTex = this.textures.createCanvas(texKey, PIXEL_RESOLUTION, PIXEL_RESOLUTION)!;
    const ctx = canvasTex.context;
    const imageData = ctx.createImageData(PIXEL_RESOLUTION, PIXEL_RESOLUTION);

    new Uint8ClampedArray(imageData.data.buffer).set(new Uint8Array(pixels.buffer));

    ctx.putImageData(imageData, 0, 0);
    canvasTex.refresh();

    // Store for update loop
    this._canvasTex = canvasTex;
    this._ctx = ctx;
    this._imageData = imageData;

    if (this.mapSprite) {
      this.mapSprite.setTexture(texKey);
    } else {
      this.mapSprite = this.add.sprite(MAP_SIZE / 2, MAP_SIZE / 2, texKey);
      this.mapSprite.setDisplaySize(MAP_SIZE, MAP_SIZE);
    }
  }
}
