/**
 * Building data model — types, costs, yields, placement rules.
 * Adapted from the pixelduchy codebase to work with pixeldraw's
 * Voronoi terrain types (ocean, water, coast, lowland, highland, rock, cliff).
 */

import type { ResourceType } from './Economy';

// ─── Building types ─────────────────────────────────────────────────────────

export type BuildingType =
  // Food production
  | 'field' | 'pasture' | 'orchard' | 'fishery'
  // Food processing
  | 'smokehouse' | 'kitchen'
  // Resource production
  | 'woodcutter' | 'sawmill' | 'mill' | 'mine' | 'quarry' | 'bog_mine'
  // Processing
  | 'smelter'
  // Economic
  | 'market' | 'port'
  // Military
  | 'barracks'
  // Social / governance
  | 'church' | 'castle' | 'tavern'
  // Residential
  | 'house';

export type BuildingCategory =
  | 'food_production'
  | 'food_processing'
  | 'resource_production'
  | 'processing'
  | 'economic'
  | 'military'
  | 'social'
  | 'residential';

// ─── Building definition ────────────────────────────────────────────────────

export interface BuildingCost {
  timber?: number;
  ore?: number;
  stone?: number;
  iron?: number;
  cloth?: number;
  gold?: number;
  grain?: number;
}

export interface BuildingYield {
  resource: ResourceType;
  amount: number;
}

export interface WorkerRequirement {
  role: 'farmers' | 'lumberjacks' | 'miners' | 'quarrymen' | 'smiths';
  count: number;
}

export interface BuildingDef {
  type: BuildingType;
  label: string;
  icon: string;
  mapLabel: string;
  category: BuildingCategory;
  description: string;
  cost: BuildingCost;
  yields: BuildingYield[];
  favorOnBuild: number;
  workers?: WorkerRequirement;
  /** Terrain types where this building can be placed */
  validTerrain: string[];
  /** Additional placement constraints */
  requiresRiver?: boolean;
  requiresForest?: boolean;
  /** Special notes for the player */
  notes?: string;
}

// ─── Building instance ──────────────────────────────────────────────────────

export interface BuildingInstance {
  id: number;
  type: BuildingType;
  region: number;       // Voronoi region index
  level: number;        // 1-based
  duchyIndex: number;   // which duchy owns it
}

// ─── All building definitions ───────────────────────────────────────────────

