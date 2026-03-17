import Phaser from 'phaser';
import { GroundRenderer } from '../generators/GroundRenderer';
import { TreeRenderer } from '../generators/TreeRenderer';
import { RiverAnimator } from '../generators/RiverAnimator';
import { CoastalRenderer } from '../generators/CoastalRenderer';
import { MountainRenderer } from '../generators/MountainRenderer';
import { RiverDeltaRenderer } from '../generators/RiverDeltaRenderer';
import { StructureRenderer } from '../generators/StructureRenderer';
import { GameState, createGameState, advanceTurn } from '../state/GameState';
import { renderDuchies, renderDuchyBordersOnTop } from '../renderers/DuchyRenderer';
import { RoadRenderer } from '../generators/RoadRenderer';
import { useGameStore } from '../store/gameStore';
import { useUIStore } from '../store/uiStore';
import { loadSprite, type LoadedSprite } from '../generators/SpriteLoader';

const MAP_SIZE = 3072;
const PIXEL_RESOLUTION = 1536;

const SCROLL_SPEED = 300;
const ZOOM_SPEED = 0.03;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const EDGE_PAN_ZONE = 40;       // pixels from window edge to start panning
const EDGE_PAN_MAX_SPEED = 500;  // max pan speed at the very edge

export class MapScene extends Phaser.Scene {
  private mapSprite!: Phaser.GameObjects.Sprite;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private plusKey!: Phaser.Input.Keyboard.Key;
  private minusKey!: Phaser.Input.Keyboard.Key;
  private eqKey!: Phaser.Input.Keyboard.Key;
  private numpadPlusKey!: Phaser.Input.Keyboard.Key;
  private numpadMinusKey!: Phaser.Input.Keyboard.Key;

  // WASD keys
  private _wKey!: Phaser.Input.Keyboard.Key;
  private _aKey!: Phaser.Input.Keyboard.Key;
  private _sKey!: Phaser.Input.Keyboard.Key;
  private _dKey!: Phaser.Input.Keyboard.Key;

  // Space-drag panning
  private _spaceKey!: Phaser.Input.Keyboard.Key;
  private _isSpacePanning = false;
  private _spaceDragStartX = 0;
  private _spaceDragStartY = 0;
  private _spaceCamStartX = 0;
  private _spaceCamStartY = 0;

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

  // Game state
  private _state!: GameState;

  // Building + bridge pixels to restore after river animation each frame
  private _buildingPixels: { idx: number; color: number }[] = [];

  // Pre-loaded manor sprites (from PNGs) — one per duchy style
  private _manorSprites: LoadedSprite[] = [];

  constructor() {
    super({ key: 'MapScene' });
  }

  // Player's chosen house index
  private _playerHouse = 0;

  // Event listener references for cleanup
  private _startGameHandler: ((e: Event) => void) | null = null;

  create(): void {
    // Wire up store callbacks for React UI
    useGameStore.getState().setCallbacks(
      // onEndTurn
      () => {
        if (!this._state) return;
        advanceTurn(this._state);
        console.log(`[Turn] Year ${this._state.year}, ${this._state.season}`);
        const cam = this.cameras.main;
        cam.fadeOut(400, 0, 0, 0);
        cam.once('camerafadeoutcomplete', () => {
          this._renderMap();
          this._pushStateToStore();
          cam.fadeIn(400, 0, 0, 0);
        });
      },
      // onNewGame
      () => {
        useUIStore.getState().setPhase('house-select');
      },
    );

    // Listen for start-game events from React HouseSelectScreen
    this._startGameHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      this._playerHouse = detail.houseIndex;
      this._startGame(detail.seed);
    };
    window.addEventListener('pixeldraw:start-game', this._startGameHandler);

    // Camera setup — no setBounds so panning works at all zoom levels
    const cam = this.cameras.main;
    cam.centerOn(MAP_SIZE / 2, MAP_SIZE / 2);

