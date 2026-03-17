import { useState } from 'react';
import { HOUSES, type HouseData } from '../../state/Duchy';
import { useUIStore } from '../../store/uiStore';

/** Emitted via custom event so MapScene can pick it up */
function startGame(houseIndex: number, seed: number) {
  window.dispatchEvent(new CustomEvent('pixeldraw:start-game', {
    detail: { houseIndex, seed },
  }));
}

function PortraitImg({ src, alt, className }: { src: string; alt: string; className: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
    />
  );
}

export function HouseSelectScreen() {
  const [selected, setSelected] = useState(0);
  const [seed, setSeed] = useState(() => Date.now());
  const setPhase = useUIStore(s => s.setPhase);
  const house = HOUSES[selected];
  const colorHex = '#' + house.color.toString(16).padStart(6, '0');

  function handleBegin() {
    setPhase('playing');
    startGame(selected, seed);
  }

  return (
    <div className="house-select-screen">
      <h1 className="game-title">Choose Your House</h1>
      <p className="game-tagline">Your house shapes your duchy's destiny.</p>

      <div className="house-select-body">
        {/* Left: grid of house cards */}
        <div className="house-grid">
          {HOUSES.map((h, i) => (
            <button
              key={h.name}
              className={`house-card ${selected === i ? 'house-card--selected' : ''}`}
              onClick={() => setSelected(i)}
            >
              <PortraitImg
                className="house-card-portrait"
                src={h.portraitUrl}
                alt={h.rulerName}
              />
              <div className="house-card-meta">
                <span className="house-card-name">{h.name}</span>
                <span className="house-card-ruler">{h.rulerName} {h.epithet}</span>
                <span className={`axis-badge axis-badge--${h.axis}`}>{h.axis}</span>
              </div>
            </button>
          ))}
        </div>

        {/* Right: detail panel */}
        <div className="house-detail-panel">
          <div className="house-detail-portrait-wrap">
            <PortraitImg
              className="house-detail-portrait"
              src={house.portraitUrl}
              alt={house.rulerName}
            />
            <PortraitImg
              className="house-detail-crest"
              src={house.crestUrl}
              alt={`${house.name} crest`}
            />
          </div>

          <div className="house-detail-header">
            <h2 className="house-detail-name" style={{ color: colorHex }}>{house.name}</h2>
            <span className="house-detail-ruler">
              {house.rulerName}, <em>{house.epithet}</em>
            </span>
            <span className={`axis-badge axis-badge--${house.axis}`}>{house.axis}</span>
          </div>

          <p className="house-detail-bio">{house.description}</p>

          <ul className="house-bonus-list">
            {house.bonuses.map(bonus => (
              <li key={bonus.name} className="house-bonus-item">
                <span className="house-bonus-label">{bonus.name}</span>
                <span className="house-bonus-desc">{bonus.description}</span>
              </li>
            ))}
          </ul>

          <div className="house-seed-row">
            <label>Map Seed:</label>
            <input
              type="number"
              className="house-seed-input"
              value={seed}
              onChange={e => setSeed(parseInt(e.target.value, 10) || Date.now())}
            />
          </div>

          <button className="btn-primary house-begin-btn" onClick={handleBegin}>
            Begin as {house.name}
          </button>
        </div>
      </div>
    </div>
  );
}
