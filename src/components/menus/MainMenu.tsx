import { useUIStore } from '../../store/uiStore';

export function MainMenu() {
  const setPhase = useUIStore(s => s.setPhase);

  return (
    <div className="main-menu">
      <h1 className="game-title">Pixeldraw</h1>
      <p className="game-tagline">Rule your duchy. Shape the land. Outlast your rivals.</p>

      <div className="menu-buttons">
        <button className="btn-primary" onClick={() => setPhase('house-select')}>
          New Game
        </button>
      </div>
    </div>
  );
}
