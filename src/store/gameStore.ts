/**
 * Game store — bridges Phaser game state to React UI.
 * The Phaser MapScene pushes state updates here; React components read from here.
 */

import { create } from 'zustand';
import type { GameState } from '../state/GameState';
import type { Duchy, HouseData } from '../state/Duchy';
import type { Season } from '../state/Season';

export interface GameStoreState {
  // Game session state (null = not in game)
  gameState: GameState | null;
  regionGrid: Uint16Array | null;

  // Derived for easy access
  playerDuchy: Duchy | null;
  playerHouse: HouseData | null;
  season: Season | null;
  year: number;

  // Callbacks into Phaser
  onEndTurn: (() => void) | null;
  onNewGame: (() => void) | null;

  // Actions
  setGameState: (state: GameState, regionGrid: Uint16Array | null) => void;
  setCallbacks: (onEndTurn: () => void, onNewGame: () => void) => void;
  clearGame: () => void;
}

export const useGameStore = create<GameStoreState>((set) => ({
  gameState: null,
  regionGrid: null,
  playerDuchy: null,
  playerHouse: null,
  season: null,
  year: 1,
  onEndTurn: null,
  onNewGame: null,

  setGameState: (gameState, regionGrid) => {
    const playerDuchy = gameState.duchies[gameState.playerDuchy] ?? null;
    set({
      gameState,
      regionGrid,
      playerDuchy,
      playerHouse: playerDuchy?.house ?? null,
      season: gameState.season,
      year: gameState.year,
    });
  },

  setCallbacks: (onEndTurn, onNewGame) => set({ onEndTurn, onNewGame }),

  clearGame: () => set({
    gameState: null,
    regionGrid: null,
    playerDuchy: null,
    playerHouse: null,
    season: null,
    year: 1,
  }),
}));
