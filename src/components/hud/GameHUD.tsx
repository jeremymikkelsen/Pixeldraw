import { useGameStore } from '../../store/gameStore';
import { useUIStore } from '../../store/uiStore';
import { seasonName } from '../../state/Season';
import { Season } from '../../state/Season';

const SEASON_ICONS: Record<number, string> = {
  [Season.Spring]: '🌱',
  [Season.Summer]: '☀️',
  [Season.Fall]: '🍂',
  [Season.Winter]: '❄️',
};

const ECONOMY_LABELS: Record<string, string> = {
  control: 'Command',
  incentive: 'Incentivized',
  free: 'Free Market',
};

function ShieldCrest({ color, initial }: { color: string; initial: string }) {
  return (
    <svg className="hud-shield-svg" width="28" height="32" viewBox="0 0 28 32">
      <path
        d="M2 2 L26 2 L26 20 L14 30 L2 20 Z"
        fill={color}
        stroke="rgba(255,255,255,0.28)"
        strokeWidth="1.5"
      />
      <text
        x="14" y="17"
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize="12"
        fontWeight="900"
        fill="rgba(255,255,255,0.92)"
      >
        {initial}
      </text>
    </svg>
  );
}

export function GameHUD() {
  const { playerHouse, playerDuchy, playerEconomy, season, year, zoom, onEndTurn } = useGameStore();
  const { setOpenPanel } = useUIStore();

  if (!playerHouse || !playerDuchy || season === null || !playerEconomy) return null;

  const seasonIcon = SEASON_ICONS[season] ?? '';
  const colorHex = '#' + playerHouse.color.toString(16).padStart(6, '0');
  const initial = playerHouse.name.replace('House ', '').charAt(0).toUpperCase();
  const economyLabel = ECONOMY_LABELS[playerHouse.axis] ?? playerHouse.axis;
  const { resources, population } = playerEconomy;

  return (
    <div className="hud-bar">
      {/* House identity */}
      <button className="hud-house-btn" onClick={() => setOpenPanel('duchy')} title="Open Duchy Panel">
        <ShieldCrest color={colorHex} initial={initial} />
        <div className="hud-house-btn-text">
          <span className="hud-house-btn-name" style={{ color: colorHex }}>
            {playerHouse.sigil} {playerHouse.name}
          </span>
          <span className="hud-house-btn-economy">{economyLabel}</span>
        </div>
      </button>

      {/* Resources */}
      <div className="hud-info">
        <span className="hud-resource-group hud-clickable" onClick={() => setOpenPanel('food')}>
          🌾 {resources.grain}
          <span>🐄 {resources.cattle}</span>
          <span>🐟 {resources.fish}</span>
          <span>🍎 {resources.apples}</span>
        </span>
        <span className="hud-resource-group hud-clickable" onClick={() => setOpenPanel('resources')}>
          🪵 {resources.timber}
          <span>⛏️ {resources.ore}</span>
          <span>🪨 {resources.stone}</span>
          <span>⚙️ {resources.iron}</span>
        </span>
        <span>💰 {resources.gold}</span>
        <span className="hud-clickable" onClick={() => setOpenPanel('population')}>👥 {population.total}</span>
      </div>

      {/* Season + Year + Zoom */}
      <div className="hud-season">
        <span><span className="season-icon">{seasonIcon}</span>{seasonName(season)}</span>
        <span className="season-year">Year {year} · {zoom.toFixed(2)}x</span>
      </div>

      {/* Build */}
      <button className="btn-build" onClick={() => setOpenPanel('build')} title="Buildings & Improvements">
        🏗️ Build
      </button>

      {/* End Turn */}
      <button className="btn-end-turn" onClick={() => onEndTurn?.()}>
        End Turn
      </button>
    </div>
  );
}
