import { useUIStore } from '../../store/uiStore';
import { useGameStore } from '../../store/gameStore';

export function DuchyPanel() {
  const openPanel = useUIStore(s => s.openPanel);
  const setOpenPanel = useUIStore(s => s.setOpenPanel);
  const { playerHouse, playerDuchy, gameState } = useGameStore();

  if (openPanel !== 'duchy' || !playerHouse || !playerDuchy || !gameState) return null;

  const colorHex = '#' + playerHouse.color.toString(16).padStart(6, '0');
  const otherDuchies = gameState.duchies.filter((_, i) => i !== gameState.playerDuchy);

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

        <div className="duchy-section">
          <div className="duchy-section-title">Territory</div>
          <p style={{ fontSize: '0.82rem', color: '#aaa' }}>
            {playerDuchy.regions.length} regions
            {playerDuchy.hasRiver && ' · River access'}
            {playerDuchy.hasForest && ' · Forested'}
          </p>
        </div>

        {otherDuchies.length > 0 && (
          <div className="duchy-others">
            <div className="duchy-others-title">Other Duchies</div>
            <div className="duchy-others-list">
              {otherDuchies.map(d => {
                const c = '#' + d.house.color.toString(16).padStart(6, '0');
                return (
                  <div key={d.id} className="duchy-other-btn" title={d.house.name}>
                    <span className="duchy-other-sigil">{d.house.sigil}</span>
                    <span className="duchy-other-name">{d.house.name.replace('House ', '')}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
