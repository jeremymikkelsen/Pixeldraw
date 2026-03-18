/**
 * King data — from the pixelduchy codebase.
 * 9 kings based on Enneagram personality types.
 */

export type DemandStyle =
  | 'quality_goods'
  | 'loyalty_tribute'
  | 'large_quantities'
  | 'luxury'
  | 'combo'
  | 'military'
  | 'varied'
  | 'blunt_bulk'
  | 'mild';

export type WarTendency = 'low' | 'medium' | 'high' | 'very_high';
export type TradeTendency = 'low' | 'medium' | 'high';
export type MoodTendency = 'low' | 'medium' | 'high';

export interface KingData {
  id: string;
  name: string;
  title: string;
  personality: string;
  demandStyle: DemandStyle;
  preferredResources: string[];
  warTendency: WarTendency;
  tradeTendency: TradeTendency;
  moodTendency: MoodTendency;
  bribeMod: number;
  portraitUrl: string;
}

export const KINGS: KingData[] = [
  {
    id: 'rectus',
    name: 'King Rectus',
    title: 'the Unblemished',
    personality: 'Reformer',
    demandStyle: 'quality_goods',
    preferredResources: ['bread', 'cloth', 'pie', 'grain'],
    warTendency: 'low',
    tradeTendency: 'medium',
    moodTendency: 'low',
    bribeMod: -0.1,
    portraitUrl: '/kings/rectus.png',
  },
  {
    id: 'cordan',
    name: 'King Cordan',
    title: 'the Beloved',
    personality: 'Helper',
    demandStyle: 'loyalty_tribute',
    preferredResources: ['gold', 'pie', 'cloth', 'cattle'],
    warTendency: 'medium',
    tradeTendency: 'high',
    moodTendency: 'high',
    bribeMod: 0.15,
    portraitUrl: '/kings/cordan.png',
  },
  {
    id: 'valorian',
    name: 'King Valorian',
    title: 'the Gilded',
    personality: 'Achiever',
    demandStyle: 'large_quantities',
    preferredResources: ['gold', 'grain', 'timber', 'stone'],
    warTendency: 'medium',
    tradeTendency: 'high',
    moodTendency: 'medium',
    bribeMod: 0.1,
    portraitUrl: '/kings/valorian.png',
  },
  {
    id: 'melanvar',
    name: 'King Melanvar',
    title: 'the Longing',
    personality: 'Individualist',
    demandStyle: 'luxury',
    preferredResources: ['spice', 'cloth', 'pie', 'apples'],
    warTendency: 'low',
    tradeTendency: 'medium',
    moodTendency: 'high',
    bribeMod: 0.05,
    portraitUrl: '/kings/melanvar.png',
  },
  {
    id: 'observian',
    name: 'King Observian',
    title: 'the Watchful',
    personality: 'Investigator',
    demandStyle: 'combo',
    preferredResources: ['gold', 'grain', 'iron', 'stone'],
    warTendency: 'low',
    tradeTendency: 'medium',
    moodTendency: 'low',
    bribeMod: -0.05,
    portraitUrl: '/kings/observian.png',
  },
  {
    id: 'fidoran',
    name: 'King Fidoran',
    title: 'the Vigilant',
    personality: 'Loyalist',
    demandStyle: 'military',
    preferredResources: ['gold', 'iron', 'grain', 'cloth'],
    warTendency: 'high',
    tradeTendency: 'low',
    moodTendency: 'medium',
    bribeMod: -0.15,
    portraitUrl: '/kings/fidoran.png',
  },
  {
    id: 'exulian',
    name: 'King Exulian',
    title: 'the Boundless',
    personality: 'Enthusiast',
    demandStyle: 'varied',
    preferredResources: ['spice', 'cloth', 'gold', 'apples', 'grain'],
    warTendency: 'high',
    tradeTendency: 'high',
    moodTendency: 'high',
    bribeMod: 0.1,
    portraitUrl: '/kings/exulian.png',
  },
  {
    id: 'domarus',
    name: 'King Domarus',
    title: 'the Iron',
    personality: 'Challenger',
    demandStyle: 'blunt_bulk',
    preferredResources: ['grain', 'timber', 'ore', 'stone', 'iron'],
    warTendency: 'very_high',
    tradeTendency: 'low',
    moodTendency: 'medium',
    bribeMod: -0.2,
    portraitUrl: '/kings/domarus.png',
  },
  {
    id: 'pacivus',
    name: 'King Pacivus',
    title: 'the Still',
    personality: 'Peacemaker',
    demandStyle: 'mild',
    preferredResources: ['grain', 'apples', 'cloth', 'gold'],
    warTendency: 'low',
    tradeTendency: 'medium',
    moodTendency: 'low',
    bribeMod: 0.05,
    portraitUrl: '/kings/pacivus.png',
  },
];

/** Select a king deterministically from a seed */
export function selectKing(seed: number): KingData {
  return KINGS[((seed >>> 0) % KINGS.length)];
}
