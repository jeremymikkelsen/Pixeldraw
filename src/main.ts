import Phaser from 'phaser';
import { MapScene } from './scenes/MapScene';

new Phaser.Game({
  type: Phaser.AUTO,
  width: 1024,
  height: 1024,
  backgroundColor: '#1a1a2e',
  pixelArt: true,
  scene: [MapScene],
  parent: document.body,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
});
