#!/usr/bin/env node
/*
  WebSocket → OSC bridge for TouchDesigner.

  - Receives feature frames from the browser via WebSocket (JSON)
  - Emits OSC messages to a configurable host/port

  Defaults:
    WS listen: 127.0.0.1:8090
    OSC out:   127.0.0.1:9000

  You can override via env vars:
    WS_HOST, WS_PORT, OSC_HOST, OSC_PORT
*/

// Load environment variables from .env if present (tools directory)
try { require('dotenv').config(); } catch (_) {}
const WebSocket = require('ws');
const osc = require('osc');

const WS_HOST = process.env.WS_HOST || '127.0.0.1';
const WS_PORT = parseInt(process.env.WS_PORT || '8090', 10);
const OSC_HOST = process.env.OSC_HOST || '127.0.0.1';
const OSC_PORT = parseInt(process.env.OSC_PORT || '9000', 10);
const HEARTBEAT_MS = parseInt(process.env.BRIDGE_HEARTBEAT_MS || '5000', 10);

const udpPort = new osc.UDPPort({ localAddress: '0.0.0.0', localPort: 0, remoteAddress: OSC_HOST, remotePort: OSC_PORT });
udpPort.on('ready', () => {
  console.log(`[OSC] → ${OSC_HOST}:${OSC_PORT}`);
});
udpPort.on('error', (e) => console.error('[OSC] error', e));
udpPort.open();

