import { useUIStore } from '../../store/uiStore';
import { useGameStore } from '../../store/gameStore';
import { getSaveSummary } from '../../state/SaveLoad';
import { seasonName } from '../../state/Season';
import { HOUSES } from '../../state/Duchy';

export function MainMenu() {
  const setPhase = useUIStore(s => s.setPhase);
  const { hasSave, loadSavedGame } = useGameStore();

  const summary = hasSave ? getSaveSummary() : null;
  const saveHouse = summary ? HOUSES[summary.playerDuchy] : null;

  return (
    <div className="main-menu">
      <h1 className="game-title">Pixeldraw</h1>
      <p className="game-tagline">Rule your duchy. Shape the land. Outlast your rivals.</p>

      <div className="menu-buttons">
        {summary && saveHouse && (
          <button className="btn-primary" onClick={() => loadSavedGame()}>
            Continue — {saveHouse.sigil} {saveHouse.name}, Year {summary.year}, {seasonName(summary.season)}
          </button>
        )}
        <button className={summary ? 'btn-secondary' : 'btn-primary'} onClick={() => setPhase('house-select')}>
          New Game
        </button>
      </div>
    </div>
  );
}
