/**
 * Save/Load system — persists mutable game state to localStorage.
 *
 * Only mutable state is saved. Terrain, duchies, and roads are
 * deterministically regenerated from the seed on load.
 */

import type { DuchyEconomy } from './Economy';
import { FOOD_KEYS } from './Economy';
import type { Season } from './Season';

// ─── Save data format ───────────────────────────────────────────────────────

const SAVE_KEY = 'pixelduchy_autosave';
const SAVE_VERSION = 1;

export interface SaveData {
  version: number;
  seed: number;
  mapSize: number;
  playerDuchy: number;
  turn: number;
  season: Season;
  year: number;
  economies: DuchyEconomy[];
  savedAt: string;     // ISO UTC timestamp
}

// ─── Save ───────────────────────────────────────────────────────────────────

export function saveGame(
  seed: number,
  mapSize: number,
  playerDuchy: number,
  turn: number,
  season: Season,
  year: number,
  economies: DuchyEconomy[],
): void {
  const data: SaveData = {
    version: SAVE_VERSION,
    seed,
    mapSize,
    playerDuchy,
    turn,
    season,
    year,
    economies: economies.map(e => structuredClone(e)),
    savedAt: new Date().toISOString(),
  };

  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    console.log('[Save] Game saved', { turn, season, year });
  } catch (err) {
    console.error('[Save] Failed to save game:', err);
  }
}

// ─── Load ───────────────────────────────────────────────────────────────────

export function loadGame(): SaveData | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;

    const data = JSON.parse(raw) as SaveData;

    // Basic validation
    if (!data || typeof data.seed !== 'number' || typeof data.turn !== 'number') {
      console.warn('[Load] Invalid save data — ignoring');
      return null;
    }

    // Migration: add defaults for fields that may not exist in older saves
    for (const eco of data.economies) {
      if (!eco.laborAssignment) {
        eco.laborAssignment = {
          farmers: 0, lumberjacks: 0, miners: 0,
          quarrymen: 0, smiths: 0, unemployed: eco.population.total,
        };
      }
      if (!eco.foodEatOrder) {
        eco.foodEatOrder = [...FOOD_KEYS];
      }
    }

    console.log('[Load] Save found', {
      seed: data.seed,
      turn: data.turn,
      season: data.season,
      year: data.year,
      savedAt: data.savedAt,
    });

    return data;
  } catch (err) {
    console.error('[Load] Failed to load save:', err);
    return null;
  }
}

// ─── Check if save exists ───────────────────────────────────────────────────

export function hasSavedGame(): boolean {
  return localStorage.getItem(SAVE_KEY) !== null;
}

// ─── Delete save ────────────────────────────────────────────────────────────

export function deleteSave(): void {
  localStorage.removeItem(SAVE_KEY);
  console.log('[Save] Save deleted');
}

// ─── Save summary (for Continue button) ─────────────────────────────────────

export interface SaveSummary {
  year: number;
  season: Season;
  turn: number;
  playerDuchy: number;
  savedAt: string;
}

export function getSaveSummary(): SaveSummary | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as SaveData;
    return {
      year: data.year,
      season: data.season,
      turn: data.turn,
      playerDuchy: data.playerDuchy,
      savedAt: data.savedAt,
    };
  } catch {
    return null;
  }
}
