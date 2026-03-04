import Phaser from 'phaser';
import { TopographyGenerator } from '../generators/TopographyGenerator';

const SCENE_SIZE = 1024;
const PIXEL_RESOLUTION = 256;

export class MapScene extends Phaser.Scene {
  private mapSprite!: Phaser.GameObjects.Sprite;

  constructor() {
    super({ key: 'MapScene' });
  }

  create(): void {
    this._generateMap(Date.now());

    this.input.keyboard!.on('keydown-SPACE', () => {
      this._generateMap(Date.now());
    });

    this.add.text(8, 8, 'SPACE — regenerate', {
      fontSize: '13px',
      color: '#ffffff',
      backgroundColor: '#00000088',
      padding: { x: 6, y: 4 },
    }).setDepth(10);
  }

  private _generateMap(seed: number): void {
    const topo = new TopographyGenerator(SCENE_SIZE, seed);
    const pixels = topo.rasterize(PIXEL_RESOLUTION);

    const texKey = 'topo';

    // Remove previous texture if it exists
    if (this.textures.exists(texKey)) {
      this.textures.remove(texKey);
    }

    const canvasTex = this.textures.createCanvas(texKey, PIXEL_RESOLUTION, PIXEL_RESOLUTION);
    const ctx = canvasTex!.context;
    const imageData = ctx.createImageData(PIXEL_RESOLUTION, PIXEL_RESOLUTION);

    // Copy Uint32 pixel data into ImageData
    new Uint8ClampedArray(imageData.data.buffer).set(new Uint8Array(pixels.buffer));

    ctx.putImageData(imageData, 0, 0);
    canvasTex!.refresh();

    if (this.mapSprite) {
      this.mapSprite.setTexture(texKey);
    } else {
      this.mapSprite = this.add.sprite(SCENE_SIZE / 2, SCENE_SIZE / 2, texKey);
      this.mapSprite.setDisplaySize(SCENE_SIZE, SCENE_SIZE);
    }
  }
}
