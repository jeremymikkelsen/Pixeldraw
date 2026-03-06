/**
 * UIManager
 *
 * DOM-based UI coordinator. Bridges Phaser pointer events to DOM elements.
 * Creates and manages TopBar and ContextPanel.
 */

import { GameState, advanceTurn } from '../state/GameState';
import { seasonName } from '../state/Season';

export class UIManager {
  private _state: GameState | null = null;
  private _regionGrid: Uint16Array | null = null;

  // DOM elements
  private _container: HTMLElement;
  private _topBar: HTMLElement;
  private _seasonLabel: HTMLElement;
  private _endTurnBtn: HTMLElement;
  private _contextPanel: HTMLElement;
  private _contextContent: HTMLElement;

  // Callback for when state changes (re-render needed)
  onTurnAdvanced: (() => void) | null = null;

  constructor() {
    // Create UI container
    this._container = document.createElement('div');
    this._container.id = 'game-ui';
    this._container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:100;font-family:monospace;';
    document.body.appendChild(this._container);

    // Top bar
    this._topBar = document.createElement('div');
    this._topBar.style.cssText = 'position:absolute;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:rgba(0,0,0,0.6);pointer-events:auto;color:#fff;font-size:14px;';
    this._container.appendChild(this._topBar);

    this._seasonLabel = document.createElement('span');
    this._seasonLabel.textContent = 'Year 1, Spring';
    this._topBar.appendChild(this._seasonLabel);

    this._endTurnBtn = document.createElement('button');
    this._endTurnBtn.textContent = 'End Turn';
    this._endTurnBtn.style.cssText = 'padding:4px 12px;font-family:monospace;font-size:13px;cursor:pointer;background:#445;color:#fff;border:1px solid #667;border-radius:3px;';
    this._endTurnBtn.addEventListener('click', () => this._onEndTurn());
    this._topBar.appendChild(this._endTurnBtn);

    // Context panel (bottom)
    this._contextPanel = document.createElement('div');
    this._contextPanel.style.cssText = 'position:absolute;bottom:0;left:0;right:0;max-height:30%;background:rgba(0,0,0,0.7);color:#fff;font-size:13px;padding:10px 14px;pointer-events:auto;transform:translateY(100%);transition:transform 0.2s ease;';
    this._container.appendChild(this._contextPanel);

    this._contextContent = document.createElement('div');
    this._contextPanel.appendChild(this._contextContent);
  }

  setState(state: GameState, regionGrid: Uint16Array): void {
    this._state = state;
    this._regionGrid = regionGrid;
    this._updateTopBar();
  }

  /**
   * Called when a region is clicked. Shows context panel with region info.
   */
  showRegionInfo(region: number): void {
    if (!this._state || region < 0) {
      this._hideContextPanel();
      return;
    }

    const state = this._state;
    const terrain = state.topo.terrainType[region];
    const elevation = state.topo.elevation[region];
    const moisture = state.hydro.moisture[region];
    const duchyIdx = state.regionToDuchy[region];

    let html = `<div style="margin-bottom:4px"><strong>Region ${region}</strong></div>`;
    html += `<div>Terrain: ${terrain}</div>`;
    html += `<div>Elevation: ${(elevation * 100).toFixed(1)}%</div>`;
    html += `<div>Moisture: ${(moisture * 100).toFixed(1)}%</div>`;

    if (duchyIdx >= 0) {
      const duchy = state.duchies[duchyIdx];
      const house = duchy.house;
      const colorHex = '#' + house.color.toString(16).padStart(6, '0');
      html += `<div style="margin-top:6px">`;
      html += `<span style="display:inline-block;width:10px;height:10px;background:${colorHex};margin-right:6px;vertical-align:middle;border:1px solid #fff"></span>`;
      html += `<strong>${house.sigil} ${house.name}</strong>`;
      if (region === duchy.capitalRegion) html += ' (Capital)';
      html += `</div>`;
      html += `<div style="font-size:12px;color:#ccc">${house.rulerName} ${house.epithet} · ${house.axis}</div>`;
      html += `<div style="font-size:11px;color:#999;margin-top:2px">${house.description}</div>`;
    } else {
      html += `<div style="margin-top:6px;color:#888">Unclaimed wilderness</div>`;
    }

    this._contextContent.innerHTML = html;
    this._contextPanel.style.transform = 'translateY(0)';
  }

  destroy(): void {
    this._container.remove();
  }

  private _onEndTurn(): void {
    if (!this._state) return;
    advanceTurn(this._state);
    this._updateTopBar();
    if (this.onTurnAdvanced) this.onTurnAdvanced();
  }

  private _updateTopBar(): void {
    if (!this._state) return;
    const s = this._state;
    this._seasonLabel.textContent = `Year ${s.year}, ${seasonName(s.season)}`;
  }

  private _hideContextPanel(): void {
    this._contextPanel.style.transform = 'translateY(100%)';
  }
}
