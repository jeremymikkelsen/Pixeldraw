import Phaser from 'phaser';
import { TopographyGenerator } from '../generators/TopographyGenerator';
import { GroundRenderer } from '../generators/GroundRenderer';
import { HydrologyGenerator } from '../generators/HydrologyGenerator';
import { TreeRenderer } from '../generators/TreeRenderer';
import { RiverAnimator } from '../generators/RiverAnimator';

const MAP_SIZE = 2048;
const PIXEL_RESOLUTION = 1024;

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

  // Region hover highlight
  private _regionGrid!: Uint16Array | null;
  private _hoveredRegion = -1;
  private _highlightIndices: number[] = [];

  // Moisture overlay
  private _moistureOverlay!: Uint32Array | null;
  private _showMoisture = false;

  constructor() {
    super({ key: 'MapScene' });
  }

  create(): void {
    this._generateMap(Date.now());

    // Camera setup
    const cam = this.cameras.main;
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
      this._showMoisture = !this._showMoisture;
    });

    // HUD text (fixed to camera via setScrollFactor)
    this.add.text(8, 8, 'ARROWS scroll · +/- zoom · SPACE regenerate · 0 moisture', {
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
      const src = this._showMoisture && this._moistureOverlay
        ? this._moistureOverlay : this._pixels;

      if (!this._showMoisture) {
        this._riverAnimator.animate(this._pixels, time);
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

  private _buildMoistureOverlay(
    hydro: HydrologyGenerator,
    regionGrid: Uint16Array | null,
  ): Uint32Array | null {
    if (!regionGrid) return null;

    const N = PIXEL_RESOLUTION;
    const total = N * N;
    const overlay = new Uint32Array(total);

    // Dry (brown) → wet (blue) gradient
    // t=0 (dry): warm brown  t=1 (wet): deep blue
    for (let i = 0; i < total; i++) {
      const m = Math.min(1, Math.max(0, hydro.moisture[regionGrid[i]]));
      const r = Math.floor(0x8a * (1 - m) + 0x20 * m);
      const g = Math.floor(0x70 * (1 - m) + 0x40 * m);
      const b = Math.floor(0x3a * (1 - m) + 0x90 * m);
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

    // Trees (before rivers so river animator can overwrite)
    const treeRenderer = new TreeRenderer();
    treeRenderer.renderTrees(pixels, topo, hydro, PIXEL_RESOLUTION, seed);

    // River animator pre-computes pixel positions; draws first frame
    const riverAnimator = new RiverAnimator(topo, hydro, PIXEL_RESOLUTION, seed);
    riverAnimator.animate(pixels, 0);

    // Store refs for per-frame animation
    this._pixels = pixels;
    this._riverAnimator = riverAnimator;
    this._regionGrid = renderer.regionGrid;
    this._hoveredRegion = -1;
    this._highlightIndices = [];
    this._moistureOverlay = this._buildMoistureOverlay(hydro, renderer.regionGrid);
    this._showMoisture = false;

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