export const BUILDING_DEFS: Record<BuildingType, BuildingDef> = {
  // ── Food production ─────────────────────────────────────────────
  field: {
    type: 'field',
    label: 'Field',
    icon: '🌾',
    mapLabel: 'FLD',
    category: 'food_production',
    description: 'Cultivates grain on fertile lowland soil.',
    cost: { timber: 2 },
    yields: [{ resource: 'grain', amount: 3 }],
    favorOnBuild: 0,
    workers: { role: 'farmers', count: 3 },
    validTerrain: ['lowland'],
  },
  pasture: {
    type: 'pasture',
    label: 'Pasture',
    icon: '🐄',
    mapLabel: 'PST',
    category: 'food_production',
    description: 'Raises cattle on open grassland.',
    cost: { timber: 3 },
    yields: [{ resource: 'cattle', amount: 2 }],
    favorOnBuild: 0,
    workers: { role: 'farmers', count: 3 },
    validTerrain: ['lowland', 'highland'],
  },
  orchard: {
    type: 'orchard',
    label: 'Orchard',
    icon: '🍎',
    mapLabel: 'ORC',
    category: 'food_production',
    description: 'Grows apple trees for seasonal harvests.',
    cost: { timber: 2 },
    yields: [{ resource: 'apples', amount: 2 }],
    favorOnBuild: 0,
    workers: { role: 'farmers', count: 2 },
    validTerrain: ['lowland'],
  },
  fishery: {
    type: 'fishery',
    label: 'Fishery',
    icon: '🐟',
    mapLabel: 'FSH',
    category: 'food_production',
    description: 'Nets fish from rivers, lakes, and coastal waters.',
    cost: { timber: 4 },
    yields: [{ resource: 'fish', amount: 3 }],
    favorOnBuild: 0,
    workers: { role: 'farmers', count: 2 },
    validTerrain: ['water', 'coast'],
    requiresRiver: true,
  },

  // ── Food processing ─────────────────────────────────────────────
  smokehouse: {
    type: 'smokehouse',
    label: 'Smokehouse',
    icon: '🥩',
    mapLabel: 'SMK',
    category: 'food_processing',
    description: 'Preserves meat through smoking.',
    cost: { timber: 3 },
    yields: [{ resource: 'smoked_meat', amount: 2 }],
    favorOnBuild: 0,
    validTerrain: ['lowland', 'highland', 'coast'],
  },
  kitchen: {
    type: 'kitchen',
    label: 'Kitchen',
    icon: '🍞',
    mapLabel: 'KTC',
    category: 'food_processing',
    description: 'Bakes bread from grain stores.',
    cost: { timber: 2, grain: 1 },
    yields: [{ resource: 'bread', amount: 2 }],
    favorOnBuild: 0,
    validTerrain: ['lowland', 'highland', 'coast'],
  },

  // ── Resource production ─────────────────────────────────────────
  woodcutter: {
    type: 'woodcutter',
    label: 'Woodcutter',
    icon: '🪓',
    mapLabel: 'WDC',
    category: 'resource_production',
    description: 'Fells trees for timber in forested regions.',
    cost: { timber: 1 },
    yields: [{ resource: 'timber', amount: 1 }],
    favorOnBuild: 0,
    workers: { role: 'lumberjacks', count: 2 },
    validTerrain: ['lowland', 'highland'],
    requiresForest: true,
  },
  sawmill: {
    type: 'sawmill',
    label: 'Sawmill',
    icon: '🪚',
    mapLabel: 'SAW',
    category: 'resource_production',
    description: 'Processes logs into quality timber using river power.',
    cost: { timber: 3, grain: 2 },
    yields: [{ resource: 'timber', amount: 5 }],
    favorOnBuild: 0,
    workers: { role: 'lumberjacks', count: 4 },
    validTerrain: ['lowland', 'highland'],
    requiresRiver: true,
  },
  mill: {
    type: 'mill',
    label: 'Mill',
    icon: '🏭',
    mapLabel: 'MLI',
    category: 'resource_production',
    description: 'Grinds grain; built on hills or beside rivers.',
    cost: { grain: 5, timber: 3 },
    yields: [{ resource: 'grain', amount: 4 }],
    favorOnBuild: 0,
    validTerrain: ['highland'],
    notes: 'Also placeable on river tiles',
  },
  mine: {
    type: 'mine',
    label: 'Mine',
    icon: '⛏️',
    mapLabel: 'MNE',
    category: 'resource_production',
    description: 'Extracts ore from mountain rock.',
    cost: { timber: 4 },
    yields: [{ resource: 'ore', amount: 4 }],
    favorOnBuild: 0,
    workers: { role: 'miners', count: 4 },
    validTerrain: ['rock', 'cliff'],
  },
  quarry: {
    type: 'quarry',
    label: 'Quarry',
    icon: '🪨',
    mapLabel: 'QRY',
    category: 'resource_production',
    description: 'Cuts stone from highland and mountain terrain.',
    cost: { timber: 3, ore: 1 },
    yields: [{ resource: 'stone', amount: 2 }],
    favorOnBuild: 0,
    workers: { role: 'quarrymen', count: 4 },
    validTerrain: ['highland', 'rock', 'cliff'],
  },
  bog_mine: {
    type: 'bog_mine',
    label: 'Bog Mine',
    icon: '🫧',
    mapLabel: 'BGM',
    category: 'resource_production',
    description: 'Harvests bog iron from wetland deposits.',
    cost: { timber: 2 },
    yields: [{ resource: 'ore', amount: 1 }],
    favorOnBuild: 0,
    workers: { role: 'miners', count: 2 },
    validTerrain: ['coast'],
    notes: 'Found in marshy coastal areas',
  },

  // ── Processing ──────────────────────────────────────────────────
  smelter: {
    type: 'smelter',
    label: 'Smelter',
    icon: '🔥',
    mapLabel: 'SMT',
    category: 'processing',
    description: 'Converts ore into iron bars. Consumes 2 ore per level per turn.',
    cost: { timber: 4, stone: 2 },
    yields: [{ resource: 'iron', amount: 2 }],
    favorOnBuild: 0,
    workers: { role: 'smiths', count: 3 },
    validTerrain: ['lowland', 'highland', 'coast'],
    notes: 'Consumes 2 ore → produces 2 iron',
  },

  // ── Economic ────────────────────────────────────────────────────
  market: {
    type: 'market',
    label: 'Market',
    icon: '🏪',
    mapLabel: 'MKT',
    category: 'economic',
    description: 'A trading post that generates gold through commerce.',
    cost: { gold: 3, cloth: 2 },
    yields: [{ resource: 'gold', amount: 3 }],
    favorOnBuild: 0,
    validTerrain: ['lowland', 'coast'],
  },
  port: {
    type: 'port',
    label: 'Port',
    icon: '⚓',
    mapLabel: 'PRT',
    category: 'economic',
    description: 'Harbor for fishing and overseas trade.',
    cost: { timber: 6 },
    yields: [
      { resource: 'fish', amount: 3 },
      { resource: 'gold', amount: 1 },
    ],
    favorOnBuild: 0,
    validTerrain: ['water', 'coast'],
  },

  // ── Military ────────────────────────────────────────────────────
  barracks: {
    type: 'barracks',
    label: 'Barracks',
    icon: '⚔️',
    mapLabel: 'BRK',
    category: 'military',
    description: 'Trains soldiers and increases military strength.',
    cost: { timber: 5, ore: 4 },
    yields: [],
    favorOnBuild: 0,
    validTerrain: ['lowland', 'highland'],
    notes: 'Provides military strength',
  },

  // ── Social / governance ─────────────────────────────────────────
  church: {
    type: 'church',
    label: 'Church',
    icon: '⛪',
    mapLabel: 'CHR',
    category: 'social',
    description: "A place of worship that increases the King's favor.",
    cost: { timber: 4, gold: 2 },
    yields: [],
    favorOnBuild: 3,
    validTerrain: ['lowland', 'highland', 'coast'],
    notes: "+3 King's favor on construction",
  },
  castle: {
    type: 'castle',
    label: 'Castle',
    icon: '🏰',
    mapLabel: 'CST',
    category: 'social',
    description: 'A fortified seat of power. Generates gold and commands respect.',
    cost: { timber: 8, ore: 6, gold: 4 },
    yields: [{ resource: 'gold', amount: 2 }],
    favorOnBuild: 0,
    validTerrain: ['lowland', 'highland', 'coast'],
  },
  tavern: {
    type: 'tavern',
    label: 'Tavern',
    icon: '🍺',
    mapLabel: 'TVR',
    category: 'social',
    description: 'Gathering place for rumors and information.',
    cost: { timber: 3, gold: 2 },
    yields: [],
    favorOnBuild: 0,
    validTerrain: ['lowland', 'highland', 'coast'],
    notes: 'Provides access to tavern rumors',
  },

  // ── Residential ─────────────────────────────────────────────────
  house: {
    type: 'house',
    label: 'House',
    icon: '🏠',
    mapLabel: 'HSE',
    category: 'residential',
    description: 'Shelter for your people. Each house adds population capacity.',
    cost: { timber: 2, grain: 1 },
    yields: [],
    favorOnBuild: 0,
    validTerrain: ['lowland'],
    notes: '+10 population capacity',
  },
};

