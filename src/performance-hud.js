const STYLE_ID = 'guardian-performance-hud-styles';
const STORAGE_KEY = 'guardianPerformanceHudState';

function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .guardian-hud {
      position: fixed;
      top: 16px;
      right: 16px;
      min-width: 220px;
      max-width: 320px;
      padding: 12px 14px;
      background: rgba(12, 14, 18, 0.86);
      border: 1px solid rgba(255,255,255,0.05);
      border-radius: 12px;
      color: #f5f5f7;
      font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
      font-size: 12px;
      line-height: 1.45;
      box-shadow: 0 14px 40px rgba(0, 0, 0, 0.35);
      backdrop-filter: saturate(130%) blur(10px);
      z-index: 9997;
      cursor: default;
      transition: opacity 160ms ease, transform 160ms ease;
    }

    .guardian-hud.is-hidden {
      opacity: 0;
      pointer-events: none;
      transform: translateY(-4px);
    }

    .guardian-hud__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      cursor: grab;
      user-select: none;
      margin-bottom: 10px;
    }

    .guardian-hud__status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-variant-numeric: tabular-nums;
    }

    .guardian-hud__dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #00c853;
      box-shadow: 0 0 8px rgba(0, 200, 83, 0.55);
      transition: background 160ms ease, box-shadow 160ms ease;
    }

    .guardian-hud[data-status="warn"] .guardian-hud__dot {
      background: #ffb300;
      box-shadow: 0 0 8px rgba(255, 179, 0, 0.55);
    }

    .guardian-hud[data-status="critical"] .guardian-hud__dot {
      background: #ff3d00;
      box-shadow: 0 0 8px rgba(255, 61, 0, 0.6);
    }

    .guardian-hud__title {
      font-weight: 600;
      letter-spacing: 0.6px;
      text-transform: uppercase;
      font-size: 11px;
      opacity: 0.8;
    }

    .guardian-hud__buttons {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-left: auto;
    }

    .guardian-hud__btn {
      width: 20px;
      height: 20px;
      border-radius: 6px;
      border: none;
      background: rgba(255,255,255,0.08);
      color: #f5f5f7;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      transition: background 120ms ease, opacity 120ms ease;
    }

    .guardian-hud__btn:hover {
      background: rgba(255,255,255,0.16);
    }

    .guardian-hud__primary {
      display: grid;
      grid-template-columns: auto auto;
      align-items: baseline;
      justify-content: space-between;
      gap: 4px 12px;
      font-variant-numeric: tabular-nums;
    }

    .guardian-hud__fps {
      font-size: 24px;
      font-weight: 600;
      letter-spacing: -0.02em;
    }

    .guardian-hud__fps-label {
      text-transform: uppercase;
      font-size: 10px;
      letter-spacing: 0.6px;
      opacity: 0.55;
    }

    .guardian-hud__sparkline {
      width: 100%;
      height: 36px;
      margin-top: 10px;
      margin-bottom: 8px;
      background: rgba(255,255,255,0.04);
      border-radius: 8px;
      overflow: hidden;
    }

    .guardian-hud__info-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-variant-numeric: tabular-nums;
      margin-bottom: 6px;
    }

    .guardian-hud__badge {
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(255,255,255,0.12);
      font-size: 11px;
      letter-spacing: 0.4px;
    }

    .guardian-hud__details {
      margin-top: 8px;
      border-top: 1px solid rgba(255,255,255,0.06);
      padding-top: 8px;
      display: none;
      gap: 6px;
    }

    .guardian-hud.is-expanded .guardian-hud__details {
      display: grid;
    }

    .guardian-hud__detail {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-variant-numeric: tabular-nums;
    }

    .guardian-hud__detail-label {
      opacity: 0.65;
    }

    .guardian-hud__peeker {
      position: fixed;
      right: 16px;
      bottom: 16px;
      background: rgba(12, 14, 18, 0.8);
      color: #f5f5f7;
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
      letter-spacing: 0.3px;
      display: flex;
      align-items: center;
      gap: 6px;
      box-shadow: 0 10px 24px rgba(0,0,0,0.2);
      backdrop-filter: saturate(130%) blur(8px);
      z-index: 9996;
      cursor: pointer;
      opacity: 0;
      pointer-events: none;
      transition: opacity 160ms ease, transform 160ms ease;
    }

    .guardian-hud__peeker.is-visible {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(0);
    }

    .guardian-hud__sparkline canvas {
      width: 100%;
      height: 100%;
      display: block;
    }

    .guardian-hud__alert {
      margin-top: 6px;
      border-radius: 8px;
      padding: 6px 8px;
      font-size: 11px;
      background: rgba(255, 179, 0, 0.12);
      color: #ffb74d;
      letter-spacing: 0.3px;
      display: none;
    }

    .guardian-hud.has-alert .guardian-hud__alert {
      display: block;
    }

    .guardian-hud.has-alert[data-status="critical"] .guardian-hud__alert {
      background: rgba(255, 61, 0, 0.18);
      color: #ff8a65;
    }
  `;
  document.head.appendChild(style);
}

function formatNumber(value, decimals = 1) {
  if (!Number.isFinite(value)) return '—';
  return Number(value).toFixed(decimals);
}

function formatPercent(value, decimals = 0) {
  if (!Number.isFinite(value)) return '—';
  return `${Number(value * 100).toFixed(decimals)}%`;
}

function formatMemoryMb(value) {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} GB`;
  }
  return `${value.toFixed(0)} MB`;
}

