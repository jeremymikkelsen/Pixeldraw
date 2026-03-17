import { useUIStore } from '../../store/uiStore';
import { useGameStore } from '../../store/gameStore';

export function RegionPanel() {
  const selectedRegion = useUIStore(s => s.selectedRegion);
  const setSelectedRegion = useUIStore(s => s.setSelectedRegion);
  const { gameState } = useGameStore();

  if (selectedRegion === null || selectedRegion < 0 || !gameState) return null;

  const terrain = gameState.topo.terrainType[selectedRegion];
  const elevation = gameState.topo.elevation[selectedRegion];
  const moisture = gameState.hydro.moisture[selectedRegion];
  const duchyIdx = gameState.regionToDuchy[selectedRegion];

  const duchy = duchyIdx >= 0 ? gameState.duchies[duchyIdx] : null;
  const house = duchy?.house;
  const colorHex = house ? '#' + house.color.toString(16).padStart(6, '0') : undefined;
  const isCapital = duchy ? selectedRegion === duchy.capitalRegion : false;

  return (
    <div className="panel region-panel">
      <button className="panel-close" onClick={() => setSelectedRegion(null)}>✕</button>

      <h3>Region {selectedRegion}</h3>

      <div className="panel-row">
        <span className="panel-label">Terrain</span>
        <span className="panel-value">{terrain}</span>
      </div>
      <div className="panel-row">
        <span className="panel-label">Elevation</span>
        <span className="panel-value">{(elevation * 100).toFixed(1)}%</span>
      </div>
      <div className="panel-row">
        <span className="panel-label">Moisture</span>
        <span className="panel-value">{(moisture * 100).toFixed(1)}%</span>
      </div>

      {duchy && house && (
        <div className="duchy-badge" style={{ borderLeftColor: colorHex }}>
          <div>
            <div className="duchy-badge-name" style={{ color: colorHex }}>
              {house.sigil} {house.name}
              {isCapital && <span style={{ opacity: 0.6, fontSize: '0.72rem' }}> (Capital)</span>}
            </div>
            <div className="duchy-badge-ruler">{house.rulerName} {house.epithet}</div>
            <div className="duchy-badge-axis">{house.axis} economy</div>
          </div>
        </div>
      )}

      {!duchy && (
        <p className="unclaimed-label">Unclaimed wilderness</p>
      )}
    </div>
  );
}
