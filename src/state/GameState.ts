/**
 * Central game state — serializable, separate from rendering.
 * All game data lives here; renderers only read from it.
 */

import { TopographyGenerator } from '../generators/TopographyGenerator';
import { HydrologyGenerator } from '../generators/HydrologyGenerator';
import { Season, nextSeason } from './Season';
import { Duchy } from './Duchy';
import { generateDuchies } from './DuchyGenerator';
import { generateRoads, RoadSegment } from '../generators/RoadGenerator';
import { DuchyEconomy, createDuchyEconomy, processEconomyTurn, countTerrain } from './Economy';
import type { SaveData } from './SaveLoad';
import { AgImprovementType, assignAgImprovements } from './AgImprovements';
import { KingData, selectKing } from './King';

export interface GameState {
  seed: number;
  mapSize: number;
  turn: number;
  season: Season;
  year: number;
  playerDuchy: number; // index into duchies[] for the player's house

  // Terrain (generated once, immutable after creation)
  topo: TopographyGenerator;
  hydro: HydrologyGenerator;

  // Political
  duchies: Duchy[];
  regionToDuchy: Int8Array;
  king: KingData;

  // Infrastructure
  roads: RoadSegment[];

  // Agricultural improvements — deterministic from seed, one per type per duchy
  agImprovements: Map<number, AgImprovementType>;

  // Economy — one per duchy, indexed same as duchies[]
  economies: DuchyEconomy[];
}

/**
 * Create a fully initialized GameState from a seed (new game).
 * @param playerHouse - index into HOUSES[] for the player's chosen house
 */
export function createGameState(seed: number, mapSize: number, playerHouse: number = 0): GameState {
  const topo = new TopographyGenerator(mapSize, seed);
  const hydro = new HydrologyGenerator(topo, seed);
  const { duchies, regionToDuchy } = generateDuchies(topo, hydro, seed);
  const roads = generateRoads(topo, hydro, duchies);
  const agImprovements = assignAgImprovements(topo, hydro, duchies, seed);
  const king = selectKing(seed);

  // Initialize economies for each duchy
  const economies = duchies.map(() => createDuchyEconomy(50));

  return {
    seed,
    mapSize,
    turn: 0,
    season: Season.Spring,
    year: 1,
    playerDuchy: playerHouse,
    topo,
    hydro,
    duchies,
    regionToDuchy,
    king,
    roads,
    agImprovements,
    economies,
  };
}

/**
 * Restore a GameState from save data.
 * Regenerates terrain/duchies/roads from seed, then applies saved mutable state.
 */
export function loadGameState(save: SaveData): GameState {
  const topo = new TopographyGenerator(save.mapSize, save.seed);
  const hydro = new HydrologyGenerator(topo, save.seed);
  const { duchies, regionToDuchy } = generateDuchies(topo, hydro, save.seed);
  const roads = generateRoads(topo, hydro, duchies);
  const agImprovements = assignAgImprovements(topo, hydro, duchies, save.seed);
  const king = selectKing(save.seed);

  return {
    seed: save.seed,
    mapSize: save.mapSize,
    turn: save.turn,
    season: save.season,
    year: save.year,
    playerDuchy: save.playerDuchy,
    topo,
    hydro,
    duchies,
    regionToDuchy,
    king,
    roads,
    agImprovements,
    economies: save.economies,
  };
}

/**
 * Advance the game by one turn (one season).
 * Processes economy for all duchies.
 */
export function advanceTurn(state: GameState): void {
  state.turn++;
  state.season = nextSeason(state.season);
  state.year = Math.floor(state.turn / 4) + 1;

  // Process economy for each duchy
  const terrainTypes = state.topo.terrainType;
  for (let i = 0; i < state.duchies.length; i++) {
    const duchy = state.duchies[i];
    const terrain = countTerrain(
      duchy.regions, terrainTypes, duchy.hasRiver, duchy.hasForest,
    );
    state.economies[i] = processEconomyTurn(state.economies[i], terrain);
  }
}