function safeParseState(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

export class PerformanceHud {
  constructor({
    targetFpsProvider = () => 60,
    qualityProvider = () => ({}),
    updateIntervalMs = 250,
  } = {}) {
    if (typeof document === 'undefined') {
      this.disabled = true;
      return;
    }

    injectStyles();

    this.targetFpsProvider = targetFpsProvider;
    this.qualityProvider = qualityProvider;
    this.updateIntervalMs = Math.max(100, updateIntervalMs);
    this.lastUpdateTs = 0;
    this.fpsHistory = [];
    this.maxHistory = 120;
    this.lastMetrics = null;
    this.status = 'idle';
    this.visible = false;
    this.expanded = false;
    this.dragging = false;
    this.pointerId = null;
    this.offsetX = 0;
    this.offsetY = 0;

    const saved = safeParseState(window.localStorage?.getItem(STORAGE_KEY));
    this.state = {
      visible: saved?.visible ?? false,
      expanded: saved?.expanded ?? false,
      position: saved?.position ?? null,
      collapsed: saved?.collapsed ?? false,
    };

    this.visible = !!this.state.visible;
    this.expanded = !!this.state.expanded;

    this.root = document.createElement('div');
    this.root.className = 'guardian-hud';
    this.root.dataset.status = 'idle';
    if (!this.visible) {
      this.root.classList.add('is-hidden');
    }
    if (this.expanded) {
      this.root.classList.add('is-expanded');
    }

    if (this.state.position && Number.isFinite(this.state.position.x) && Number.isFinite(this.state.position.y)) {
      this.root.style.left = `${this.state.position.x}px`;
      this.root.style.top = `${this.state.position.y}px`;
      this.root.style.right = 'auto';
    }

    this.header = document.createElement('div');
    this.header.className = 'guardian-hud__header';
    this.statusDot = document.createElement('div');
    this.statusDot.className = 'guardian-hud__dot';
    const title = document.createElement('div');
    title.className = 'guardian-hud__title';
    title.textContent = 'Guardian Telemetry';
    this.buttonBar = document.createElement('div');
    this.buttonBar.className = 'guardian-hud__buttons';

    this.collapseBtn = document.createElement('button');
    this.collapseBtn.className = 'guardian-hud__btn';
    this.collapseBtn.type = 'button';
    this.collapseBtn.title = 'Toggle details (Shift+P)';
    this.collapseBtn.textContent = this.expanded ? '−' : '＋';

    this.closeBtn = document.createElement('button');
    this.closeBtn.className = 'guardian-hud__btn';
    this.closeBtn.type = 'button';
    this.closeBtn.title = 'Hide HUD (P)';
    this.closeBtn.textContent = '×';

    this.buttonBar.appendChild(this.collapseBtn);
    this.buttonBar.appendChild(this.closeBtn);

    this.header.appendChild(this.statusDot);
    this.header.appendChild(title);
    this.header.appendChild(this.buttonBar);

    const primary = document.createElement('div');
    primary.className = 'guardian-hud__primary';

    const fpsLabel = document.createElement('div');
    fpsLabel.className = 'guardian-hud__fps-label';
    fpsLabel.textContent = 'Frame Rate';
    this.fpsValue = document.createElement('div');
    this.fpsValue.className = 'guardian-hud__fps';
    this.fpsValue.textContent = '—';

    const frameTimeLabel = document.createElement('div');
    frameTimeLabel.className = 'guardian-hud__fps-label';
    frameTimeLabel.textContent = 'Frame Time';
    this.frameTimeValue = document.createElement('div');
    this.frameTimeValue.className = 'guardian-hud__fps';
    this.frameTimeValue.style.fontSize = '16px';
    this.frameTimeValue.textContent = '—';

    primary.appendChild(fpsLabel);
    primary.appendChild(this.fpsValue);
    primary.appendChild(frameTimeLabel);
    primary.appendChild(this.frameTimeValue);

    this.sparklineWrap = document.createElement('div');
    this.sparklineWrap.className = 'guardian-hud__sparkline';
    this.sparkCanvas = document.createElement('canvas');
    this.sparkCanvas.width = 180;
    this.sparkCanvas.height = 36;
    this.sparkCtx = this.sparkCanvas.getContext('2d');
    this.sparklineWrap.appendChild(this.sparkCanvas);

    this.infoRow = document.createElement('div');
    this.infoRow.className = 'guardian-hud__info-row';
    this.qualityBadge = document.createElement('div');
    this.qualityBadge.className = 'guardian-hud__badge';
    this.qualityBadge.textContent = 'Quality —';
    this.dropBadge = document.createElement('div');
    this.dropBadge.className = 'guardian-hud__badge';
    this.dropBadge.textContent = 'Drops 0';
    this.infoRow.appendChild(this.qualityBadge);
    this.infoRow.appendChild(this.dropBadge);

    this.details = document.createElement('div');
    this.details.className = 'guardian-hud__details';
    this.detailNodes = {
      fpsTrend: this._createDetailRow('10s Avg FPS'),
      cpuAvg: this._createDetailRow('CPU avg'),
      gpuAvg: this._createDetailRow('GPU avg'),
      budget: this._createDetailRow('Budget util'),
      renderer: this._createDetailRow('Draw calls'),
      memory: this._createDetailRow('Memory'),
    };
    Object.values(this.detailNodes).forEach((node) => {
      this.details.appendChild(node.row);
    });

    this.alertBox = document.createElement('div');
    this.alertBox.className = 'guardian-hud__alert';
    this.alertBox.textContent = '';

    this.root.appendChild(this.header);
    this.root.appendChild(primary);
    this.root.appendChild(this.sparklineWrap);
    this.root.appendChild(this.infoRow);
    this.root.appendChild(this.details);
    this.root.appendChild(this.alertBox);
    document.body.appendChild(this.root);

    this.peeker = document.createElement('div');
    this.peeker.className = 'guardian-hud__peeker';
    this.peeker.textContent = 'Performance HUD (P)';
    document.body.appendChild(this.peeker);
    if (!this.visible) {
      this.peeker.classList.add('is-visible');
    }

    this.header.addEventListener('pointerdown', this._handleDragStart.bind(this));
    this.collapseBtn.addEventListener('click', () => {
      this.toggleExpanded();
    });
    this.closeBtn.addEventListener('click', () => {
      this.toggleVisible(false);
    });
    this.peeker.addEventListener('click', () => {
      this.toggleVisible(true);
    });

    this._keyHandler = (event) => {
      if (event.defaultPrevented) return;
      const key = event.key || '';
      if (key !== 'p' && key !== 'P') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = (event.target && event.target.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select', 'button'].includes(tag)) return;
      event.preventDefault();
      if (event.shiftKey) {
        this.toggleExpanded();
      } else {
        this.toggleVisible();
      }
    };

    window.addEventListener('keydown', this._keyHandler);

    this._boundDragMove = this._handleDragMove.bind(this);
    this._boundDragEnd = this._handleDragEnd.bind(this);

    if (this.visible) {
      this.peeker.classList.remove('is-visible');
    }
  }

  _createDetailRow(label) {
    const row = document.createElement('div');
    row.className = 'guardian-hud__detail';
    const labelEl = document.createElement('div');
    labelEl.className = 'guardian-hud__detail-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('div');
    valueEl.textContent = '—';
    row.appendChild(labelEl);
    row.appendChild(valueEl);
    return { row, valueEl };
  }

  update(metrics) {
    if (this.disabled || !metrics) return;
    this.lastMetrics = metrics;

    const nowTs = metrics.timestamp || performance.now();
    if (nowTs - this.lastUpdateTs < this.updateIntervalMs) {
      return;
    }
    this.lastUpdateTs = nowTs;

    const targetFps = Number(this.targetFpsProvider()) || 60;
    const fpsInstant = Number(metrics.fps?.instant) || 0;
    const fpsAvg = Number(metrics.fps?.avg) || fpsInstant;
    const frameTime = Number(metrics.frameTime?.latest) || (fpsInstant > 0 ? 1000 / fpsInstant : 0);

    this.fpsValue.textContent = formatNumber(fpsAvg, fpsAvg >= 100 ? 0 : 1);
    this.frameTimeValue.textContent = `${formatNumber(frameTime, frameTime >= 20 ? 1 : 2)} ms`;

    this._pushHistory(fpsInstant || fpsAvg);
    this._drawSparkline(targetFps);

    const status = this._determineStatus(fpsAvg, targetFps, metrics);
    this.root.dataset.status = status;
    this.status = status;

    this._updateQuality(metrics);
    this._updateDrops(metrics);
    this._updateDetails(metrics, targetFps);
    this._updateAlert(metrics, targetFps);
    this._updatePeeker(metrics);
  }

  _pushHistory(value) {
    if (!Number.isFinite(value)) return;
    this.fpsHistory.push(value);
    if (this.fpsHistory.length > this.maxHistory) {
      this.fpsHistory.splice(0, this.fpsHistory.length - this.maxHistory);
    }
  }

  _drawSparkline(targetFps) {
    if (!this.sparkCtx) return;
    const ctx = this.sparkCtx;
    const width = this.sparkCanvas.width;
    const height = this.sparkCanvas.height;
    ctx.clearRect(0, 0, width, height);

    if (!this.fpsHistory.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(0, height - 1, width, 1);
      return;
    }

    const maxFps = Math.max(targetFps * 1.3, ...this.fpsHistory, 1);
    const minFps = 0;
    const span = maxFps - minFps || 1;

    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    const targetY = height - ((targetFps - minFps) / span) * height;
    ctx.beginPath();
    ctx.moveTo(0, targetY);
    ctx.lineTo(width, targetY);
    ctx.stroke();

    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(33, 150, 243, 0.55)');
    gradient.addColorStop(1, 'rgba(33, 150, 243, 0.05)');
    ctx.fillStyle = gradient;
    ctx.strokeStyle = 'rgba(129, 212, 250, 0.95)';

    const points = this.fpsHistory;
    const step = width / Math.max(points.length - 1, 1);
    ctx.beginPath();
    points.forEach((value, index) => {
      const x = index * step;
      const y = height - ((value - minFps) / span) * height;
      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();

    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.globalAlpha = 0.4;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  _determineStatus(fps, targetFps, metrics) {
    if (!Number.isFinite(fps) || fps <= 0) return 'critical';
    const warnFps = Math.max(20, targetFps * 0.85);
    const critFps = Math.max(15, targetFps * 0.65);
    if (fps >= warnFps) return 'ok';
    if (fps >= critFps) return 'warn';
    return 'critical';
  }

  _updateQuality(metrics) {
    const qualityInfo = this.qualityProvider?.() || {};
    const pixelRatio = Number(qualityInfo.pixelRatio ?? metrics.renderer?.pixelRatio);
    const cap = Number(qualityInfo.pixelRatioCap ?? qualityInfo.cap);
    const min = Number(qualityInfo.minPixelRatio ?? qualityInfo.min);
    const auto = qualityInfo.autoResolution ?? qualityInfo.auto ?? false;
    const profile = qualityInfo.profile ?? qualityInfo.qualityLevel ?? qualityInfo.effectsProfile;

    let text = 'Quality —';
    if (Number.isFinite(pixelRatio)) {
      text = `PR ${pixelRatio.toFixed(2)}`;
      if (Number.isFinite(cap)) {
        text += ` · cap ${cap.toFixed(2)}`;
      }
      if (Number.isFinite(min)) {
        text += ` · min ${min.toFixed(2)}`;
      }
      if (profile) {
        text += ` · ${String(profile)}`;
      }
      if (auto) {
        text += ' · auto';
      }
    }
    this.qualityBadge.textContent = text;
  }

  _updateDrops(metrics) {
    const drops = metrics.frameBudget?.droppedFrames;
    const total = drops?.total ?? 0;
    const consecutive = drops?.consecutive ?? 0;
    this.dropBadge.textContent = `Drops ${total}${consecutive > 1 ? ` (${consecutive})` : ''}`;
  }

  _updateDetails(metrics, targetFps) {
    if (!this.detailNodes) return;
    const fpsTrend = Number(metrics.fps?.trend10s) || 0;
    this.detailNodes.fpsTrend.valueEl.textContent = formatNumber(fpsTrend, fpsTrend >= 100 ? 0 : 1);

    const cpuAvg = Number(metrics.cpu?.mainThread?.avg);
    this.detailNodes.cpuAvg.valueEl.textContent = `${formatNumber(cpuAvg, cpuAvg >= 20 ? 1 : 2)} ms`;

    const gpuAvg = Number(metrics.gpu?.avg);
    this.detailNodes.gpuAvg.valueEl.textContent = Number.isFinite(gpuAvg) && gpuAvg > 0
      ? `${formatNumber(gpuAvg, gpuAvg >= 20 ? 1 : 2)} ms`
      : 'n/a';

    const util = Number(metrics.frameBudget?.avgUtilisation);
    this.detailNodes.budget.valueEl.textContent = formatPercent(util || 0, 0);

    const drawCalls = Number(metrics.renderer?.drawCalls);
    const tris = Number(metrics.renderer?.triangles);
    const drawText = Number.isFinite(drawCalls)
      ? `${drawCalls.toFixed(0)} dc · ${(tris || 0).toLocaleString()} tris`
      : '—';
    this.detailNodes.renderer.valueEl.textContent = drawText;

    const memory = metrics.memory;
    if (memory?.supported) {
      this.detailNodes.memory.valueEl.textContent = `${formatMemoryMb(memory.usedMB)} / ${formatMemoryMb(memory.limitMB)}`;
    } else {
      this.detailNodes.memory.valueEl.textContent = 'n/a';
    }
  }

  _updateAlert(metrics, targetFps) {
    const latestUtil = Number(metrics.frameBudget?.latestUtilisation) || 0;
    const consecutiveDrops = Number(metrics.frameBudget?.droppedFrames?.consecutive) || 0;
    const alertMessages = [];

    if (latestUtil > 1.05) {
      alertMessages.push(`Frame over budget (${formatPercent(latestUtil, 0)})`);
    }
    if (consecutiveDrops >= 5) {
      alertMessages.push(`Dropping frames (${consecutiveDrops})`);
    }
    if (!Number.isFinite(metrics.gpu?.avg) && metrics.gpu?.supported === false) {
      alertMessages.push('GPU timing unavailable');
    }

    if (alertMessages.length) {
      this.root.classList.add('has-alert');
      this.alertBox.textContent = alertMessages.join(' · ');
    } else {
      this.root.classList.remove('has-alert');
      this.alertBox.textContent = '';
    }
  }

  _updatePeeker(metrics) {
    if (!this.peeker) return;
    const fps = Number(metrics.fps?.avg) || Number(metrics.fps?.instant) || 0;
    if (fps > 0) {
      this.peeker.textContent = `HUD off · ${formatNumber(fps, fps >= 100 ? 0 : 1)} fps (press P)`;
    } else {
      this.peeker.textContent = 'Performance HUD off (press P)';
    }
  }

  toggleVisible(force) {
    const next = typeof force === 'boolean' ? force : !this.visible;
    if (next === this.visible) return;
    this.visible = next;
    if (this.visible) {
      this.root.classList.remove('is-hidden');
      this.peeker.classList.remove('is-visible');
    } else {
      this.root.classList.add('is-hidden');
      this.peeker.classList.add('is-visible');
    }
    this._persistState();
  }

  toggleExpanded(force) {
    const next = typeof force === 'boolean' ? force : !this.expanded;
    if (next === this.expanded) return;
    this.expanded = next;
    if (this.expanded) {
      this.root.classList.add('is-expanded');
      this.collapseBtn.textContent = '−';
    } else {
      this.root.classList.remove('is-expanded');
      this.collapseBtn.textContent = '＋';
    }
    this._persistState();
  }

  _handleDragStart(event) {
    if (event.button !== 0 && event.pointerType !== 'touch') return;
    this.dragging = true;
    this.pointerId = event.pointerId;
    this.header.setPointerCapture(this.pointerId);
    const rect = this.root.getBoundingClientRect();
    this.offsetX = event.clientX - rect.left;
    this.offsetY = event.clientY - rect.top;
    window.addEventListener('pointermove', this._boundDragMove);
    window.addEventListener('pointerup', this._boundDragEnd, { once: true });
  }

  _handleDragMove(event) {
    if (!this.dragging) return;
    const x = Math.max(6, event.clientX - this.offsetX);
    const y = Math.max(6, event.clientY - this.offsetY);
    this.root.style.left = `${x}px`;
    this.root.style.top = `${y}px`;
    this.root.style.right = 'auto';
  }

  _handleDragEnd(event) {
    if (!this.dragging) return;
    this.dragging = false;
    window.removeEventListener('pointermove', this._boundDragMove);
    this.header.releasePointerCapture(this.pointerId);
    this.pointerId = null;
    const rect = this.root.getBoundingClientRect();
    this.state.position = { x: rect.left, y: rect.top };
    this._persistState();
  }

  _persistState() {
    try {
      const payload = {
        visible: this.visible,
        expanded: this.expanded,
        position: this.state.position,
      };
      window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (_) {
      // ignore persistence errors
    }
  }

  destroy() {
    if (this.disabled) return;
    window.removeEventListener('keydown', this._keyHandler);
    window.removeEventListener('pointermove', this._boundDragMove);
    if (this.root?.parentNode) {
      this.root.parentNode.removeChild(this.root);
    }
    if (this.peeker?.parentNode) {
      this.peeker.parentNode.removeChild(this.peeker);
    }
    this.disabled = true;
  }
}

export default PerformanceHud;




