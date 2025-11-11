/**
 * RecoveryModal - Crash recovery UI component
 * 
 * Shows a modal dialog when a crashed session is detected, allowing the user
 * to restore their previous session or start fresh.
 */

import { StateSnapshot } from './state-snapshot.js';
import { applyPresetSnapshot } from './preset-io.js';
import { showToast } from './toast.js';

const STYLE_ID = 'recovery-modal-styles';

function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .recovery-modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(8px);
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      animation: fadeIn 200ms ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .recovery-modal {
      background: rgba(12, 14, 18, 0.95);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      padding: 24px;
      max-width: 520px;
      width: 100%;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
      color: #f5f5f7;
      font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
      animation: slideUp 250ms ease;
    }

    @keyframes slideUp {
      from {
        opacity: 0;
        transform: translateY(20px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .recovery-modal__header {
      margin-bottom: 20px;
    }

    .recovery-modal__title {
      font-size: 22px;
      font-weight: 600;
      margin: 0 0 8px 0;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .recovery-modal__icon {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: rgba(255, 61, 0, 0.2);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
    }

    .recovery-modal__subtitle {
      font-size: 14px;
      opacity: 0.7;
      margin: 0;
      line-height: 1.5;
    }

    .recovery-modal__info {
      background: rgba(255, 255, 255, 0.05);
      border-radius: 10px;
      padding: 16px;
      margin-bottom: 20px;
    }

    .recovery-modal__info-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      font-size: 13px;
    }

    .recovery-modal__info-row:last-child {
      margin-bottom: 0;
    }

    .recovery-modal__info-label {
      opacity: 0.7;
    }

    .recovery-modal__info-value {
      font-weight: 500;
      color: #fff;
    }

    .recovery-modal__details {
      display: none;
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      font-size: 12px;
      opacity: 0.8;
      line-height: 1.6;
    }

    .recovery-modal.is-expanded .recovery-modal__details {
      display: block;
    }

    .recovery-modal__actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }

    .recovery-modal__btn {
      flex: 1;
      min-width: 120px;
      padding: 12px 20px;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 150ms ease;
      font-family: inherit;
    }

    .recovery-modal__btn--primary {
      background: #1890ff;
      color: white;
    }

    .recovery-modal__btn--primary:hover {
      background: #40a9ff;
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(24, 144, 255, 0.4);
    }

    .recovery-modal__btn--secondary {
      background: rgba(255, 255, 255, 0.1);
      color: #f5f5f7;
      border: 1px solid rgba(255, 255, 255, 0.15);
    }

    .recovery-modal__btn--secondary:hover {
      background: rgba(255, 255, 255, 0.15);
    }

    .recovery-modal__btn--ghost {
      background: transparent;
      color: rgba(255, 255, 255, 0.6);
      border: none;
      text-decoration: underline;
      text-underline-offset: 4px;
    }

    .recovery-modal__btn--ghost:hover {
      color: rgba(255, 255, 255, 0.9);
    }

    .recovery-modal__btn:active {
      transform: translateY(0);
    }
  `;
  document.head.appendChild(style);
}

/**
 * Format duration in milliseconds to human-readable string
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Show recovery modal
 * @param {Object} options
 * @param {StateSnapshot} options.snapshot - The crashed session snapshot
 * @param {Object} options.context - Application context for restoration
 * @param {Function} options.onRestore - Callback when user chooses to restore
 * @param {Function} options.onStartFresh - Callback when user chooses to start fresh
 */
export function showRecoveryModal({ snapshot, context, onRestore, onStartFresh }) {
  if (!snapshot) {
    console.warn('[RecoveryModal] No snapshot provided');
    return null;
  }

  injectStyles();

  // Create overlay
  const overlay = document.createElement('div');
  overlay.className = 'recovery-modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'recovery-modal-title');

  // Create modal
  const modal = document.createElement('div');
  modal.className = 'recovery-modal';

  // Header
  const header = document.createElement('div');
  header.className = 'recovery-modal__header';
  
  const title = document.createElement('h2');
  title.id = 'recovery-modal-title';
  title.className = 'recovery-modal__title';
  title.innerHTML = `
    <span class="recovery-modal__icon">⚠️</span>
    <span>Previous Session Ended Unexpectedly</span>
  `;
  
  const subtitle = document.createElement('p');
  subtitle.className = 'recovery-modal__subtitle';
  subtitle.textContent = 'Your previous session ended unexpectedly. Would you like to restore it?';
  
  header.appendChild(title);
  header.appendChild(subtitle);

  // Info section
  const info = document.createElement('div');
  info.className = 'recovery-modal__info';
  
  const presetName = snapshot.preset?.name || 'No preset loaded';
  const timeAgo = snapshot.getTimeAgo();
  const sessionDuration = snapshot.sessionMetadata?.totalRuntime 
    ? formatDuration(snapshot.sessionMetadata.totalRuntime)
    : 'Unknown';
  
  const infoRows = [
    { label: 'Last Preset', value: presetName },
    { label: 'Session Duration', value: sessionDuration },
    { label: 'Time Since Crash', value: timeAgo },
  ];
  
  infoRows.forEach(({ label, value }) => {
    const row = document.createElement('div');
    row.className = 'recovery-modal__info-row';
    row.innerHTML = `
      <span class="recovery-modal__info-label">${label}</span>
      <span class="recovery-modal__info-value">${value}</span>
    `;
    info.appendChild(row);
  });

  // Details section (collapsed by default)
  const details = document.createElement('div');
  details.className = 'recovery-modal__details';
  details.innerHTML = `
    <strong>Snapshot Details:</strong><br>
    Timestamp: ${new Date(snapshot.timestamp).toLocaleString()}<br>
    Audio Source: ${snapshot.audioSource?.type || 'Unknown'}<br>
    Tags: ${snapshot.tags.size > 0 ? Array.from(snapshot.tags).join(', ') : 'None'}
  `;

  // Track event handlers and timers for cleanup
  let closeTimeoutId = null;
  const restoreBtnHandler = () => { handleRestore(); };
  const startFreshBtnHandler = () => { handleStartFresh(); };
  const viewDetailsBtnHandler = () => {
    modal.classList.toggle('is-expanded');
    viewDetailsBtn.textContent = modal.classList.contains('is-expanded')
      ? 'Hide Details'
      : 'View Details';
  };
  const overlayClickHandler = (e) => {
    if (e.target === overlay) {
      close(); // Just close, don't trigger action
    }
  };
  const escapeHandler = (e) => {
    if (e.key === 'Escape') {
      close(); // Just close, don't trigger action
    }
  };

  // Actions
  const actions = document.createElement('div');
  actions.className = 'recovery-modal__actions';

  const restoreBtn = document.createElement('button');
  restoreBtn.className = 'recovery-modal__btn recovery-modal__btn--primary';
  restoreBtn.textContent = 'Restore Session';
  restoreBtn.addEventListener('click', restoreBtnHandler);

  const startFreshBtn = document.createElement('button');
  startFreshBtn.className = 'recovery-modal__btn recovery-modal__btn--secondary';
  startFreshBtn.textContent = 'Start Fresh';
  startFreshBtn.addEventListener('click', startFreshBtnHandler);

  const viewDetailsBtn = document.createElement('button');
  viewDetailsBtn.className = 'recovery-modal__btn recovery-modal__btn--ghost';
  viewDetailsBtn.textContent = 'View Details';
  viewDetailsBtn.addEventListener('click', viewDetailsBtnHandler);

  actions.appendChild(restoreBtn);
  actions.appendChild(startFreshBtn);
  actions.appendChild(viewDetailsBtn);

  // Assemble modal
  modal.appendChild(header);
  modal.appendChild(info);
  modal.appendChild(details);
  modal.appendChild(actions);
  overlay.appendChild(modal);

  // Add to DOM
  document.body.appendChild(overlay);

  // Handle restore
  function handleRestore() {
    try {
      if (onRestore) {
        onRestore(snapshot, context);
      } else {
        // Default restore behavior
        restoreSnapshot(snapshot, context);
      }
      close();
      showToast(`Session restored (${timeAgo})`, 3000);
    } catch (err) {
      console.error('[RecoveryModal] Restore failed:', err);
      showToast('Failed to restore session', 3000);
    }
  }

  // Handle start fresh
  function handleStartFresh() {
    try {
      if (onStartFresh) {
        onStartFresh(snapshot);
      }
      close();
      showToast('Starting fresh session', 2000);
    } catch (err) {
      console.error('[RecoveryModal] Start fresh failed:', err);
    }
  }

  // Cleanup function to remove all event listeners and timers
  function cleanup() {
    // Remove all event listeners
    try {
      restoreBtn.removeEventListener('click', restoreBtnHandler);
      startFreshBtn.removeEventListener('click', startFreshBtnHandler);
      viewDetailsBtn.removeEventListener('click', viewDetailsBtnHandler);
      overlay.removeEventListener('click', overlayClickHandler);
      document.removeEventListener('keydown', escapeHandler);
    } catch (err) {
      console.warn('[RecoveryModal] Error removing event listeners:', err);
    }

    // Clear close timeout if it exists
    if (closeTimeoutId) {
      clearTimeout(closeTimeoutId);
      closeTimeoutId = null;
    }
  }

  // Close modal
  function close() {
    // Clean up event listeners first
    cleanup();

    overlay.style.animation = 'fadeOut 200ms ease';
    closeTimeoutId = setTimeout(() => {
      if (overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
      closeTimeoutId = null;
    }, 200);
  }

  // Close on overlay click (outside modal)
  overlay.addEventListener('click', overlayClickHandler);

  // Close on Escape key
  document.addEventListener('keydown', escapeHandler);

  return {
    close,
    restore: handleRestore,
    startFresh: handleStartFresh,
  };
}

/**
 * Restore snapshot to application state
 * @param {StateSnapshot} snapshot - Snapshot to restore
 * @param {Object} context - Application context
 */
function restoreSnapshot(snapshot, context) {
  const { sceneApi, audioEngine, presetManager } = context;
  
  if (!sceneApi || !audioEngine) {
    throw new Error('restoreSnapshot requires sceneApi and audioEngine');
  }

  // Restore preset if available
  if (snapshot.preset?.snapshot && presetManager) {
    try {
      applyPresetSnapshot(snapshot.preset.snapshot, { sceneApi, audioEngine, silent: true });
      
      // Try to load the preset in preset manager
      if (snapshot.preset.id) {
        try {
          presetManager.load(snapshot.preset.id, { silent: true });
        } catch (err) {
          console.warn('[RecoveryModal] Failed to load preset in manager:', err);
        }
      }
    } catch (err) {
      console.error('[RecoveryModal] Failed to restore preset:', err);
    }
  }

  // Restore audio source if available
  if (snapshot.audioSource && audioEngine) {
    try {
      if (snapshot.audioSource.type === 'mic' && snapshot.audioSource.deviceId) {
        // Restore microphone source
        audioEngine.startMic(snapshot.audioSource.deviceId).catch(err => {
          console.warn('[RecoveryModal] Failed to restore audio source:', err);
        });
      } else if (snapshot.audioSource.type === 'file') {
        // File source - user will need to reload file
        console.log('[RecoveryModal] File audio source detected - user must reload file');
      }
    } catch (err) {
      console.warn('[RecoveryModal] Failed to restore audio source:', err);
    }
  }

  console.log('[RecoveryModal] Session restored successfully');
}

/**
 * Clean up recovery modal styles to prevent memory leaks
 * Should be called during application shutdown
 */
export function cleanupRecoveryModalStyles() {
  if (typeof document === 'undefined') return;
  try {
    const styleEl = document.getElementById(STYLE_ID);
    if (styleEl && styleEl.parentNode) {
      styleEl.parentNode.removeChild(styleEl);
    }
  } catch (err) {
    // Ignore cleanup errors - element may already be removed
  }
}

