export enum Season {
  Spring = 0,
  Summer = 1,
  Fall = 2,
  Winter = 3,
}

export function nextSeason(s: Season): Season {
  return ((s + 1) % 4) as Season;
}

export function seasonName(s: Season): string {
  return ['Spring', 'Summer', 'Fall', 'Winter'][s];
}
