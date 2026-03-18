import { useUIStore } from '../../store/uiStore';
import { useGameStore } from '../../store/gameStore';
import type { ResourceType } from '../../state/Economy';

const TRADEABLE: { key: ResourceType; label: string; icon: string }[] = [
  { key: 'grain',       label: 'Grain',       icon: '🌾' },
  { key: 'cattle',      label: 'Cattle',      icon: '🐄' },
  { key: 'fish',        label: 'Fish',        icon: '🐟' },
  { key: 'apples',      label: 'Apples',      icon: '🍎' },
  { key: 'timber',      label: 'Timber',      icon: '🪵' },
  { key: 'ore',         label: 'Ore',         icon: '⛏️' },
  { key: 'stone',       label: 'Stone',       icon: '🪨' },
  { key: 'iron',        label: 'Iron',        icon: '⚙️' },
  { key: 'cloth',       label: 'Cloth',       icon: '🧵' },
  { key: 'bread',       label: 'Bread',       icon: '🍞' },
  { key: 'cheese',      label: 'Cheese',      icon: '🧀' },
  { key: 'smoked_meat', label: 'Smoked Meat', icon: '🥩' },
  { key: 'pie',         label: 'Pie',         icon: '🥧' },
  { key: 'deer',        label: 'Deer',        icon: '🦌' },
  { key: 'spice',       label: 'Spice',       icon: '🌶️' },
];

// Simple static prices — will be replaced by dynamic market engine later
const BASE_PRICES: Partial<Record<ResourceType, number>> = {
  grain: 2, cattle: 4, fish: 3, apples: 2, timber: 3, ore: 5,
  stone: 4, iron: 8, cloth: 6, bread: 3, cheese: 5, smoked_meat: 6,
  pie: 7, deer: 4, spice: 10,
};

export function MarketPanel() {
  const { openPanel, setOpenPanel } = useUIStore();
  const { playerEconomy, gameState } = useGameStore();

  if (openPanel !== 'market' || !playerEconomy || !gameState) return null;

  const { resources } = playerEconomy;
  const gold = resources.gold;

  function buy(key: ResourceType) {
    const price = BASE_PRICES[key] ?? 5;
    if (gold < price) return;
    const eco = gameState!.economies[gameState!.playerDuchy];
    eco.resources.gold -= price;
    eco.resources[key] += 1;
    useGameStore.setState({ playerEconomy: { ...eco } });
  }

  function sell(key: ResourceType) {
    if ((resources[key] ?? 0) < 1) return;
    const price = Math.max(1, Math.floor((BASE_PRICES[key] ?? 5) * 0.7));
    const eco = gameState!.economies[gameState!.playerDuchy];
    eco.resources[key] -= 1;
    eco.resources.gold += price;
    useGameStore.setState({ playerEconomy: { ...eco } });
  }

  return (
    <div className="modal-backdrop" onClick={() => setOpenPanel(null)}>
      <div className="modal-box fp-box" onClick={e => e.stopPropagation()}>
        <button className="panel-close" onClick={() => setOpenPanel(null)}>✕</button>
        <h3>💰 Market</h3>
        <div className="mkt-gold">Gold: <strong>{gold}</strong></div>

        <table className="fp-table">
          <thead>
            <tr>
              <th className="fp-th-food">Resource</th>
              <th className="fp-th-num">Stock</th>
              <th className="fp-th-num">Buy</th>
              <th className="fp-th-num">Sell</th>
            </tr>
          </thead>
          <tbody>
            {TRADEABLE.map(({ key, label, icon }) => {
              const stock = resources[key] ?? 0;
              const buyPrice = BASE_PRICES[key] ?? 5;
              const sellPrice = Math.max(1, Math.floor(buyPrice * 0.7));
              const canBuy = gold >= buyPrice;
              const canSell = stock > 0;
              return (
                <tr key={key}>
                  <td>{icon} {label}</td>
                  <td className="fp-num">{stock}</td>
                  <td className="fp-num">
                    <button
                      className="mkt-btn mkt-btn--buy"
                      disabled={!canBuy}
                      onClick={() => buy(key)}
                    >
                      {buyPrice}g
                    </button>
                  </td>
                  <td className="fp-num">
                    <button
                      className="mkt-btn mkt-btn--sell"
                      disabled={!canSell}
                      onClick={() => sell(key)}
                    >
                      {sellPrice}g
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
