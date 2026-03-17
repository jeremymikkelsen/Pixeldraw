/**
 * Economy system — resource types, duchy economy state, and turn processing.
 * Adapted from pixelduchy's tile-based economy to work with Voronoi regions.
 */

// ─── Resource types ──────────────────────────────────────────────────────────

export type ResourceType =
  | 'timber' | 'ore' | 'stone' | 'iron' | 'cloth' | 'spice' | 'gold'
  | 'grain' | 'cattle' | 'fish' | 'deer' | 'apples'
  | 'bread' | 'cheese' | 'smoked_meat' | 'pie';

export type RationLevel = 'none' | 'meager' | 'normal' | 'extra';
export type DevelopmentMode = 'command' | 'incentivize' | 'laissez_faire';

export interface Resources {
  timber: number; ore: number; stone: number; iron: number;
  cloth: number; spice: number; gold: number;
  grain: number; cattle: number; fish: number; deer: number; apples: number;
  bread: number; cheese: number; smoked_meat: number; pie: number;
}

export interface Population {
  total: number;
  farmers: number;
  artisans: number;
  merchants: number;
  soldiers: number;
  happiness: number; // 0–100
}

export interface LaborAssignment {
  farmers: number;
  lumberjacks: number;
  miners: number;
  quarrymen: number;
  smiths: number;
  unemployed: number;
}

export interface FoodLedger {
  produced: number;
  eaten: number;
  spoiled: number;
}