// ─── Category metadata ──────────────────────────────────────────────────────

export interface CategoryMeta {
  key: BuildingCategory;
  label: string;
  icon: string;
}

export const BUILDING_CATEGORIES: CategoryMeta[] = [
  { key: 'food_production',    label: 'Food',       icon: '🌾' },
  { key: 'food_processing',    label: 'Processing', icon: '🍞' },
  { key: 'resource_production', label: 'Resources', icon: '🪵' },
  { key: 'processing',         label: 'Smelting',   icon: '🔥' },
  { key: 'economic',           label: 'Economy',    icon: '💰' },
  { key: 'military',           label: 'Military',   icon: '⚔️' },
  { key: 'social',             label: 'Governance', icon: '⛪' },
  { key: 'residential',        label: 'Housing',    icon: '🏠' },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

export const ALL_BUILDING_TYPES: BuildingType[] = Object.keys(BUILDING_DEFS) as BuildingType[];

/** Get all building defs in a given category */
export function getBuildingsInCategory(cat: BuildingCategory): BuildingDef[] {
  return ALL_BUILDING_TYPES
    .map(t => BUILDING_DEFS[t])
    .filter(d => d.category === cat);
}

/** Check if a building can be placed on a given terrain */
export function canPlaceOnTerrain(
  building: BuildingDef,
  terrainType: string,
  hasRiver: boolean,
  hasForest: boolean,
): boolean {
  // Mill has special river placement rule
  if (building.type === 'mill' && hasRiver) return true;
  // Fishery can go on river tiles regardless of terrain
  if (building.type === 'fishery' && hasRiver) return true;
  // Sawmill needs river or forest
  if (building.type === 'sawmill' && !hasRiver) return false;

  if (!building.validTerrain.includes(terrainType)) return false;
  if (building.requiresForest && !hasForest) return false;

  return true;
}

/** Check if a duchy can afford a building */
export function canAffordBuilding(
  building: BuildingDef,
  resources: Record<string, number>,
): boolean {
  for (const [res, amount] of Object.entries(building.cost)) {
    if ((resources[res] ?? 0) < (amount ?? 0)) return false;
  }
  return true;
}

/** Format cost as a readable string */
export function formatCost(cost: BuildingCost): string {
  const parts: string[] = [];
  if (cost.timber)  parts.push(`${cost.timber} timber`);
  if (cost.ore)     parts.push(`${cost.ore} ore`);
  if (cost.stone)   parts.push(`${cost.stone} stone`);
  if (cost.iron)    parts.push(`${cost.iron} iron`);
  if (cost.cloth)   parts.push(`${cost.cloth} cloth`);
  if (cost.gold)    parts.push(`${cost.gold} gold`);
  if (cost.grain)   parts.push(`${cost.grain} grain`);
  return parts.join(', ') || 'Free';
}

/** Format yields as a readable string */
export function formatYields(yields: BuildingYield[]): string {
  if (yields.length === 0) return '—';
  return yields.map(y => `+${y.amount} ${y.resource.replace('_', ' ')}`).join(', ');
}
