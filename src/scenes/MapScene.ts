import Phaser from 'phaser';
import { GroundRenderer } from '../generators/GroundRenderer';
import { TreeRenderer } from '../generators/TreeRenderer';
import { RiverAnimator } from '../generators/RiverAnimator';
import { CoastalRenderer } from '../generators/CoastalRenderer';
import { MountainRenderer } from '../generators/MountainRenderer';
import { RiverDeltaRenderer } from '../generators/RiverDeltaRenderer';
import { GameState, createGameState } from '../state/GameState';
import { renderDuchies } from '../renderers/DuchyRenderer';
import { UIManager } from '../ui/UIManager';

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
  private _extrusionMap: Int16Array | null = null;
  private _screenToSource: Int32Array | null = null;

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

  // Game state + UI
  private _state!: GameState;
  private _ui!: UIManager;

  constructor() {
    super({ key: 'MapScene' });
  }

  create(): void {
    this._ui = new UIManager();
    this._ui.onTurnAdvanced = () => {
      // For now, just log the turn advance. Future: re-render seasonal changes.
      console.log(`[Turn] ${this._state.year}, ${this._state.season}`);
    };

    this._initializeGame(Date.now());

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
      this._initializeGame(Date.now());
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

    // Click to show region info
    this.input.on('pointerup', (pointer: Phaser.Input.Pointer) => {
      // Only fire region click if the pointer didn't drag significantly
      const dx = Math.abs(pointer.x - pointer.downX);
      const dy = Math.abs(pointer.y - pointer.downY);
      if (dx < 5 && dy < 5) {
        this._onRegionClick(pointer);
      }
    });

    // HUD text (fixed to camera via setScrollFactor)
    const hudLabel = this._isTouchDevice
      ? 'Drag to pan · Pinch to zoom · Buttons at bottom-right'
      : 'ARROWS scroll · +/- zoom · SPACE regenerate · 9 elevation · 0 moisture';
    this.add.text(8, 40, hudLabel, {
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
      this._initializeGame(Date.now());
    });
    btnElevation?.addEventListener('click', () => {
      this._activeOverlay = this._activeOverlay === 'elevation' ? 'none' : 'elevation';
    });
    btnMoisture?.addEventListener('click', () => {
      this._activeOverlay = this._activeOverlay === 'moisture' ? 'none' : 'moisture';
    });
  }

  private _onRegionClick(pointer: Phaser.Input.Pointer): void {
    if (!this._regionGrid || !this._state) return;

    const scale = MAP_SIZE / PIXEL_RESOLUTION;
    const px = Math.floor(pointer.worldX / scale);
    const py = Math.floor(pointer.worldY / scale);

    if (px < 0 || px >= PIXEL_RESOLUTION || py < 0 || py >= PIXEL_RESOLUTION) return;

    const screenIdx = py * PIXEL_RESOLUTION + px;
    const s2s = this._screenToSource;
    const sourceIdx = s2s ? s2s[screenIdx] : -1;
    const region = sourceIdx >= 0
      ? this._regionGrid[sourceIdx]
      : this._regionGrid[screenIdx];

    this._ui.showRegionInfo(region);
  }

  private _updateHoveredRegion(): void {
    if (!this._regionGrid) return;

    const pointer = this.input.activePointer;
    const scale = MAP_SIZE / PIXEL_RESOLUTION;
    const px = Math.floor(pointer.worldX / scale);
    const py = Math.floor(pointer.worldY / scale);

    let region = -1;
    if (px >= 0 && px < PIXEL_RESOLUTION && py >= 0 && py < PIXEL_RESOLUTION) {
      const screenIdx = py * PIXEL_RESOLUTION + px;
      const s2s = this._screenToSource;
      const sourceIdx = s2s ? s2s[screenIdx] : -1;
      if (sourceIdx >= 0) {
        region = this._regionGrid[sourceIdx];
      } else {
        region = this._regionGrid[screenIdx];
      }
    }

    if (region !== this._hoveredRegion) {
      this._hoveredRegion = region;
      this._highlightIndices = [];
      if (region >= 0) {
        const grid = this._regionGrid;
        const N = PIXEL_RESOLUTION;
        const total = N * N;
        const ext = this._extrusionMap;
        for (let i = 0; i < total; i++) {
          if (grid[i] !== region) continue;
          if (ext) {
            const sx = i % N;
            const sy = ((i - sx) / N) - ext[i];
            if (sy >= 0 && sy < N) {
              this._highlightIndices.push(sy * N + sx);
            }
          } else {
            this._highlightIndices.push(i);
          }
        }
      }
    }
  }

  private _buildElevationOverlay(regionGrid: Uint16Array | null): Uint32Array | null {
    if (!regionGrid || !this._state) return null;
    const topo = this._state.topo;
    const N = PIXEL_RESOLUTION;
    const total = N * N;
    const overlay = new Uint32Array(total);

    for (let i = 0; i < total; i++) {
      const e = Math.min(1, Math.max(0, topo.elevation[regionGrid[i]]));
      const r = Math.floor(0x1a * (1 - e) + 0xff * e);
      const g = Math.floor(0x4a * (1 - e) + 0xff * e);
      const b = Math.floor(0x2a * (1 - e) + 0xff * e);
      overlay[i] = (255 << 24) | (b << 16) | (g << 8) | r;
    }

    return overlay;
  }

  private _buildMoistureOverlay(regionGrid: Uint16Array | null): Uint32Array | null {
    if (!regionGrid || !this._state) return null;
    const hydro = this._state.hydro;
    const N = PIXEL_RESOLUTION;
    const total = N * N;
    const overlay = new Uint32Array(total);

    for (let i = 0; i < total; i++) {
      const m = Math.min(1, Math.max(0, hydro.moisture[regionGrid[i]]));
      const r = Math.floor(0xb0 * (1 - m) + 0x10 * m);
      const g = Math.floor(0x85 * (1 - m) + 0x30 * m);
      const b = Math.floor(0x30 * (1 - m) + 0xb0 * m);
      overlay[i] = (255 << 24) | (b << 16) | (g << 8) | r;
    }

    return overlay;
  }

  private _buildAirMoistureOverlay(regionGrid: Uint16Array | null): Uint32Array | null {
    if (!regionGrid || !this._state) return null;
    const hydro = this._state.hydro;
    const N = PIXEL_RESOLUTION;
    const total = N * N;
    const overlay = new Uint32Array(total);

    for (let i = 0; i < total; i++) {
      const m = Math.min(1, Math.max(0, hydro.airMoisture[regionGrid[i]]));
      const r = Math.floor(0xd0 * (1 - m) + 0x10 * m);
      const g = Math.floor(0x20 * (1 - m) + 0xb0 * m);
      const b = Math.floor(0x20 * (1 - m) + 0xd0 * m);
      overlay[i] = (255 << 24) | (b << 16) | (g << 8) | r;
    }

    return overlay;
  }

  /**
   * Initialize game state and render the map.
   * Replaces the old _generateMap with state/rendering separation.
   */
  private _initializeGame(seed: number): void {
    // --- Create game state ---
    this._state = createGameState(seed, MAP_SIZE);
    const { topo, hydro, duchies } = this._state;

    console.log('[Game]', {
      seed,
      regions: topo.mesh.numRegions,
      rivers: hydro.rivers.length,
      duchies: duchies.map(d => `${d.name} (${d.regions.length} regions)`),
    });

    // --- Render map ---
    const renderer = new GroundRenderer();
    const pixels = renderer.render(topo, PIXEL_RESOLUTION, hydro);

    // Duchy territory tint + borders (after ground, before trees)
    if (renderer.regionGrid) {
      renderDuchies(pixels, renderer.regionGrid, this._state, PIXEL_RESOLUTION);
    }

    // Beaches, ocean sparkles, sea stacks
    const coastalRenderer = new CoastalRenderer();
    coastalRenderer.render(pixels, topo, hydro, PIXEL_RESOLUTION, seed);

    // River deltas and harbors
    const deltaRenderer = new RiverDeltaRenderer();
    deltaRenderer.render(pixels, topo, hydro, PIXEL_RESOLUTION, seed);

    // Static rivers
    renderer.renderRivers(pixels, topo, hydro, PIXEL_RESOLUTION);

    // Trees
    const treeRenderer = new TreeRenderer();
    const treeMask = treeRenderer.renderTrees(pixels, topo, hydro, PIXEL_RESOLUTION, seed);

    // Mountain extrusion
    const mountainRenderer = new MountainRenderer();
    mountainRenderer.render(pixels, topo, PIXEL_RESOLUTION, seed, treeMask);
    this._extrusionMap = mountainRenderer.extrusionMap;
    this._screenToSource = mountainRenderer.screenToSource;

    // River animator
    const riverAnimator = new RiverAnimator(topo, hydro, PIXEL_RESOLUTION, seed, treeMask);
    riverAnimator.extrusionMap = mountainRenderer.extrusionMap;
    riverAnimator.animate(pixels, 0);

    // Coastal animation
    coastalRenderer.extrusionMap = mountainRenderer.extrusionMap;
    coastalRenderer.animate(pixels, 0);

    // Store refs
    this._pixels = pixels;
    this._riverAnimator = riverAnimator;
    this._coastalRenderer = coastalRenderer;
    this._regionGrid = renderer.regionGrid;
    this._hoveredRegion = -1;
    this._highlightIndices = [];
    this._moistureOverlay = this._buildMoistureOverlay(renderer.regionGrid);
    this._elevationOverlay = this._buildElevationOverlay(renderer.regionGrid);
    this._airMoistureOverlay = this._buildAirMoistureOverlay(renderer.regionGrid);
    this._activeOverlay = 'none';

    // Update UI
    if (this._ui && renderer.regionGrid) {
      this._ui.setState(this._state, renderer.regionGrid);
    }

    // Create texture
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
