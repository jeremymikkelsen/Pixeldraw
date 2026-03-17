import { useUIStore } from '../../store/uiStore';
import { useGameStore } from '../../store/gameStore';
import type { DevelopmentMode } from '../../state/Economy';

const DEV_MODES: { value: DevelopmentMode; label: string; desc: string }[] = [
  { value: 'command', label: 'Command', desc: 'You assign allotments directly. High control, but causes corruption and lowers morale.' },
  { value: 'incentivize', label: 'Incentivize', desc: 'You set prices and subsidies. Moderate control, balanced growth.' },
  { value: 'laissez_faire', label: 'Laissez-faire', desc: 'The market sets its own prices. Low overhead, but unpredictable shortages.' },
];

export function DuchyPanel() {
  const openPanel = useUIStore(s => s.openPanel);
  const setOpenPanel = useUIStore(s => s.setOpenPanel);
  const { playerHouse, playerDuchy, playerEconomy, gameState, setTaxRate, setDevelopmentMode } = useGameStore();

  if (openPanel !== 'duchy' || !playerHouse || !playerDuchy || !gameState || !playerEconomy) return null;

  const colorHex = '#' + playerHouse.color.toString(16).padStart(6, '0');
  const otherDuchies = gameState.duchies.filter((_, i) => i !== gameState.playerDuchy);
  const { taxRate, developmentMode } = playerEconomy;

  return (
    <div className="modal-backdrop" onClick={() => setOpenPanel(null)}>
      <div className="modal-box duchy-panel-modal" onClick={e => e.stopPropagation()}>
        <button className="panel-close" onClick={() => setOpenPanel(null)}>✕</button>

        <div className="duchy-header">
          <span className="duchy-header-sigil">{playerHouse.sigil}</span>
          <div className="duchy-header-text">
            <h3 style={{ color: colorHex, margin: 0 }}>{playerHouse.name}</h3>
            <p className="duchy-ruler-name">{playerHouse.rulerName}</p>
            <p className="duchy-ruler-epithet">{playerHouse.epithet}</p>
            <span className={`axis-badge axis-badge--${playerHouse.axis}`}>{playerHouse.axis}</span>
          </div>
        </div>

        <p style={{ fontSize: '0.83rem', color: '#c8c0b8', lineHeight: 1.5 }}>
          {playerHouse.description}
        </p>

        {/* Tax Rate */}
        <div className="fp-gov-section">
          <div className="fp-gov-label-row">
            <label htmlFor="tax-slider">💰 Tax Rate</label>
            <span className="fp-gov-value">{taxRate}%</span>
          </div>
          <input
            id="tax-slider"
            type="range"
            min={0} max={100}
            value={taxRate}
            onChange={e => setTaxRate(Number(e.target.value))}
            className="fp-slider"
          />
          <div className="fp-gov-hints">
            <span>0% — no income</span>
            <span>100% — max unrest</span>
          </div>
        </div>

        {/* Development Mode */}
        <div>
          <div className="fp-gov-mode-title">🏛️ Development Mode</div>
          {DEV_MODES.map(({ value, label, desc }) => (
            <label
              key={value}
              className={`fp-gov-mode-opt${developmentMode === value ? ' fp-gov-mode-opt--active' : ''}`}
            >
              <input
                type="radio"
                name="dev-mode"
                value={value}
                checked={developmentMode === value}
                onChange={() => setDevelopmentMode(value)}
                className="fp-radio"
              />
              <div>
                <div className="fp-gov-mode-name">{label}</div>
                <div className="fp-gov-mode-desc">{desc}</div>
              </div>
            </label>
          ))}
        </div>

        {/* Bonuses */}
        <div className="duchy-section">
          <div className="duchy-section-title">Bonuses</div>
          <div className="duchy-bonuses">
            {playerHouse.bonuses.map(b => (
              <div key={b.name} className="duchy-bonus-item">
                <div className="duchy-bonus-name">{b.name}</div>
                <div className="duchy-bonus-desc">{b.description}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Territory */}
        <div className="duchy-section">
          <div className="duchy-section-title">Territory</div>
          <p style={{ fontSize: '0.82rem', color: '#aaa' }}>
            {playerDuchy.regions.length} regions
            {playerDuchy.hasRiver && ' · River access'}
            {playerDuchy.hasForest && ' · Forested'}
          </p>
        </div>

        {/* Other Duchies */}
        {otherDuchies.length > 0 && (
          <div className="duchy-others">
            <div className="duchy-others-title">Other Duchies</div>
            <div className="duchy-others-list">
              {otherDuchies.map(d => (
                <div key={d.id} className="duchy-other-btn" title={d.house.name}>
                  <span className="duchy-other-sigil">{d.house.sigil}</span>
                  <span className="duchy-other-name">{d.house.name.replace('House ', '')}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
