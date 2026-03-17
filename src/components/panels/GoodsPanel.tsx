import { useUIStore } from '../../store/uiStore';

const PLANNED_GOODS = [
  { icon: '⚔️', label: 'Weapons',   chain: 'iron + timber → weapons' },
  { icon: '🛒', label: 'Carts',     chain: 'timber + iron → carts' },
  { icon: '🗿', label: 'Statues',   chain: 'stone + gold → statues' },
];

export function GoodsPanel() {
  const { openPanel, setOpenPanel } = useUIStore();

  if (openPanel !== 'goods') return null;

  return (
    <div className="modal-backdrop" onClick={() => setOpenPanel(null)}>
      <div className="modal-box fp-box" onClick={e => e.stopPropagation()}>
        <button className="panel-close" onClick={() => setOpenPanel(null)}>✕</button>
        <h3>📦 Goods</h3>
        <p className="fp-hint-text">
          Manufactured goods are crafted from raw resources and sold for gold or used for military.
        </p>
        <table className="fp-table">
          <thead>
            <tr>
              <th className="fp-th-food">Good</th>
              <th className="fp-th-num">Stock</th>
              <th className="fp-th-num">+/turn</th>
            </tr>
          </thead>
          <tbody>
            {PLANNED_GOODS.map(({ icon, label, chain }) => (
              <tr key={label} className="fp-row-empty">
                <td>
                  {icon} {label}
                  <span className="fp-note">({chain})</span>
                </td>
                <td className="fp-num">—</td>
                <td className="fp-num">Coming Soon</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
