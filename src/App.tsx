import { useEffect, useRef } from 'react';
import Phaser from 'phaser';
import { MapScene } from './scenes/MapScene';
import { useUIStore } from './store/uiStore';
import { useGameStore } from './store/gameStore';
import { MainMenu } from './components/menus/MainMenu';
import { HouseSelectScreen } from './components/screens/HouseSelectScreen';
import { GameHUD } from './components/hud/GameHUD';
import { RegionPanel } from './components/panels/RegionPanel';
import { DuchyPanel } from './components/panels/DuchyPanel';
import { ControlsHint } from './components/hud/ControlsHint';
import './App.css';

export default function App() {
  const phase = useUIStore(s => s.phase);
  const gameRef = useRef<Phaser.Game | null>(null);

  useEffect(() => {
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundColor: '#1a1a2e',
      pixelArt: true,
      scene: [MapScene],
      parent: 'phaser-container',
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
    });
    gameRef.current = game;

    return () => {
      game.destroy(true);
      gameRef.current = null;
    };
  }, []);

  const inGame = phase === 'playing';

  return (
    <div id="app">
      <div id="phaser-container" />

      {phase === 'menu' && <MainMenu />}
      {phase === 'house-select' && <HouseSelectScreen />}

      {inGame && (
        <>
          <GameHUD />
          <RegionPanel />
          <DuchyPanel />
          <ControlsHint />
        </>
      )}
    </div>
  );
}
