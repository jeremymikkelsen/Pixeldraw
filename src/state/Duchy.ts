/**
 * Duchy data model — one of 9 houses on the map.
 */

export interface Duchy {
  id: number;               // 0-8
  name: string;
  color: number;            // RGB hex (e.g. 0xCC3333)
  regions: number[];        // Voronoi region indices belonging to this duchy
  capitalRegion: number;    // Region index of the manor house tile
  hasRiver: boolean;        // Validation: at least one river region
  hasForest: boolean;       // Validation: at least one forested region
}

/** Duchy colors — 9 distinct, vibrant colors for territory tinting */
export const DUCHY_COLORS: number[] = [
  0xCC3333, // Red
  0x3366CC, // Blue
  0x33AA33, // Green
  0xCC9933, // Gold
  0x9933CC, // Purple
  0x33AAAA, // Teal
  0xCC6633, // Orange
  0x6633AA, // Indigo
  0xAA3366, // Rose
];

/** Placeholder duchy names */
export const DUCHY_NAMES: string[] = [
  'House Aldric',
  'House Brynmor',
  'House Caswell',
  'House Dunwall',
  'House Everhart',
  'House Fairholm',
  'House Greymane',
  'House Highcrest',
  'House Ironvale',
];