    // Input — zoom keys (regular keyboard + numpad)
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.plusKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.PLUS);
    this.minusKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.MINUS);
    this.eqKey = this.input.keyboard!.addKey(187);  // =/+ key on US keyboards
    this.numpadPlusKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.NUMPAD_ADD);
    this.numpadMinusKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.NUMPAD_SUBTRACT);

    // WASD pan keys
    this._wKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.W);
    this._aKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A);
    this._sKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.S);
    this._dKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.D);

    // Space key for hand-pan mode
    this._spaceKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);

    // Enter = new game (goes back to house select via React)
    this.input.keyboard!.on('keydown-ENTER', () => {
      useUIStore.getState().setPhase('house-select');
    });

    // Overlay toggles (8/9/0)
    this.input.keyboard!.on('keydown-ZERO', () => {
      this._activeOverlay = this._activeOverlay === 'moisture' ? 'none' : 'moisture';
    });

    this.input.keyboard!.on('keydown-NINE', () => {
      this._activeOverlay = this._activeOverlay === 'elevation' ? 'none' : 'elevation';
    });

    this.input.keyboard!.on('keydown-EIGHT', () => {
      this._activeOverlay = this._activeOverlay === 'airMoisture' ? 'none' : 'airMoisture';
    });

    // Wheel / trackpad / pinch input — handled via native DOM event for full WheelEvent access.
    // ctrlKey=true  → Mac trackpad pinch (slow zoom centered on cursor)
    // deltaMode=0   → trackpad two-finger scroll (pan)
    // deltaMode≥1   → mouse scroll wheel (fast zoom centered on cursor)
    this.game.canvas.addEventListener('wheel', (e: WheelEvent) => {
      e.preventDefault();
      const cam = this.cameras.main;
      const rect = this.game.canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      const applyZoom = (delta: number, speed: number) => {
        const zoomBefore = cam.zoom;
        const zoomDelta = delta > 0 ? (1 - speed) : (1 + speed);
        const zoomAfter = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomBefore * zoomDelta));
        cam.zoom = zoomAfter;
        cam.scrollX += (cx - cam.width * 0.5) * (1 / zoomBefore - 1 / zoomAfter);
        cam.scrollY += (cy - cam.height * 0.5) * (1 / zoomBefore - 1 / zoomAfter);
      };

      if (e.ctrlKey) {
        // Trackpad pinch — gentler speed than mouse wheel
        applyZoom(e.deltaY, ZOOM_SPEED);
      } else if (e.deltaMode === 0) {
        // Trackpad two-finger scroll → pan (deltaX + deltaY both used)
        const scale = 1 / cam.zoom;
        cam.scrollX += e.deltaX * scale;
        cam.scrollY += e.deltaY * scale;
      } else {
        // Mouse scroll wheel → zoom (original speed)
        applyZoom(e.deltaY, ZOOM_SPEED * 3);
      }
    }, { passive: false });

    // Space+drag panning — mousedown while space held
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (this._spaceKey.isDown) {
        this._isSpacePanning = true;
        this._spaceDragStartX = pointer.x;
        this._spaceDragStartY = pointer.y;
        const cam = this.cameras.main;
        this._spaceCamStartX = cam.scrollX;
        this._spaceCamStartY = cam.scrollY;
        this.game.canvas.style.cursor = 'grabbing';
      }
    });

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (this._isSpacePanning) {
        const cam = this.cameras.main;
        const dx = (this._spaceDragStartX - pointer.x) / cam.zoom;
        const dy = (this._spaceDragStartY - pointer.y) / cam.zoom;
        cam.scrollX = this._spaceCamStartX + dx;
        cam.scrollY = this._spaceCamStartY + dy;
      }
    });

    this.input.on('pointerup', () => {
      if (this._isSpacePanning) {
        this._isSpacePanning = false;
        this.game.canvas.style.cursor = this._spaceKey.isDown ? 'grab' : 'default';
      }
    });

    // Touch / mobile support — use pointer media query so MacBook trackpads (fine pointer)
    // are not treated as touch devices; only real touchscreens (coarse pointer) get touch controls.
    this._isTouchDevice = window.matchMedia('(pointer: coarse)').matches;
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

    // Load manor sprites eagerly
    this._loadManorSprites();
  }

  private async _loadManorSprites(): Promise<void> {
    if (this._manorSprites.length > 0) return;
    const spriteUrls = [
      '/sprites/pixellab-medieval-manor-house-3-4-proje-1772784363719.png',
      '/sprites/pixellab-medieval-manor-house-3-4-proje-1772784433859.png',
      '/sprites/pixellab-medieval-manor-house-3-4-proje-1772784503776.png',
    ];
    const results = await Promise.allSettled(spriteUrls.map(url => loadSprite(url)));
    for (const result of results) {
      if (result.status === 'fulfilled') {
        this._manorSprites.push(result.value);
        console.log('[Sprite] Manor loaded:', result.value.w, '×', result.value.h);
      } else {
        console.warn('[Sprite] Failed to load manor sprite:', result.reason);
      }
    }
  }

  /**
   * Called from React via custom event when the player starts a game.
   */
  private _startGame(seed: number): void {
    this._initializeGame(seed);
    this._centerOnPlayerDuchy();
    this._pushStateToStore();
  }

  private _pushStateToStore(): void {
    if (this._state) {
      useGameStore.getState().setGameState(this._state, this._regionGrid);
    }
  }

  private _centerOnPlayerDuchy(): void {
    if (!this._state) return;
    const duchy = this._state.duchies[this._state.playerDuchy];
    if (!duchy) return;

    const capitalPos = this._state.topo.mesh.points[duchy.capitalRegion];
    if (!capitalPos) return;

    const cam = this.cameras.main;
    cam.centerOn(capitalPos.x, capitalPos.y);
    cam.zoom = 1.5;
  }

  update(time: number, delta: number): void {
    const cam = this.cameras.main;
    const dt = delta / 1000;
    const speed = SCROLL_SPEED / cam.zoom;

    // Arrow key + WASD scrolling
    if (this.cursors.left.isDown || this._aKey.isDown)  cam.scrollX -= speed * dt;
    if (this.cursors.right.isDown || this._dKey.isDown) cam.scrollX += speed * dt;
    if (this.cursors.up.isDown || this._wKey.isDown)    cam.scrollY -= speed * dt;
    if (this.cursors.down.isDown || this._sKey.isDown)  cam.scrollY += speed * dt;

    // +/- zoom (regular keyboard + numpad)
    if (this.plusKey.isDown || this.eqKey.isDown || this.numpadPlusKey.isDown) cam.zoom = Math.min(MAX_ZOOM, cam.zoom * (1 + ZOOM_SPEED));
    if (this.minusKey.isDown || this.numpadMinusKey.isDown) cam.zoom = Math.max(MIN_ZOOM, cam.zoom * (1 - ZOOM_SPEED));

    // Edge panning (mouse near window edge) — disabled while keyboard panning
    const keyPanning = this.cursors.left.isDown || this.cursors.right.isDown
      || this.cursors.up.isDown || this.cursors.down.isDown
      || this._wKey.isDown || this._aKey.isDown || this._sKey.isDown || this._dKey.isDown;

    if (!this._isSpacePanning && !this._isDragging && !keyPanning) {
      const pointer = this.input.activePointer;
      const mx = pointer.x;
      const my = pointer.y;
      const w = this.scale.width;
      const h = this.scale.height;

      // Only edge-pan when pointer is actually inside the canvas
      if (mx > 0 && my > 0 && mx < w && my < h) {
        const edgeSpeed = EDGE_PAN_MAX_SPEED / cam.zoom;
        if (mx < EDGE_PAN_ZONE) {
          cam.scrollX -= edgeSpeed * (1 - mx / EDGE_PAN_ZONE) * dt;
        } else if (mx > w - EDGE_PAN_ZONE) {
          cam.scrollX += edgeSpeed * (1 - (w - mx) / EDGE_PAN_ZONE) * dt;
        }
        if (my < EDGE_PAN_ZONE) {
          cam.scrollY -= edgeSpeed * (1 - my / EDGE_PAN_ZONE) * dt;
        } else if (my > h - EDGE_PAN_ZONE) {
          cam.scrollY += edgeSpeed * (1 - (h - my) / EDGE_PAN_ZONE) * dt;
        }
      }
    }

    // Soft camera clamping — keep map center reachable but allow edge panning at any zoom
    const viewW = cam.width / cam.zoom;
    const viewH = cam.height / cam.zoom;
    const margin = 100; // pixels of world space past the map edge
    const minX = -viewW / 2 - margin;
    const minY = -viewH / 2 - margin;
    const maxX = MAP_SIZE - viewW / 2 + margin;
    const maxY = MAP_SIZE - viewH / 2 + margin;
    cam.scrollX = Math.max(minX, Math.min(maxX, cam.scrollX));
    cam.scrollY = Math.max(minY, Math.min(maxY, cam.scrollY));

    // Space key cursor management
    if (this._spaceKey.isDown && !this._isSpacePanning) {
      this.game.canvas.style.cursor = 'grab';
    } else if (!this._spaceKey.isDown && !this._isSpacePanning) {
      this.game.canvas.style.cursor = 'default';
    }

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
        // Restore building/bridge pixels so they always render above rivers and coast
        for (const bp of this._buildingPixels) {
          this._pixels[bp.idx] = bp.color;
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

    // Wire up mobile HTML buttons (if present)
    const btnRegenerate = document.getElementById('btn-regenerate');
    const btnElevation = document.getElementById('btn-elevation');
    const btnMoisture = document.getElementById('btn-moisture');

    btnRegenerate?.addEventListener('click', () => {
      useUIStore.getState().setPhase('house-select');
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

    useUIStore.getState().setSelectedRegion(region >= 0 ? region : null);
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
   */
  private _initializeGame(seed: number): void {
    this._state = createGameState(seed, MAP_SIZE, this._playerHouse);
    const { topo, hydro, duchies } = this._state;

    console.log('[Game]', {
      seed,
      regions: topo.mesh.numRegions,
      rivers: hydro.rivers.length,
      duchies: duchies.map(d => `${d.house.name} (${d.regions.length} regions)`),
      roads: this._state.roads.length,
    });

    this._renderMap();
  }

  /**
   * Re-render the map from current game state (called on init and each turn).
   */
  private _renderMap(): void {
    const { topo, hydro, seed, season } = this._state;

    // Ground with seasonal palettes
    const renderer = new GroundRenderer();
    const pixels = renderer.render(topo, PIXEL_RESOLUTION, hydro, season);

    // Duchy territory tint + borders
    if (renderer.regionGrid) {
      renderDuchies(pixels, renderer.regionGrid, this._state, PIXEL_RESOLUTION);
    }

    // Static rivers — rendered BEFORE coastal so riverMask can suppress beach/waves at river mouths
    const roadRenderer = new RoadRenderer();
    const riverMask = renderer.renderRivers(pixels, topo, hydro, PIXEL_RESOLUTION);

    // Beaches, ocean sparkles, sea stacks (pass riverMask to suppress sand/waves at river mouths)
    const coastalRenderer = new CoastalRenderer();
    coastalRenderer.render(pixels, topo, hydro, PIXEL_RESOLUTION, seed, season, riverMask);

    // River deltas and harbors
    const deltaRenderer = new RiverDeltaRenderer();
    deltaRenderer.render(pixels, topo, hydro, PIXEL_RESOLUTION, seed);

    // Roads between duchy capitals (pass riverMask for bridge detection)
    const roadMask = roadRenderer.render(pixels, topo, PIXEL_RESOLUTION, seed, this._state.roads, riverMask);

    // Capture bridge pixel colors NOW (before river animation overwrites them)
    const bridgePixelColors: { idx: number; color: number }[] = [];
    for (let bi = 0; bi < PIXEL_RESOLUTION * PIXEL_RESOLUTION; bi++) {
      if (roadRenderer.bridgeMask[bi]) {
        bridgePixelColors.push({ idx: bi, color: pixels[bi] });
      }
    }

    // Structure placement (before trees so trees grow around buildings)
    const structureRenderer = new StructureRenderer();
    const { structures, mask: structureMask } = structureRenderer.placeStructures(
      topo, hydro, PIXEL_RESOLUTION, seed,
      this._state.duchies, this._state.regionToDuchy,
    );

    // Merge road mask into structure mask so trees avoid roads
    for (let i = 0; i < roadMask.length; i++) {
      if (roadMask[i]) structureMask[i] = 1;
    }

    // Trees with seasonal palettes (pass structureMask to avoid overlapping buildings/roads)
    const treeRenderer = new TreeRenderer();
    const treeMask = treeRenderer.renderTrees(pixels, topo, hydro, PIXEL_RESOLUTION, seed, season, structureMask);

    // Mountain extrusion with seasonal snow line
    const mountainRenderer = new MountainRenderer();
    mountainRenderer.render(pixels, topo, PIXEL_RESOLUTION, seed, treeMask, season, roadMask);
    this._extrusionMap = mountainRenderer.extrusionMap;
    this._screenToSource = mountainRenderer.screenToSource;

    // River animator (buildingMask set after renderSprites below)
    const riverAnimator = new RiverAnimator(topo, hydro, PIXEL_RESOLUTION, seed, treeMask, renderer.terrainGrid);
    riverAnimator.extrusionMap = mountainRenderer.extrusionMap;

    // Coastal animation
    coastalRenderer.extrusionMap = mountainRenderer.extrusionMap;

    // Duchy borders over trees and mountains
    if (renderer.regionGrid) {
      renderDuchyBordersOnTop(pixels, renderer.regionGrid, this._state, PIXEL_RESOLUTION, mountainRenderer.extrusionMap);
    }

    // Structures on top of duchy borders (3/4 perspective with ground shadows)
    const buildingMask = structureRenderer.renderSprites(pixels, PIXEL_RESOLUTION, structures, season, this._manorSprites.length > 0 ? this._manorSprites : undefined);

    // Capture building pixel colors NOW (before river animation overwrites them)
    const buildingPixelColors: { idx: number; color: number }[] = [];
    for (let bi = 0; bi < PIXEL_RESOLUTION * PIXEL_RESOLUTION; bi++) {
      if (buildingMask[bi]) {
        buildingPixelColors.push({ idx: bi, color: pixels[bi] });
      }
    }

    // Combine bridge + building pixels for per-frame restoration above river animation
    this._buildingPixels = [...bridgePixelColors, ...buildingPixelColors];

    // Merge bridge mask into building mask so river animator skips bridge pixels too
    for (let bi = 0; bi < PIXEL_RESOLUTION * PIXEL_RESOLUTION; bi++) {
      if (roadRenderer.bridgeMask[bi]) buildingMask[bi] = 1;
    }

    // Wire building+bridge mask into river animator so rivers don't overdraw either
    riverAnimator.buildingMask = buildingMask;

    // Initial animation frame — then restore buildings/bridges on top
    riverAnimator.animate(pixels, 0);
    coastalRenderer.animate(pixels, 0);
    for (const bp of this._buildingPixels) {
      pixels[bp.idx] = bp.color;
    }

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

    // Create/update texture
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
