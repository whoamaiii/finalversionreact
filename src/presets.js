// Built-in presets for common styles/BPMs. Values are tuned to work with
// the current mapping and audio engine. Users can still override via sliders.

export const BUILT_IN_PRESETS = {
  'Rave 161': {
    audio: {
      smoothing: 0.55, lowHz: 180, midHz: 2500, beatCooldown: 340,
      subHz: 90, envAttack: 0.7, envRelease: 0.12, agcEnabled: true, agcDecay: 0.996,
      drop: { enabled: true, flux: 1.6, bass: 0.6, centroidSlope: 0.025, minBeats: 8, cooldownMs: 6000 },
    },
    visuals: { bloomReactive: 0.8 },
    mapping: {
      sizeFromRms: 0.55, sphereBrightnessFromRms: 1.7, sphereNoiseFromMid: 1.25,
      ringScaleFromBands: 0.5, ringSpeedFromBands: 2.0, ringNoiseFromBands: 0.5,
      cameraShakeFromBeat: 0.38, lightIntensityFromBass: 2.6, ringTiltFromBass: 0.7,
      starTwinkleFromTreble: 1.3, spherePulseFromBass: 1.0, sphereSparkleFromTreble: 0.9,
      fovPumpFromBass: 0.7, bandWeightBass: 1.3, bandWeightMid: 1.1, bandWeightTreble: 1.1,
      cameraRollFromCentroid: 0.22, mainSwayFromFlux: 0.18, chromaLightInfluence: 0.35, ringBrightFromChroma: 0.45,
      advancedMapping: true,
      sizeWeights: { bass: 1.10, mid: 0.50, treble: 0.20 },
      ringScaleWeights: { bass: 0.90, mid: 0.55, treble: 0.20 },
      ringSpeedWeights: { bass: 0.40, mid: 1.10, treble: 0.35 },
      sphereNoiseWeights: { bass: 0.20, mid: 1.00, treble: 0.40 },
      ringNoiseWeights: { bass: 0.35, mid: 0.65, treble: 0.30 },
      drop: { intensity: 1.0, bloomBoost: 0.6, shake: 0.5, ringBurst: 0.6 },
    },
  },

  'Techno 130': {
    audio: {
      smoothing: 0.6, lowHz: 170, midHz: 2300, beatCooldown: 380,
      subHz: 85, envAttack: 0.65, envRelease: 0.14, agcEnabled: true, agcDecay: 0.995,
      drop: { enabled: true, flux: 1.5, bass: 0.55, centroidSlope: 0.02, minBeats: 8, cooldownMs: 7000 },
    },
    visuals: { bloomReactive: 0.7 },
    mapping: {
      sizeFromRms: 0.5, sphereBrightnessFromRms: 1.5, sphereNoiseFromMid: 1.0,
      ringScaleFromBands: 0.42, ringSpeedFromBands: 1.6, ringNoiseFromBands: 0.45,
      cameraShakeFromBeat: 0.32, lightIntensityFromBass: 2.2, ringTiltFromBass: 0.55,
      starTwinkleFromTreble: 1.1, spherePulseFromBass: 0.85, sphereSparkleFromTreble: 0.75,
      fovPumpFromBass: 0.55, bandWeightBass: 1.2, bandWeightMid: 1.1, bandWeightTreble: 1.0,
      cameraRollFromCentroid: 0.18, mainSwayFromFlux: 0.12, chromaLightInfluence: 0.3, ringBrightFromChroma: 0.35,
      advancedMapping: true,
      sizeWeights: { bass: 1.0, mid: 0.45, treble: 0.2 },
      ringScaleWeights: { bass: 0.8, mid: 0.55, treble: 0.2 },
      ringSpeedWeights: { bass: 0.35, mid: 0.95, treble: 0.35 },
      sphereNoiseWeights: { bass: 0.2, mid: 0.9, treble: 0.35 },
      ringNoiseWeights: { bass: 0.35, mid: 0.55, treble: 0.3 },
      drop: { intensity: 0.9, bloomBoost: 0.5, shake: 0.45, ringBurst: 0.55 },
    },
  },

  'DNB 174': {
    audio: {
      smoothing: 0.5, lowHz: 190, midHz: 2600, beatCooldown: 320,
      subHz: 95, envAttack: 0.75, envRelease: 0.1, agcEnabled: true, agcDecay: 0.997,
      drop: { enabled: true, flux: 1.8, bass: 0.62, centroidSlope: 0.03, minBeats: 12, cooldownMs: 7000 },
    },
    visuals: { bloomReactive: 0.9 },
    mapping: {
      sizeFromRms: 0.52, sphereBrightnessFromRms: 1.8, sphereNoiseFromMid: 1.3,
      ringScaleFromBands: 0.48, ringSpeedFromBands: 2.2, ringNoiseFromBands: 0.55,
      cameraShakeFromBeat: 0.42, lightIntensityFromBass: 2.8, ringTiltFromBass: 0.75,
      starTwinkleFromTreble: 1.5, spherePulseFromBass: 1.1, sphereSparkleFromTreble: 1.0,
      fovPumpFromBass: 0.8, bandWeightBass: 1.35, bandWeightMid: 1.15, bandWeightTreble: 1.2,
      cameraRollFromCentroid: 0.25, mainSwayFromFlux: 0.2, chromaLightInfluence: 0.4, ringBrightFromChroma: 0.5,
      advancedMapping: true,
      sizeWeights: { bass: 1.1, mid: 0.55, treble: 0.25 },
      ringScaleWeights: { bass: 0.9, mid: 0.6, treble: 0.2 },
      ringSpeedWeights: { bass: 0.35, mid: 1.15, treble: 0.45 },
      sphereNoiseWeights: { bass: 0.2, mid: 1.0, treble: 0.45 },
      ringNoiseWeights: { bass: 0.35, mid: 0.7, treble: 0.35 },
      drop: { intensity: 1.1, bloomBoost: 0.65, shake: 0.55, ringBurst: 0.7 },
    },
  },

  'House 124': {
    audio: {
      smoothing: 0.62, lowHz: 170, midHz: 2400, beatCooldown: 380,
      subHz: 80, envAttack: 0.6, envRelease: 0.16, agcEnabled: true, agcDecay: 0.995,
      drop: { enabled: true, flux: 1.4, bass: 0.55, centroidSlope: 0.02, minBeats: 8, cooldownMs: 6500 },
    },
    visuals: { bloomReactive: 0.7 },
    mapping: {
      sizeFromRms: 0.6, sphereBrightnessFromRms: 1.5, sphereNoiseFromMid: 0.95,
      ringScaleFromBands: 0.42, ringSpeedFromBands: 1.4, ringNoiseFromBands: 0.4,
      cameraShakeFromBeat: 0.28, lightIntensityFromBass: 2.1, ringTiltFromBass: 0.5,
      starTwinkleFromTreble: 1.0, spherePulseFromBass: 0.8, sphereSparkleFromTreble: 0.7,
      fovPumpFromBass: 0.5, bandWeightBass: 1.15, bandWeightMid: 1.0, bandWeightTreble: 0.95,
      cameraRollFromCentroid: 0.16, mainSwayFromFlux: 0.1, chromaLightInfluence: 0.25, ringBrightFromChroma: 0.28,
      advancedMapping: false,
      drop: { intensity: 0.9, bloomBoost: 0.45, shake: 0.4, ringBurst: 0.5 },
    },
  },

  'Chill 95': {
    audio: {
      smoothing: 0.68, lowHz: 160, midHz: 2200, beatCooldown: 420,
      subHz: 75, envAttack: 0.55, envRelease: 0.18, agcEnabled: true, agcDecay: 0.993,
      drop: { enabled: false, flux: 1.2, bass: 0.5, centroidSlope: 0.015, minBeats: 6, cooldownMs: 7000 },
    },
    visuals: { bloomReactive: 0.6 },
    mapping: {
      sizeFromRms: 0.58, sphereBrightnessFromRms: 1.3, sphereNoiseFromMid: 0.9,
      ringScaleFromBands: 0.36, ringSpeedFromBands: 1.0, ringNoiseFromBands: 0.35,
      cameraShakeFromBeat: 0.18, lightIntensityFromBass: 1.6, ringTiltFromBass: 0.4,
      starTwinkleFromTreble: 0.9, spherePulseFromBass: 0.7, sphereSparkleFromTreble: 0.6,
      fovPumpFromBass: 0.35, bandWeightBass: 1.0, bandWeightMid: 0.9, bandWeightTreble: 0.9,
      cameraRollFromCentroid: 0.1, mainSwayFromFlux: 0.07, chromaLightInfluence: 0.2, ringBrightFromChroma: 0.22,
      advancedMapping: false,
    },
  },

  'Ambient': {
    audio: {
      smoothing: 0.7, lowHz: 160, midHz: 2200, beatCooldown: 500,
      subHz: 70, envAttack: 0.5, envRelease: 0.2, agcEnabled: true, agcDecay: 0.992,
      drop: { enabled: false, flux: 1.0, bass: 0.5, centroidSlope: 0.01, minBeats: 6, cooldownMs: 8000 },
    },
    visuals: { bloomReactive: 0.5 },
    mapping: {
      sizeFromRms: 0.5, sphereBrightnessFromRms: 1.1, sphereNoiseFromMid: 0.8,
      ringScaleFromBands: 0.30, ringSpeedFromBands: 0.9, ringNoiseFromBands: 0.3,
      cameraShakeFromBeat: 0.12, lightIntensityFromBass: 1.4, ringTiltFromBass: 0.35,
      starTwinkleFromTreble: 0.8, spherePulseFromBass: 0.6, sphereSparkleFromTreble: 0.5,
      fovPumpFromBass: 0.3, bandWeightBass: 0.9, bandWeightMid: 0.9, bandWeightTreble: 0.9,
      cameraRollFromCentroid: 0.06, mainSwayFromFlux: 0.04, chromaLightInfluence: 0.15, ringBrightFromChroma: 0.15,
      advancedMapping: false,
    },
  },

  'Ellis Daisies 123': {
    audio: {
      smoothing: 0.58, lowHz: 175, midHz: 2350, beatCooldown: 360,
      subHz: 88, envAttack: 0.68, envRelease: 0.13, agcEnabled: true, agcDecay: 0.996,
      drop: { enabled: true, flux: 1.55, bass: 0.58, centroidSlope: 0.022, minBeats: 8, cooldownMs: 6200 },
    },
    visuals: { bloomReactive: 0.78 },
    mapping: {
      sizeFromRms: 0.57, sphereBrightnessFromRms: 1.65, sphereNoiseFromMid: 1.15,
      ringScaleFromBands: 0.46, ringSpeedFromBands: 1.85, ringNoiseFromBands: 0.48,
      cameraShakeFromBeat: 0.36, lightIntensityFromBass: 2.45, ringTiltFromBass: 0.68,
      starTwinkleFromTreble: 1.25, spherePulseFromBass: 0.95, sphereSparkleFromTreble: 0.88,
      fovPumpFromBass: 0.62, bandWeightBass: 1.28, bandWeightMid: 1.08, bandWeightTreble: 1.05,
      cameraRollFromCentroid: 0.17, mainSwayFromFlux: 0.14, chromaLightInfluence: 0.32, ringBrightFromChroma: 0.38,
      advancedMapping: true,
      sizeWeights: { bass: 1.05, mid: 0.48, treble: 0.22 },
      ringScaleWeights: { bass: 0.86, mid: 0.58, treble: 0.24 },
      ringSpeedWeights: { bass: 0.38, mid: 1.02, treble: 0.34 },
      sphereNoiseWeights: { bass: 0.22, mid: 0.98, treble: 0.38 },
      ringNoiseWeights: { bass: 0.33, mid: 0.62, treble: 0.32 },
      drop: { intensity: 1.05, bloomBoost: 0.62, shake: 0.52, ringBurst: 0.65 },
    },
  },
};




