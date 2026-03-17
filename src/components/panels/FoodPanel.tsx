import { useGameStore } from '../../store/gameStore';
import { useUIStore } from '../../store/uiStore';
import {
  FOOD_KEYS, RATION_MULTIPLIERS, HAPPINESS_FROM_RATIONS,
  computeProduction, countTerrain,
  type ResourceType, type RationLevel,
} from '../../state/Economy';

const FOOD_META: { key: ResourceType; label: string; icon: string }[] = [
  { key: 'grain',       label: 'Grain',       icon: '🌾' },
  { key: 'cattle',      label: 'Cattle',      icon: '🐄' },
  { key: 'fish',        label: 'Fish',        icon: '🐟' },
  { key: 'deer',        label: 'Deer',        icon: '🦌' },
  { key: 'apples',      label: 'Apples',      icon: '🍎' },
  { key: 'bread',       label: 'Bread',       icon: '🍞' },
  { key: 'cheese',      label: 'Cheese',      icon: '🧀' },
  { key: 'smoked_meat', label: 'Smoked Meat', icon: '🥩' },
  { key: 'pie',         label: 'Pie',         icon: '🥧' },
];

const FOOD_META_MAP = new Map(FOOD_META.map(f => [f.key, f]));

const RATION_LABELS: Record<RationLevel, string> = {
  none: 'None', meager: 'Meager', normal: 'Normal', extra: 'Extra',
};

