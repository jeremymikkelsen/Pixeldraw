import { useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useGameStore } from '../../store/gameStore';
import {
  BUILDING_CATEGORIES,
  BUILDING_DEFS,
  getBuildingsInCategory,
  canAffordBuilding,
  formatCost,
  formatYields,
  type BuildingCategory,
  type BuildingDef,
  type BuildingType,
} from '../../state/Building';

const COST_ICONS: Record<string, string> = {
  timber: '🪵', ore: '⛏️', stone: '🪨', iron: '⚙️',
  cloth: '🧵', gold: '💰', grain: '🌾',
};

function BuildingCard({ def, affordable }: { def: BuildingDef; affordable: boolean }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={`bm-card${!affordable ? ' bm-card--disabled' : ''}`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="bm-card-header">
        <span className="bm-card-icon">{def.icon}</span>
        <div className="bm-card-info">
          <span className="bm-card-name">{def.label}</span>
          <span className="bm-card-yields">{formatYields(def.yields)}</span>
        </div>
        <span className="bm-card-chevron">{expanded ? '▾' : '▸'}</span>
      </div>

      {expanded && (
        <div className="bm-card-details">
          <p className="bm-card-desc">{def.description}</p>

          <div className="bm-card-cost-row">
            <span className="bm-card-cost-label">Cost:</span>
            <span className="bm-card-cost-items">
              {Object.entries(def.cost).map(([res, amt]) => (
                <span key={res} className="bm-cost-item">
                  {COST_ICONS[res] ?? ''} {amt}
                </span>
              ))}
              {Object.keys(def.cost).length === 0 && <span className="bm-cost-free">Free</span>}
            </span>
          </div>

          {def.workers && (
            <div className="bm-card-workers">
              Requires {def.workers.count} {def.workers.role}
            </div>
          )}

          {def.favorOnBuild > 0 && (
            <div className="bm-card-favor">+{def.favorOnBuild} King's favor</div>
          )}

          {def.notes && (
            <div className="bm-card-notes">{def.notes}</div>
          )}

          <div className="bm-card-terrain">
            Terrain: {def.validTerrain.join(', ')}
            {def.requiresRiver && ' (river)'}
            {def.requiresForest && ' (forest)'}
          </div>

          {!affordable && (
            <div className="bm-card-cannot">Cannot afford</div>
          )}
        </div>
      )}
    </div>
  );
}

export function BuildMenu() {
  const { openPanel, setOpenPanel } = useUIStore();
  const { playerEconomy } = useGameStore();
  const [activeCategory, setActiveCategory] = useState<BuildingCategory>('food_production');

  if (openPanel !== 'build' || !playerEconomy) return null;

  const buildings = getBuildingsInCategory(activeCategory);
  const resources = playerEconomy.resources as unknown as Record<string, number>;

  return (
    <div className="modal-backdrop" onClick={() => setOpenPanel(null)}>
      <div className="modal-box bm-box" onClick={e => e.stopPropagation()}>
        <button className="panel-close" onClick={() => setOpenPanel(null)}>✕</button>
        <h3>🏗️ Buildings & Improvements</h3>

        {/* Category tabs */}
        <div className="bm-tabs">
          {BUILDING_CATEGORIES.map(cat => (
            <button
              key={cat.key}
              className={`bm-tab${activeCategory === cat.key ? ' bm-tab--active' : ''}`}
              onClick={() => setActiveCategory(cat.key)}
              title={cat.label}
            >
              <span className="bm-tab-icon">{cat.icon}</span>
              <span className="bm-tab-label">{cat.label}</span>
            </button>
          ))}
        </div>

        {/* Building list */}
        <div className="bm-list">
          {buildings.map(def => (
            <BuildingCard
              key={def.type}
              def={def}
              affordable={canAffordBuilding(def, resources)}
            />
          ))}
        </div>

        <p className="bm-hint">Select a building to see details. Placement coming soon.</p>
      </div>
    </div>
  );
}
