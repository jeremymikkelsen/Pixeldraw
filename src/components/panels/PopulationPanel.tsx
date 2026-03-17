import { useGameStore } from '../../store/gameStore';
import { useUIStore } from '../../store/uiStore';

export function PopulationPanel() {
  const { playerEconomy } = useGameStore();
  const { openPanel, setOpenPanel } = useUIStore();

  if (openPanel !== 'population' || !playerEconomy) return null;

  const { population } = playerEconomy;
  const { total, farmers, artisans, merchants, soldiers, happiness } = population;

  const happinessColor =
    happiness >= 70 ? '#78d878' :
    happiness >= 40 ? '#e0a030' : '#e05050';

  const immigration = happiness > 60 ? Math.floor((happiness - 60) / 10) : 0;
  const emigration = happiness < 30 ? Math.floor((30 - happiness) / 10) : 0;

  const breakdown = [
    { label: 'Farmers',   icon: '🌾', count: farmers },
    { label: 'Artisans',  icon: '🔨', count: artisans },
    { label: 'Merchants', icon: '💼', count: merchants },
    { label: 'Soldiers',  icon: '⚔️', count: soldiers },
  ];

  return (
    <div className="modal-backdrop" onClick={() => setOpenPanel(null)}>
      <div className="modal-box fp-box" onClick={e => e.stopPropagation()}>
        <button className="panel-close" onClick={() => setOpenPanel(null)}>✕</button>
        <h3>👥 Population</h3>

        <div className="fp-pop-total">{total} people</div>

        <div className="fp-pop-happiness">
          <div className="fp-pop-happiness-row">
            <span>😊 Happiness</span>
            <span style={{ color: happinessColor }}>{happiness}/100</span>
          </div>
          <div className="fp-pop-bar-bg">
            <div className="fp-pop-bar-fill" style={{ width: `${happiness}%`, background: happinessColor }} />
          </div>
        </div>

        <table className="fp-table">
          <tbody>
            {breakdown.map(({ label, icon, count }) => (
              <tr key={label}>
                <td>{icon} {label}</td>
                <td className="fp-num">{count}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="fp-pop-trend">
          {immigration > 0 && <div className="fp-prod">↑ +{immigration} immigration/turn (happiness high)</div>}
          {emigration > 0 && <div className="fp-eat">↓ −{emigration} emigration/turn (happiness low)</div>}
          {immigration === 0 && emigration === 0 && <div>Population stable</div>}
        </div>
      </div>
    </div>
  );
}
