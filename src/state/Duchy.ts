/**
 * Duchy data model — one of 9 houses on the map.
 * House data imported from the pixelduchy codebase.
 */

export type EconomicAxis = 'control' | 'incentive' | 'free';
export type Gender = 'male' | 'female';

/** Static data for each of the 9 houses */
export interface HouseData {
  name: string;
  rulerName: string;
  epithet: string;
  gender: Gender;
  age: number;
  axis: EconomicAxis;
  sigil: string;
  color: number;       // RGB hex
  description: string;
  bonuses: { name: string; description: string }[];
  portraitUrl: string;  // ruler portrait image
  crestUrl: string;     // house crest image
}

/** Runtime duchy state during gameplay */
export interface Duchy {
  id: number;               // 0-8
  house: HouseData;
  regions: number[];        // Voronoi region indices belonging to this duchy
  capitalRegion: number;    // Region index of the manor house tile
  hasRiver: boolean;        // At least one river region
  hasForest: boolean;       // At least one forested region
}

/**
 * The 9 houses — from the pixelduchy codebase.
 * Order: Aldren, Mira, Sera, Dorn, Crell, Vael, Orvyn, Varek, Brynn
 */
export const HOUSES: HouseData[] = [
  {
    name: 'House Aldren',
    rulerName: 'Lord Aldren',
    epithet: 'the Steadfast',
    gender: 'male',
    age: 54,
    axis: 'control',
    sigil: '\u{1F33E}', // 🌾
    color: 0x8B6914,
    description: 'Builds slowly and defensively; prefers measured growth over risk',
    bonuses: [
      { name: "Forester's Craft", description: 'Buildings cost 20% less timber' },
      { name: 'Iron Resolve', description: 'Refusing demands incurs half the favor penalty' },
      { name: 'Granary Legacy', description: 'Starts with an extra Field building' },
    ],
    portraitUrl: '/houses/duke_aldren.png',
    crestUrl: '/houses/house_aldren.png',
  },
  {
    name: 'House Mira',
    rulerName: 'Lady Mira',
    epithet: 'the Gilded',
    gender: 'female',
    age: 40,
    axis: 'incentive',
    sigil: '\u{1F4B0}', // 💰
    color: 0xC9A227,
    description: 'Leverages trade and market manipulation; gold is the answer to every problem',
    bonuses: [
      { name: "Merchant's Touch", description: 'Sell prices +15%, buy prices -15%' },
      { name: 'Silver Tongue', description: 'Petitioning costs 20% less gold' },
      { name: 'Trade Routes', description: 'Port and market produce 25% more gold' },
    ],
    portraitUrl: '/houses/duchess_mira.png',
    crestUrl: '/houses/house_mira.png',
  },
  {
    name: 'House Sera',
    rulerName: 'Lady Sera',
    epithet: 'the Favored',
    gender: 'female',
    age: 33,
    axis: 'incentive',
    sigil: '\u{1F451}', // 👑
    color: 0x7B4FA6,
    description: 'Diplomatic; builds favor quickly and leverages royal goodwill for territory',
    bonuses: [
      { name: 'Royal Connections', description: 'Starts with 65 favor instead of 50' },
      { name: 'Diplomatic Grace', description: 'Favor losses reduced by 20%' },
      { name: 'Generous Patron', description: '3 tile choices instead of 2 on fulfillment' },
    ],
    portraitUrl: '/houses/duchess_sera.png',
    crestUrl: '/houses/house_sera.png',
  },
  {
    name: 'House Dorn',
    rulerName: 'Lord Dorn',
    epithet: 'the Expansionist',
    gender: 'male',
    age: 47,
    axis: 'free',
    sigil: '\u{1F5FA}', // 🗺️
    color: 0xC04040,
    description: 'Aggressive territorial expansion; claims land faster than anyone',
    bonuses: [
      { name: 'Land Hunger', description: 'Starts with 27 tiles instead of 25' },
      { name: 'Bold Claims', description: 'Petitioning costs 20% less gold' },
      { name: "Fortune's Hand", description: '15% chance of bonus resource on tile claim' },
    ],
    portraitUrl: '/houses/duke_dorn.png',
    crestUrl: '/houses/house_dorn.png',
  },
  {
    name: 'House Crell',
    rulerName: 'Lord Crell',
    epithet: 'the Watchful',
    gender: 'male',
    age: 58,
    axis: 'control',
    sigil: '\u{1F50D}', // 🔍
    color: 0x2C5F8A,
    description: 'Intelligence-focused; uses perfect rumor networks to plan ahead',
    bonuses: [
      { name: 'Reliable Network', description: 'Tavern rumors are always accurate' },
      { name: 'Insider Knowledge', description: 'Petitioning success chance +25%' },
      { name: 'Advance Warning', description: "Autumn rumor reveals next winter's demand" },
    ],
    portraitUrl: '/houses/duke_crell.png',
    crestUrl: '/houses/house_crell.png',
  },
  {
    name: 'House Vael',
    rulerName: 'Lady Vael',
    epithet: 'the Abundant',
    gender: 'female',
    age: 44,
    axis: 'free',
    sigil: '\u{1F33F}', // 🌿
    color: 0x4A8C3F,
    description: 'Agricultural powerhouse; food surpluses automatically convert to gold',
    bonuses: [
      { name: 'Blessed Fields', description: 'Food and timber production +20%' },
      { name: 'Agrarian Tradition', description: 'Field, pasture, and orchard cost 15% less' },
      { name: 'Market Surplus', description: 'Grain above 40 auto-converts to gold at 3:1' },
    ],
    portraitUrl: '/houses/duchess_vael.png',
    crestUrl: '/houses/house_vael.png',
  },
  {
    name: 'House Orvyn',
    rulerName: 'Lord Orvyn',
    epithet: 'the Efficient',
    gender: 'male',
    age: 51,
    axis: 'control',
    sigil: '\u{2699}', // ⚙️
    color: 0x5A7A8C,
    description: 'Maximizes output from every building; less is demanded from the King',
    bonuses: [
      { name: 'Master Craftsmen', description: 'All building outputs +15%' },
      { name: 'Modest King', description: "King's demands reduced by 15%" },
      { name: 'Perfect Storage', description: "Food doesn't decay" },
    ],
    portraitUrl: '/houses/duke_orvyn.png',
    crestUrl: '/houses/house_orvyn.png',
  },
  {
    name: 'House Varek',
    rulerName: 'Lord Varek',
    epithet: 'the Iron Fist',
    gender: 'male',
    age: 49,
    axis: 'control',
    sigil: '\u{2694}', // ⚔️
    color: 0x8C2020,
    description: 'Military-oriented; pays levies cheaply and fields better armies',
    bonuses: [
      { name: 'Martial Economy', description: 'Levies cost 25% less gold and food' },
      { name: 'Barracks Builder', description: 'Barracks cost 20% less' },
      { name: "Veteran's Return", description: 'Levied citizens return faster, +20% compliance reward' },
    ],
    portraitUrl: '/houses/duke_varek.png',
    crestUrl: '/houses/house_varek.png',
  },
  {
    name: 'House Brynn',
    rulerName: 'Lady Brynn',
    epithet: 'the Unyielding',
    gender: 'female',
    age: 38,
    axis: 'free',
    sigil: '\u{1F6E1}', // 🛡️
    color: 0x6A7A6A,
    description: 'Refuses the King often; specializes in weathering favor loss',
    bonuses: [
      { name: 'Stone for Free', description: 'Barracks cost no timber' },
      { name: 'Stubborn Pride', description: 'Refusing levy incurs 70% of normal favor penalty' },
      { name: 'Hardened Folk', description: '+15% favor reward at war end' },
    ],
    portraitUrl: '/houses/duchess_brynn.png',
    crestUrl: '/houses/house_brynn.png',
  },
];

/** Convenience: extract just colors for rendering */
export const DUCHY_COLORS: number[] = HOUSES.map(h => h.color);

/** Convenience: extract just names for display */
export const DUCHY_NAMES: string[] = HOUSES.map(h => h.name);
