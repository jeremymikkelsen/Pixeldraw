/**
 * Game store — bridges Phaser game state to React UI.
 * The Phaser MapScene pushes state updates here; React components read from here.
 */

import { create } from 'zustand';
import type { GameState } from '../state/GameState';
import type { Duchy, HouseData } from '../state/Duchy';
import type { Season } from '../state/Season';
import type { KingData } from '../state/King';
import type { DuchyEconomy, RationLevel, DevelopmentMode, ResourceType, LaborAssignment } from '../state/Economy';
import { saveGame as persistSave, loadGame as loadSave, hasSavedGame, deleteSave, type SaveData } from '../state/SaveLoad';

export interface GameStoreState {
  // Game session state (null = not in game)
  gameState: GameState | null;
  regionGrid: Uint16Array | null;

  // Derived for easy access
  playerDuchy: Duchy | null;
  playerHouse: HouseData | null;
  playerEconomy: DuchyEconomy | null;
  season: Season | null;
  year: number;
  zoom: number;
  king: KingData | null;

  // Save state
  hasSave: boolean;

  // Callbacks into Phaser
  onEndTurn: (() => void) | null;
  onNewGame: (() => void) | null;
  onLoadGame: ((save: SaveData) => void) | null;

  // Actions
  setGameState: (state: GameState, regionGrid: Uint16Array | null) => void;
  setCallbacks: (
    onEndTurn: () => void,
    onNewGame: () => void,
    onLoadGame: (save: SaveData) => void,
  ) => void;
  clearGame: () => void;

  // Save/Load
  saveCurrentGame: () => void;
  loadSavedGame: () => void;
  clearSavedGame: () => void;

  // Economic actions
  setRationLevel: (level: RationLevel) => void;
  setDevelopmentMode: (mode: DevelopmentMode) => void;
  setTaxRate: (rate: number) => void;
  setLaborAllocation: (role: keyof Omit<LaborAssignment, 'unemployed'>, value: number) => void;
  setFoodEatOrder: (order: ResourceType[]) => void;
}

export const useGameStore = create<GameStoreState>((set, get) => ({
  gameState: null,
  regionGrid: null,
  playerDuchy: null,
  playerHouse: null,
  playerEconomy: null,
  season: null,
  year: 1,
  zoom: 1,
  king: null,
  hasSave: hasSavedGame(),
  onEndTurn: null,
  onNewGame: null,
  onLoadGame: null,

  setGameState: (gameState, regionGrid) => {
    const playerDuchy = gameState.duchies[gameState.playerDuchy] ?? null;
    const playerEconomy = gameState.economies[gameState.playerDuchy] ?? null;
    set({
      gameState,
      regionGrid,
      playerDuchy,
      playerHouse: playerDuchy?.house ?? null,
      playerEconomy,
      season: gameState.season,
      year: gameState.year,
      king: gameState.king,
    });
  },

  setCallbacks: (onEndTurn, onNewGame, onLoadGame) => set({ onEndTurn, onNewGame, onLoadGame }),

  clearGame: () => set({
    gameState: null,
    regionGrid: null,
    playerDuchy: null,
    playerHouse: null,
    playerEconomy: null,
    season: null,
    year: 1,
  }),

  // ─── Save/Load ──────────────────────────────────────────────────────────────

  saveCurrentGame: () => {
    const { gameState } = get();
    if (!gameState) return;
    persistSave(
      gameState.seed,
      gameState.mapSize,
      gameState.playerDuchy,
      gameState.turn,
      gameState.season,
      gameState.year,
      gameState.economies,
    );
    set({ hasSave: true });
  },

  loadSavedGame: () => {
    const save = loadSave();
    if (!save) return;
    const { onLoadGame } = get();
    if (onLoadGame) {
      onLoadGame(save);
    }
  },

  clearSavedGame: () => {
    deleteSave();
    set({ hasSave: false });
  },

  // ─── Economic actions ──────────────────────────────────────────────────────

  setRationLevel: (level) => {
    const { gameState } = get();
    if (!gameState) return;
    gameState.economies[gameState.playerDuchy].rationLevel = level;
    set({ playerEconomy: { ...gameState.economies[gameState.playerDuchy] } });
  },

  setDevelopmentMode: (mode) => {
    const { gameState } = get();
    if (!gameState) return;
    gameState.economies[gameState.playerDuchy].developmentMode = mode;
    set({ playerEconomy: { ...gameState.economies[gameState.playerDuchy] } });
  },

  setTaxRate: (rate) => {
    const { gameState } = get();
    if (!gameState) return;
    gameState.economies[gameState.playerDuchy].taxRate = Math.max(0, Math.min(100, rate));
    set({ playerEconomy: { ...gameState.economies[gameState.playerDuchy] } });
  },

  setLaborAllocation: (role, value) => {
    const { gameState } = get();
    if (!gameState) return;
    const eco = gameState.economies[gameState.playerDuchy];
    const la = eco.laborAssignment;
    const total = eco.population.total;

    // Compute how much is assigned to other roles
    const roles: (keyof Omit<LaborAssignment, 'unemployed'>)[] = ['farmers', 'lumberjacks', 'miners', 'quarrymen', 'smiths'];
    const otherAssigned = roles.filter(r => r !== role).reduce((s, r) => s + la[r], 0);
    const maxForRole = Math.max(0, total - otherAssigned);

    la[role] = Math.max(0, Math.min(maxForRole, value));
    const newTotal = roles.reduce((s, r) => s + la[r], 0);
    la.unemployed = Math.max(0, total - newTotal);

    set({ playerEconomy: { ...eco } });
  },

  setFoodEatOrder: (order) => {
    const { gameState } = get();
    if (!gameState) return;
    gameState.economies[gameState.playerDuchy].foodEatOrder = order;
    set({ playerEconomy: { ...gameState.economies[gameState.playerDuchy] } });
  },
}));