export function FoodPanel() {
  const { playerEconomy, playerDuchy, gameState, setRationLevel, setFoodEatOrder } = useGameStore();
  const { openPanel, setOpenPanel } = useUIStore();

  if (openPanel !== 'food' || !playerEconomy || !playerDuchy || !gameState) return null;

  const { resources, population, rationLevel, foodEatOrder, laborAssignment } = playerEconomy;

  const eatOrder: ResourceType[] = foodEatOrder ?? FOOD_META.map(f => f.key);

  const orderedFood = [
    ...eatOrder.filter(k => FOOD_META_MAP.has(k)),
    ...FOOD_META.map(f => f.key).filter(k => !eatOrder.includes(k)),
  ].map(k => FOOD_META_MAP.get(k)!);

  // Production from terrain
  const terrain = countTerrain(
    playerDuchy.regions, gameState.topo.terrainType,
    playerDuchy.hasRiver, playerDuchy.hasForest,
  );
  const production = computeProduction(terrain, laborAssignment);

  // Forecast
  const afterProd: Partial<Record<ResourceType, number>> = {};
  for (const { key } of FOOD_META) {
    afterProd[key] = (resources[key] ?? 0) + (production[key] ?? 0);
  }

  const totalEat = Math.round(population.total * RATION_MULTIPLIERS[rationLevel]);

  const eatsPerType: Partial<Record<ResourceType, number>> = {};
  let eatRem = Math.min(totalEat, FOOD_KEYS.reduce((s, k) => s + (afterProd[k] ?? 0), 0));
  for (const key of eatOrder) {
    if (eatRem <= 0) break;
    const take = Math.min(afterProd[key] ?? 0, eatRem);
    if (take > 0) eatsPerType[key] = take;
    eatRem -= take;
  }

  const afterEat: Partial<Record<ResourceType, number>> = {};
  for (const { key } of FOOD_META) {
    afterEat[key] = (afterProd[key] ?? 0) - (eatsPerType[key] ?? 0);
  }
  const wastePerType: Partial<Record<ResourceType, number>> = {};
  let wasteRem = Math.ceil(FOOD_KEYS.reduce((s, k) => s + (afterEat[k] ?? 0), 0) * 0.02);
  for (const key of eatOrder) {
    if (wasteRem <= 0) break;
    const take = Math.min(afterEat[key] ?? 0, wasteRem);
    if (take > 0) wastePerType[key] = take;
    wasteRem -= take;
  }

  const totalStock = FOOD_META.reduce((s, { key }) => s + (resources[key] ?? 0), 0);
  const totalProd = FOOD_META.reduce((s, { key }) => s + (production[key] ?? 0), 0);
  const totalEaten = Object.values(eatsPerType).reduce((s, v) => s + (v ?? 0), 0);
  const totalWaste = Object.values(wastePerType).reduce((s, v) => s + (v ?? 0), 0);
  const happinessDelta = HAPPINESS_FROM_RATIONS[rationLevel];
  const currentFood = totalStock;

  function canAffordRation(level: RationLevel): boolean {
    const needed = Math.ceil(population.total * RATION_MULTIPLIERS[level]);
    return needed === 0 || currentFood >= needed;
  }

  function moveEatOrder(index: number, direction: -1 | 1) {
    const newOrder = [...eatOrder];
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= newOrder.length) return;
    [newOrder[index], newOrder[targetIndex]] = [newOrder[targetIndex], newOrder[index]];
    setFoodEatOrder(newOrder);
  }

  return (
    <div className="modal-backdrop" onClick={() => setOpenPanel(null)}>
      <div className="modal-box fp-box" onClick={e => e.stopPropagation()}>
        <button className="panel-close" onClick={() => setOpenPanel(null)}>✕</button>
        <h3>🌾 Food Stockpile</h3>

        <div className="fp-ration-row">
          <span className="fp-ration-label">Rations</span>
          <div className="ration-pills">
            {(['none', 'meager', 'normal', 'extra'] as RationLevel[]).map(level => {
              const affordable = canAffordRation(level);
              return (
                <button
                  key={level}
                  className={`ration-pill${rationLevel === level ? ' ration-pill--active' : ''}${!affordable ? ' ration-pill--disabled' : ''}`}
                  onClick={() => affordable && setRationLevel(level)}
                  disabled={!affordable}
                >
                  {RATION_LABELS[level]}
                </button>
              );
            })}
          </div>
          <span className="fp-ration-hint">
            {totalEat > 0 ? `${totalEat} consumed` : 'No food distributed'} · happiness {happinessDelta >= 0 ? '+' : ''}{happinessDelta}/turn
          </span>
        </div>

        <table className="fp-table">
          <thead>
            <tr>
              <th className="fp-th-food">Food</th>
              <th className="fp-th-num">Stock</th>
              <th className="fp-th-num">Prod</th>
              <th className="fp-th-num">Eats</th>
              <th className="fp-th-num">Waste</th>
              <th className="fp-th-order">Order</th>
            </tr>
          </thead>
          <tbody>
            {orderedFood.map(({ key, label, icon }, idx) => {
              const stock = resources[key] ?? 0;
              const prod = production[key] ?? 0;
              const eats = eatsPerType[key] ?? 0;
              const waste = wastePerType[key] ?? 0;
              const empty = stock === 0 && prod === 0;
              return (
                <tr key={key} className={empty ? 'fp-row-empty' : ''}>
                  <td>{icon} {label}</td>
                  <td className="fp-num">{stock > 0 ? stock : '—'}</td>
                  <td className="fp-num fp-prod">{prod > 0 ? `+${prod}` : '—'}</td>
                  <td className="fp-num fp-eat">{eats > 0 ? eats : '—'}</td>
                  <td className="fp-num fp-waste">{waste > 0 ? waste : '—'}</td>
                  <td className="fp-num fp-order-btns">
                    <button className="fp-order-btn" onClick={() => moveEatOrder(idx, -1)} disabled={idx === 0}>↑</button>
                    <button className="fp-order-btn" onClick={() => moveEatOrder(idx, 1)} disabled={idx === orderedFood.length - 1}>↓</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="fp-total-row">
              <td>Total</td>
              <td className="fp-num">{totalStock}</td>
              <td className="fp-num fp-prod">{totalProd > 0 ? `+${totalProd}` : '—'}</td>
              <td className="fp-num fp-eat">{totalEaten > 0 ? totalEaten : '—'}</td>
              <td className="fp-num fp-waste">{totalWaste > 0 ? totalWaste : '—'}</td>
              <td />
            </tr>
          </tfoot>
        </table>
        <p className="fp-hint-text">↑/↓ sets which foods are eaten first each turn.</p>
      </div>
    </div>
  );
}
