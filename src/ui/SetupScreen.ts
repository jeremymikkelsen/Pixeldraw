/**
 * SetupScreen
 *
 * Pre-game house selection screen. Shows all 9 houses with their
 * crests, rulers, descriptions, and bonuses. Player picks one to begin.
 */

import { HOUSES, HouseData } from '../state/Duchy';

export interface SetupResult {
  selectedHouse: number; // index into HOUSES
  seed: number;
}

export class SetupScreen {
  private _container: HTMLElement;
  private _resolve: ((result: SetupResult) => void) | null = null;
  private _seed: number;

  constructor() {
    this._seed = Date.now();
    this._container = document.createElement('div');
    this._container.id = 'setup-screen';
    this._container.innerHTML = this._buildHTML();
    document.body.appendChild(this._container);
    this._attachStyles();
    this._attachEvents();
  }

  /**
   * Show the setup screen and wait for the player to choose a house.
   * Returns a promise that resolves with the selected house index and seed.
   */
  show(): Promise<SetupResult> {
    this._container.style.display = 'flex';
    return new Promise(resolve => {
      this._resolve = resolve;
    });
  }

  destroy(): void {
    this._container.remove();
  }

  private _buildHTML(): string {
    let cardsHTML = '';
    for (let i = 0; i < HOUSES.length; i++) {
      const h = HOUSES[i];
      const colorHex = '#' + h.color.toString(16).padStart(6, '0');
      const bonusList = h.bonuses.map(b =>
        `<div class="setup-bonus"><strong>${b.name}:</strong> ${b.description}</div>`
      ).join('');

      cardsHTML += `
        <div class="setup-card" data-house="${i}" style="border-color:${colorHex}">
          <div class="setup-card-header" style="background:${colorHex}20">
            <img class="setup-crest" src="/houses/house_${h.name.split(' ')[1].toLowerCase()}.png" alt="${h.name} crest" onerror="this.style.display='none'">
            <div class="setup-card-title">
              <div class="setup-house-name">${h.sigil} ${h.name}</div>
              <div class="setup-ruler">${h.rulerName} ${h.epithet}</div>
            </div>
          </div>
          <div class="setup-card-body">
            <div class="setup-axis">${h.axis.toUpperCase()} ECONOMY</div>
            <div class="setup-desc">${h.description}</div>
            <div class="setup-bonuses">${bonusList}</div>
          </div>
        </div>`;
    }

    return `
      <div class="setup-inner">
        <h1 class="setup-title">Choose Your House</h1>
        <div class="setup-seed-row">
          <label>Map Seed: <input type="number" class="setup-seed-input" value="${this._seed}"></label>
        </div>
        <div class="setup-grid">${cardsHTML}</div>
      </div>`;
  }

  private _attachStyles(): void {
    if (document.getElementById('setup-styles')) return;
    const style = document.createElement('style');
    style.id = 'setup-styles';
    style.textContent = `
      #setup-screen {
        display: none;
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        z-index: 1000;
        background: #0d0d1a;
        color: #ddd;
        font-family: monospace;
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
        justify-content: flex-start;
        align-items: center;
        flex-direction: column;
      }
      .setup-inner {
        max-width: 960px;
        width: 100%;
        padding: 20px 16px 40px;
      }
      .setup-title {
        text-align: center;
        font-size: 24px;
        color: #fff;
        margin-bottom: 8px;
      }
      .setup-seed-row {
        text-align: center;
        margin-bottom: 16px;
        font-size: 13px;
        color: #888;
      }
      .setup-seed-input {
        background: #1a1a2e;
        color: #ccc;
        border: 1px solid #333;
        padding: 4px 8px;
        font-family: monospace;
        font-size: 13px;
        width: 140px;
        border-radius: 3px;
      }
      .setup-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 12px;
      }
      .setup-card {
        border: 2px solid #444;
        border-radius: 8px;
        background: #13132a;
        cursor: pointer;
        transition: transform 0.15s, box-shadow 0.15s;
        overflow: hidden;
      }
      .setup-card:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      }
      .setup-card-header {
        display: flex;
        align-items: center;
        padding: 10px 12px;
        gap: 10px;
      }
      .setup-crest {
        width: 48px;
        height: 48px;
        object-fit: contain;
        image-rendering: pixelated;
        flex-shrink: 0;
      }
      .setup-card-title {
        flex: 1;
        min-width: 0;
      }
      .setup-house-name {
        font-size: 16px;
        font-weight: bold;
        color: #fff;
      }
      .setup-ruler {
        font-size: 12px;
        color: #aaa;
      }
      .setup-card-body {
        padding: 8px 12px 12px;
      }
      .setup-axis {
        font-size: 10px;
        letter-spacing: 1px;
        color: #777;
        margin-bottom: 4px;
      }
      .setup-desc {
        font-size: 12px;
        color: #bbb;
        margin-bottom: 8px;
        line-height: 1.4;
      }
      .setup-bonuses {
        font-size: 11px;
        color: #999;
        line-height: 1.4;
      }
      .setup-bonus {
        margin-bottom: 2px;
      }
      .setup-bonus strong {
        color: #bbb;
      }
      @media (max-width: 600px) {
        .setup-grid {
          grid-template-columns: 1fr;
        }
        .setup-title { font-size: 20px; }
      }
    `;
    document.head.appendChild(style);
  }

  private _attachEvents(): void {
    // Card click -> select house
    this._container.addEventListener('click', (e) => {
      const card = (e.target as HTMLElement).closest('.setup-card') as HTMLElement | null;
      if (!card) return;
      const houseIdx = parseInt(card.dataset.house!, 10);
      if (isNaN(houseIdx)) return;

      // Read seed from input
      const seedInput = this._container.querySelector('.setup-seed-input') as HTMLInputElement;
      const seed = parseInt(seedInput.value, 10) || Date.now();

      this._container.style.display = 'none';
      if (this._resolve) {
        this._resolve({ selectedHouse: houseIdx, seed });
        this._resolve = null;
      }
    });
  }
}
