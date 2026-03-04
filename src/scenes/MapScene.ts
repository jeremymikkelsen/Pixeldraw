import Phaser from 'phaser';
import { TopographyGenerator } from '../generators/TopographyGenerator';
import { GroundRenderer } from '../generators/GroundRenderer';
import { HydrologyGenerator } from '../generators/HydrologyGenerator';

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

    // HUD text (fixed to camera via setScrollFactor)
    this.add.text(8, 8, 'ARROWS scroll · +/- zoom · SPACE regenerate', {
      fontSize: '13px',
      color: '#ffffff',
      backgroundColor: '#00000088',
      padding: { x: 6, y: 4 },
    }).setDepth(10).setScrollFactor(0);
  }

  update(_time: number, delta: number): void {
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
    const pixels = renderer.render(topo, PIXEL_RESOLUTION);
    renderer.renderRivers(pixels, topo, hydro, PIXEL_RESOLUTION);

    const texKey = 'topo';

    if (this.textures.exists(texKey)) {
      this.textures.remove(texKey);
    }

    const canvasTex = this.textures.createCanvas(texKey, PIXEL_RESOLUTION, PIXEL_RESOLUTION);
    const ctx = canvasTex!.context;
    const imageData = ctx.createImageData(PIXEL_RESOLUTION, PIXEL_RESOLUTION);

    new Uint8ClampedArray(imageData.data.buffer).set(new Uint8Array(pixels.buffer));

    ctx.putImageData(imageData, 0, 0);
    canvasTex!.refresh();

    if (this.mapSprite) {
      this.mapSprite.setTexture(texKey);
    } else {
      this.mapSprite = this.add.sprite(MAP_SIZE / 2, MAP_SIZE / 2, texKey);
      this.mapSprite.setDisplaySize(MAP_SIZE, MAP_SIZE);
    }
  }
}
