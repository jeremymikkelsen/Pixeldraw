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

export interface GameState {
  seed: number;
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

  // Infrastructure
  roads: RoadSegment[];
}

/**
 * Create a fully initialized GameState from a seed.
 * @param playerHouse - index into HOUSES[] for the player's chosen house
 */
export function createGameState(seed: number, mapSize: number, playerHouse: number = 0): GameState {
  const topo = new TopographyGenerator(mapSize, seed);
  const hydro = new HydrologyGenerator(topo, seed);
  const { duchies, regionToDuchy } = generateDuchies(topo, hydro, seed);
  const roads = generateRoads(topo, hydro, duchies);

  return {
    seed,
    turn: 0,
    season: Season.Spring,
    year: 1,
    playerDuchy: playerHouse,
    topo,
    hydro,
    duchies,
    regionToDuchy,
    roads,
  };
}

/**
 * Advance the game by one turn (one season).
 */
export function advanceTurn(state: GameState): void {
  state.turn++;
  state.season = nextSeason(state.season);
  state.year = Math.floor(state.turn / 4) + 1;
}