export interface DuchyEconomy {
  resources: Resources;
  population: Population;
  laborAssignment: LaborAssignment;
  rationLevel: RationLevel;
  developmentMode: DevelopmentMode;
  foodLedger: FoodLedger;
  foodEatOrder: ResourceType[];
  taxRate: number;         // 0–100
  kingsFavor: number;      // 0–100
  militaryStrength: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const RATION_MULTIPLIERS: Record<RationLevel, number> = {
  none: 0, meager: 0.5, normal: 1.0, extra: 1.5,
};

export const HAPPINESS_FROM_RATIONS: Record<RationLevel, number> = {
  none: -10, meager: -5, normal: 0, extra: 3,
};

export const FOOD_KEYS: ResourceType[] = [
  'grain', 'bread', 'cattle', 'smoked_meat', 'fish', 'cheese', 'apples', 'pie', 'deer',
];

const RESOURCE_KEYS: ResourceType[] = ['timber', 'ore', 'stone', 'iron', 'cloth'];

export function emptyResources(): Resources {
  return {
    timber: 0, ore: 0, stone: 0, iron: 0, cloth: 0, spice: 0, gold: 0,
    grain: 0, cattle: 0, fish: 0, deer: 0, apples: 0,
    bread: 0, cheese: 0, smoked_meat: 0, pie: 0,
  };
}

export function starterResources(): Resources {
  return {
    grain: 20, timber: 15, ore: 8, stone: 0, iron: 0,
    cloth: 5, fish: 5, spice: 0, gold: 10,
    cattle: 0, deer: 0, apples: 0,
    bread: 0, cheese: 0, smoked_meat: 0, pie: 0,
  };
}

export function defaultPopulation(): Population {
  return { total: 100, farmers: 60, artisans: 20, merchants: 15, soldiers: 5, happiness: 70 };
}

export function defaultLabor(): LaborAssignment {
  return { farmers: 0, lumberjacks: 0, miners: 0, quarrymen: 0, smiths: 0, unemployed: 100 };
}

export function createDuchyEconomy(startingFavor: number = 50): DuchyEconomy {
  return {
    resources: starterResources(),
    population: defaultPopulation(),
    laborAssignment: defaultLabor(),
    rationLevel: 'normal',
    developmentMode: 'laissez_faire',
    foodLedger: { produced: 0, eaten: 0, spoiled: 0 },
    foodEatOrder: [...FOOD_KEYS],
    taxRate: 20,
    kingsFavor: startingFavor,
    militaryStrength: 10,
  };
}

// ─── Production ──────────────────────────────────────────────────────────────

/**
 * Compute per-turn resource production for a duchy based on its terrain composition.
 * This is a simplified model — buildings will refine this later.
 */
export interface TerrainCounts {
  lowland: number;
  highland: number;
  coast: number;
  water: number;
  rock: number;
  cliff: number;
  total: number;
  hasRiver: boolean;
  hasForest: boolean;
}

export function computeProduction(terrain: TerrainCounts, labor: LaborAssignment): Partial<Record<ResourceType, number>> {
  const prod: Partial<Record<ResourceType, number>> = {};

  // Base production from terrain
  prod.grain = Math.floor(terrain.lowland * 0.4);
  prod.cattle = Math.floor(terrain.lowland * 0.15);
  prod.timber = Math.floor((terrain.lowland + terrain.highland) * 0.2);
  prod.ore = Math.floor(terrain.rock * 0.5 + terrain.cliff * 0.3);
  prod.stone = Math.floor(terrain.rock * 0.3 + terrain.cliff * 0.5);
  prod.gold = Math.floor(terrain.total * 0.05) + (terrain.coast > 0 ? 1 : 0);

  if (terrain.hasRiver) {
    prod.fish = Math.floor(terrain.total * 0.1) + 2;
  }
  if (terrain.hasForest) {
    prod.timber = (prod.timber ?? 0) + 3;
    prod.deer = 1;
    prod.apples = 1;
  }

  // Labor bonuses
  prod.grain = (prod.grain ?? 0) + labor.farmers;
  prod.timber = (prod.timber ?? 0) + labor.lumberjacks;
  prod.ore = (prod.ore ?? 0) + labor.miners;
  prod.stone = (prod.stone ?? 0) + labor.quarrymen;
  prod.iron = (prod.iron ?? 0) + labor.smiths;

  return prod;
}

// ─── Turn processing ─────────────────────────────────────────────────────────

export function processEconomyTurn(
  economy: DuchyEconomy,
  terrain: TerrainCounts,
): DuchyEconomy {
  const eco = structuredClone(economy);

  // 1. Harvest resources
  const production = computeProduction(terrain, eco.laborAssignment);
  let totalProduced = 0;
  for (const [key, amt] of Object.entries(production)) {
    const k = key as ResourceType;
    eco.resources[k] += amt ?? 0;
    if (FOOD_KEYS.includes(k)) totalProduced += amt ?? 0;
  }

  // 2. Tax income
  const taxGold = Math.floor(eco.population.total * eco.taxRate * 0.005);
  eco.resources.gold += taxGold;

  // 3. Food consumption
  const eatAmount = Math.round(eco.population.total * RATION_MULTIPLIERS[eco.rationLevel]);
  let eatRemaining = eatAmount;
  let totalEaten = 0;
  for (const key of eco.foodEatOrder) {
    if (eatRemaining <= 0) break;
    const take = Math.min(eco.resources[key] ?? 0, eatRemaining);
    eco.resources[key] -= take;
    eatRemaining -= take;
    totalEaten += take;
  }

  // 4. Spoilage (2% of remaining food)
  const totalFoodRemaining = FOOD_KEYS.reduce((s, k) => s + (eco.resources[k] ?? 0), 0);
  let spoilAmount = Math.ceil(totalFoodRemaining * 0.02);
  let totalSpoiled = 0;
  for (const key of eco.foodEatOrder) {
    if (spoilAmount <= 0) break;
    const take = Math.min(eco.resources[key] ?? 0, spoilAmount);
    eco.resources[key] -= take;
    spoilAmount -= take;
    totalSpoiled += take;
  }

  eco.foodLedger = { produced: totalProduced, eaten: totalEaten, spoiled: totalSpoiled };

  // 5. Happiness
  eco.population.happiness = Math.max(0, Math.min(100,
    eco.population.happiness
    + HAPPINESS_FROM_RATIONS[eco.rationLevel]
    - Math.floor(eco.taxRate / 25) // high taxes reduce happiness
    + (eatRemaining > 0 ? -5 : 0)  // starvation penalty
  ));

  // 6. Population growth/decline
  const happiness = eco.population.happiness;
  const immigration = happiness > 60 ? Math.floor((happiness - 60) / 10) : 0;
  const emigration = happiness < 30 ? Math.floor((30 - happiness) / 10) : 0;
  eco.population.total = Math.max(10, eco.population.total + immigration - emigration);

  // Redistribute population
  const total = eco.population.total;
  eco.population.farmers = Math.floor(total * 0.55);
  eco.population.artisans = Math.floor(total * 0.20);
  eco.population.merchants = Math.floor(total * 0.15);
  eco.population.soldiers = total - eco.population.farmers - eco.population.artisans - eco.population.merchants;

  // Update labor unemployed count
  const assigned = eco.laborAssignment.farmers + eco.laborAssignment.lumberjacks
    + eco.laborAssignment.miners + eco.laborAssignment.quarrymen + eco.laborAssignment.smiths;
  eco.laborAssignment.unemployed = Math.max(0, total - assigned);

  // Clamp labor assignments to population
  if (assigned > total) {
    const scale = total / assigned;
    eco.laborAssignment.farmers = Math.floor(eco.laborAssignment.farmers * scale);
    eco.laborAssignment.lumberjacks = Math.floor(eco.laborAssignment.lumberjacks * scale);
    eco.laborAssignment.miners = Math.floor(eco.laborAssignment.miners * scale);
    eco.laborAssignment.quarrymen = Math.floor(eco.laborAssignment.quarrymen * scale);
    eco.laborAssignment.smiths = Math.floor(eco.laborAssignment.smiths * scale);
    const newAssigned = eco.laborAssignment.farmers + eco.laborAssignment.lumberjacks
      + eco.laborAssignment.miners + eco.laborAssignment.quarrymen + eco.laborAssignment.smiths;
    eco.laborAssignment.unemployed = Math.max(0, total - newAssigned);
  }

  return eco;
}

// ─── Terrain counting ────────────────────────────────────────────────────────

/**
 * Count terrain types within a duchy's regions.
 */
export function countTerrain(
  regions: number[],
  terrainTypes: string[],
  hasRiver: boolean,
  hasForest: boolean,
): TerrainCounts {
  const counts: TerrainCounts = {
    lowland: 0, highland: 0, coast: 0, water: 0, rock: 0, cliff: 0,
    total: regions.length, hasRiver, hasForest,
  };

  for (const r of regions) {
    const t = terrainTypes[r];
    if (t === 'lowland') counts.lowland++;
    else if (t === 'highland') counts.highland++;
    else if (t === 'coast') counts.coast++;
    else if (t === 'water' || t === 'ocean') counts.water++;
    else if (t === 'rock') counts.rock++;
    else if (t === 'cliff') counts.cliff++;
    else counts.lowland++; // default
  }

  return counts;
}
