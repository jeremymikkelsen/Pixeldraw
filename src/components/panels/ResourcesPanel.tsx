import { useGameStore } from '../../store/gameStore';
import { useUIStore } from '../../store/uiStore';
import { computeProduction, countTerrain, type ResourceType, type LaborAssignment } from '../../state/Economy';

type WorkerRole = keyof Omit<LaborAssignment, 'unemployed'>;
const WORKER_ROLES: WorkerRole[] = ['farmers', 'lumberjacks', 'miners', 'quarrymen', 'smiths'];

const ROLE_META: { role: WorkerRole; label: string; icon: string; resource: string }[] = [
  { role: 'farmers',     label: 'Farmers',     icon: '🌾', resource: 'grain' },
  { role: 'lumberjacks', label: 'Lumberjacks', icon: '🪵', resource: 'timber' },
  { role: 'miners',      label: 'Miners',      icon: '⛏️', resource: 'ore' },
  { role: 'quarrymen',   label: 'Quarrymen',   icon: '🪨', resource: 'stone' },
  { role: 'smiths',      label: 'Smiths',      icon: '⚙️', resource: 'iron' },
];

const RESOURCE_TYPES: { key: ResourceType; label: string; icon: string }[] = [
  { key: 'timber', label: 'Timber', icon: '🪵' },
  { key: 'ore',    label: 'Ore',    icon: '⛏️' },
  { key: 'stone',  label: 'Stone',  icon: '🪨' },
  { key: 'iron',   label: 'Iron',   icon: '⚙️' },
  { key: 'cloth',  label: 'Cloth',  icon: '🧵' },
  { key: 'gold',   label: 'Gold',   icon: '💰' },
];

export function ResourcesPanel() {
  const { playerEconomy, playerDuchy, gameState, setLaborAllocation } = useGameStore();
  const { openPanel, setOpenPanel } = useUIStore();

  if (openPanel !== 'resources' || !playerEconomy || !playerDuchy || !gameState) return null;

  const { resources, laborAssignment: la, population } = playerEconomy;
  const totalWorkers = population.total;

  const terrain = countTerrain(
    playerDuchy.regions, gameState.topo.terrainType,
    playerDuchy.hasRiver, playerDuchy.hasForest,
  );
  const production = computeProduction(terrain, la);

  function maxForRole(role: WorkerRole): number {
    const otherAssigned = WORKER_ROLES.filter(r => r !== role).reduce((sum, r) => sum + la[r], 0);
    return Math.max(0, totalWorkers - otherAssigned);
  }

  const totalAssigned = WORKER_ROLES.reduce((sum, r) => sum + la[r], 0);

  return (
    <div className="modal-backdrop" onClick={() => setOpenPanel(null)}>
      <div className="modal-box fp-box" onClick={e => e.stopPropagation()}>
        <button className="panel-close" onClick={() => setOpenPanel(null)}>✕</button>

        <h3>⛏️ Resources</h3>
        <table className="fp-table">
          <thead>
            <tr>
              <th className="fp-th-food">Resource</th>
              <th className="fp-th-num">Stock</th>
              <th className="fp-th-num">+/turn</th>
            </tr>
          </thead>
          <tbody>
            {RESOURCE_TYPES.map(({ key, label, icon }) => {
              const stock = resources[key] ?? 0;
              const net = production[key] ?? 0;
              return (
                <tr key={key}>
                  <td>{icon} {label}</td>
                  <td className="fp-num">{stock > 0 ? stock : '—'}</td>
                  <td className={`fp-num ${net > 0 ? 'fp-prod' : ''}`}>
                    {net > 0 ? `+${net}` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="labor-section-header">
          <span>⚒️ Labor Assignment</span>
          <span className="labor-summary-inline">{totalAssigned} / {totalWorkers} assigned · {la.unemployed} idle</span>
        </div>

        {ROLE_META.map(({ role, label, icon, resource }) => {
          const assigned = la[role];
          const max = maxForRole(role);
          const bonus = assigned > 0 ? `+${assigned} ${resource}/turn` : '';

          return (
            <div key={role} className="labor-row">
              <div className="labor-row-header">
                <span className="labor-role-name">{icon} {label}</span>
                <div className="labor-row-meta">
                  {bonus && <span className="labor-bonus">{bonus}</span>}
                  <span className="labor-count">{assigned}</span>
                </div>
              </div>
              <input
                type="range"
                min={0}
                max={max}
                value={assigned}
                onChange={e => setLaborAllocation(role, Number(e.target.value))}
                className="fp-slider"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
