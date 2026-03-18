import { useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useGameStore } from '../../store/gameStore';

const WAR_LABELS: Record<string, string> = {
  low: 'Peaceful', medium: 'Moderate', high: 'Aggressive', very_high: 'Warmonger',
};
const TRADE_LABELS: Record<string, string> = {
  low: 'Isolationist', medium: 'Moderate', high: 'Mercantile',
};
const DEMAND_LABELS: Record<string, string> = {
  quality_goods: 'Quality Goods', loyalty_tribute: 'Loyalty Tribute',
  large_quantities: 'Large Quantities', luxury: 'Luxury Items',
  combo: 'Varied Combos', military: 'Military Supplies',
  varied: 'Everything', blunt_bulk: 'Raw Bulk', mild: 'Modest Requests',
};

function FavorBar({ value }: { value: number }) {
  const color = value >= 60 ? '#4a8' : value >= 30 ? '#ca0' : '#c44';
  return (
    <div className="king-favor">
      <div className="king-favor-header">
        <span>Favor</span>
        <span style={{ color, fontWeight: 700 }}>{value}</span>
      </div>
      <div className="king-favor-bar-bg">
        <div className="king-favor-bar-fill" style={{ width: `${value}%`, background: color }} />
      </div>
    </div>
  );
}

export function KingPanel() {
  const { openPanel, setOpenPanel } = useUIStore();
  const { king, playerEconomy } = useGameStore();
  const [imgFailed, setImgFailed] = useState(false);

  if (openPanel !== 'king' || !king) return null;

  const favor = playerEconomy?.kingsFavor ?? 50;

  return (
    <div className="modal-backdrop" onClick={() => setOpenPanel(null)}>
      <div className="modal-box king-box" onClick={e => e.stopPropagation()}>
        <button className="panel-close" onClick={() => setOpenPanel(null)}>✕</button>

        <div className="king-header">
          {!imgFailed ? (
            <img
              className="king-portrait"
              src={king.portraitUrl}
              alt={king.name}
              onError={() => setImgFailed(true)}
            />
          ) : (
            <span className="king-portrait-fallback">👑</span>
          )}
          <div className="king-header-text">
            <h3 className="king-name">{king.name}</h3>
            <span className="king-title">{king.title}</span>
            <span className="king-personality">{king.personality}</span>
          </div>
        </div>

        <FavorBar value={favor} />

        <div className="king-traits">
          <div className="king-trait-row">
            <span className="king-trait-label">Demands</span>
            <span className="king-trait-value">{DEMAND_LABELS[king.demandStyle] ?? king.demandStyle}</span>
          </div>
          <div className="king-trait-row">
            <span className="king-trait-label">Prefers</span>
            <span className="king-trait-value">{king.preferredResources.join(', ')}</span>
          </div>
          <div className="king-trait-row">
            <span className="king-trait-label">War</span>
            <span className="king-trait-value">{WAR_LABELS[king.warTendency] ?? king.warTendency}</span>
          </div>
          <div className="king-trait-row">
            <span className="king-trait-label">Trade</span>
            <span className="king-trait-value">{TRADE_LABELS[king.tradeTendency] ?? king.tradeTendency}</span>
          </div>
          <div className="king-trait-row">
            <span className="king-trait-label">Bribery</span>
            <span className="king-trait-value" style={{ color: king.bribeMod >= 0 ? '#4a8' : '#c44' }}>
              {king.bribeMod >= 0 ? 'Receptive' : 'Resistant'} ({king.bribeMod > 0 ? '+' : ''}{(king.bribeMod * 100).toFixed(0)}%)
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