const wss = new WebSocket.Server({ host: WS_HOST, port: WS_PORT });
const clients = new Set();
wss.on('listening', () => {
  console.log(`[WS] listening on ws://${WS_HOST}:${WS_PORT}`);
  console.log(`[CFG] OSC → ${OSC_HOST}:${OSC_PORT} | Heartbeat ${HEARTBEAT_MS}ms`);
});
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[WS] client connected from ${ip}`);
  clients.add(ws);

  ws.on('error', (err) => {
    console.error('[WS] Client error:', err);
    clients.delete(ws);
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log('[WS] client disconnected');
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (_) {
      return;
    }
    if (!msg || msg.type !== 'features' || typeof msg.payload !== 'object') return;
    const f = msg.payload;

    // Scalar channels
    send('/reactive/rms', f.rms || 0);
    send('/reactive/rmsNorm', f.rmsNorm || 0);
    send('/reactive/centroid', f.centroidNorm || 0);
    send('/reactive/flux', f.flux || 0);
    send('/reactive/fluxMean', f.fluxMean || 0);
    send('/reactive/fluxStd', f.fluxStd || 0);
    send('/reactive/bpm', f.bpm || 0);
    send('/reactive/bpm/conf', f.bpmConfidence || 0);
    if (f.bpmSource) send('/reactive/bpm/source', f.bpmSource);
    send('/reactive/tapBpm', f.tapBpm || 0);
    send('/reactive/pitchHz', f.pitchHz || 0);
    send('/reactive/pitchConf', f.pitchConf || 0);
    send('/reactive/aubioTempoBpm', f.aubioTempoBpm || 0);
    send('/reactive/aubioTempoConf', f.aubioTempoConf || 0);
    send('/reactive/beat', f.beat ? 1 : 0);
    send('/reactive/drop', f.drop ? 1 : 0);
    send('/reactive/isBuilding', f.isBuilding ? 1 : 0);
    send('/reactive/buildLevel', f.buildLevel || 0);

    // Bands
    if (f.bandsEMA) {
      send('/reactive/bandsEMA/bass', f.bandsEMA.bass || 0);
      send('/reactive/bandsEMA/mid', f.bandsEMA.mid || 0);
      send('/reactive/bandsEMA/treble', f.bandsEMA.treble || 0);
    }
    if (f.bandEnv) {
      send('/reactive/bandEnv/sub', f.bandEnv.sub || 0);
      send('/reactive/bandEnv/bass', f.bandEnv.bass || 0);
      send('/reactive/bandEnv/mid', f.bandEnv.mid || 0);
      send('/reactive/bandEnv/treble', f.bandEnv.treble || 0);
    }
    if (f.bandNorm) {
      send('/reactive/bandNorm/sub', f.bandNorm.sub || 0);
      send('/reactive/bandNorm/bass', f.bandNorm.bass || 0);
      send('/reactive/bandNorm/mid', f.bandNorm.mid || 0);
      send('/reactive/bandNorm/treble', f.bandNorm.treble || 0);
    }

    // MFCC and Chroma arrays (bounded lengths)
    if (Array.isArray(f.mfcc)) {
      for (let i = 0; i < Math.min(f.mfcc.length, 13); i++) {
        send(`/reactive/mfcc/${i}`, f.mfcc[i] || 0);
      }
    }
    if (Array.isArray(f.chroma)) {
      for (let i = 0; i < Math.min(f.chroma.length, 12); i++) {
        send(`/reactive/chroma/${i}`, f.chroma[i] || 0);
      }
    }

    // Beat grid info (send compactly)
    if (f.beatGrid) {
      const bg = f.beatGrid;
      send('/reactive/beatGrid/bpm', bg.bpm || 0);
      send('/reactive/beatGrid/conf', bg.confidence || 0);
    }
  });
});

wss.on('error', (err) => {
  console.error('[WS] Server error:', err);
});

function send(address, ...args) {
  try {
    udpPort.send({ address, args: args.map(toOscArg) });
  } catch (e) {
    // ignore transient errors
  }
}

function toOscArg(v) {
  if (typeof v === 'number' && isFinite(v)) return { type: 'f', value: v };
  if (typeof v === 'boolean') return { type: 'i', value: v ? 1 : 0 };
  return { type: 's', value: String(v ?? '') };
}

// Periodic heartbeat / health summary
const heartbeatInterval = setInterval(() => {
  try {
    const connectedClients = Array.from(clients).filter(c => c.readyState === c.OPEN).length;
    console.log(`[HEARTBEAT] WS clients=${connectedClients}`);
  } catch (_) {}
}, HEARTBEAT_MS);

// Graceful Shutdown Handlers
// ===========================
// Clean up all resources when process terminates (SIGTERM from PM2, SIGINT from Ctrl+C)

function gracefulShutdown(signal) {
  console.log(`\n[Shutdown] Received ${signal}, cleaning up resources...`);

  // Clear heartbeat interval
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    console.log('[Shutdown] Heartbeat interval cleared');
  }

  // Close all WebSocket clients
  try {
    console.log(`[Shutdown] Closing ${clients.size} WebSocket client(s)...`);
    clients.forEach(ws => {
      try {
        ws.close(1001, 'Server shutting down');
      } catch (err) {
        console.warn('[Shutdown] Error closing WebSocket client:', err.message);
      }
    });
    clients.clear();
  } catch (err) {
    console.error('[Shutdown] Error closing WebSocket clients:', err);
  }

  // Close WebSocket server
  try {
    console.log('[Shutdown] Closing WebSocket server...');
    wss.close((err) => {
      if (err) {
        console.error('[Shutdown] Error closing WebSocket server:', err);
      } else {
        console.log('[Shutdown] WebSocket server closed');
      }
    });
  } catch (err) {
    console.error('[Shutdown] Error closing WebSocket server:', err);
  }

  // Close OSC UDP port
  try {
    console.log('[Shutdown] Closing OSC UDP port...');
    udpPort.close();
    console.log('[Shutdown] OSC UDP port closed');
  } catch (err) {
    console.error('[Shutdown] Error closing OSC port:', err);
  }

  // Exit cleanly after allowing time for cleanup
  setTimeout(() => {
    console.log('[Shutdown] Cleanup complete, exiting');
    process.exit(0);
  }, 1000);
}

// Register shutdown handlers for SIGTERM (PM2 stop) and SIGINT (Ctrl+C)
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions and unhandled promise rejections
process.on('uncaughtException', (err) => {
  console.error('[Fatal] Uncaught exception:', err);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Fatal] Unhandled promise rejection at:', promise, 'reason:', reason);
  gracefulShutdown('unhandledRejection');
});


