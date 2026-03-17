/**
 * UI store — tracks which panels are open, selected region, etc.
 */

import { create } from 'zustand';

export type OpenPanel = 'duchy' | 'food' | 'resources' | 'goods' | 'population' | 'king' | 'build' | null;

export interface UIStoreState {
  // Which region is selected (clicked)
  selectedRegion: number | null;

  // Which panel modal is open
  openPanel: OpenPanel;

  // Game phase
  phase: 'menu' | 'house-select' | 'playing';

  // Actions
  setSelectedRegion: (region: number | null) => void;
  setOpenPanel: (panel: OpenPanel) => void;
  setPhase: (phase: 'menu' | 'house-select' | 'playing') => void;
}

export const useUIStore = create<UIStoreState>((set) => ({
  selectedRegion: null,
  openPanel: null,
  phase: 'menu',

  setSelectedRegion: (region) => set({ selectedRegion: region }),
  setOpenPanel: (panel) => set({ openPanel: panel }),
  setPhase: (phase) => set({ phase }),
}));
