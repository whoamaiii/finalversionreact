const cache = new Map();

function loadOnce(key, importer, transform = (value) => value) {
  if (!cache.has(key)) {
    cache.set(key, importer().then(transform));
  }
  return cache.get(key);
}

export function loadAubio() {
  return loadOnce('aubio', async () => {
    const candidates = [
      'https://esm.sh/aubiojs@0.0.11',
      'https://esm.sh/aubiojs@0.0.9',
      'https://cdn.jsdelivr.net/npm/aubiojs@0.0.11/+esm',
      'https://cdn.jsdelivr.net/npm/aubiojs@0.0.9/+esm',
    ];
    for (const url of candidates) {
      try {
        const mod = await import(/* @vite-ignore */ url);
        return mod.default ?? mod;
      } catch (_) {
        // try next candidate
      }
    }
    throw new Error('Aubio module could not be loaded from CDNs');
  });
}

export function loadEssentia() {
  return loadOnce('essentia', () => import('essentia.js'));
}

export function loadMeyda() {
  return loadOnce('meyda', () => import('meyda'), (mod) => mod.default ?? mod);
}

export function loadMl5() {
  return loadOnce('ml5', () => import('ml5'), (mod) => mod.default ?? mod);
}

export function loadButterchurn() {
  return loadOnce('butterchurn', () => import('butterchurn'), (mod) => mod.default ?? mod);
}

export function loadWavesurfer() {
  return loadOnce('wavesurfer', () => import('wavesurfer.js'), (mod) => mod.default ?? mod);
}
