const OS_TYPES = Object.freeze({
  MACOS: 'macos',
  WINDOWS: 'windows',
  LINUX: 'linux',
  UNKNOWN: 'unknown',
});

const VIRTUAL_DEVICE_HINTS = {
  [OS_TYPES.MACOS]: ['blackhole', 'loopback audio', 'soundflower'],
  [OS_TYPES.WINDOWS]: ['vb-cable', 'cable input', 'cable output', 'voicemeeter'],
  [OS_TYPES.LINUX]: ['showloopback', 'virtual sink', 'monitor of', 'pulse', 'jack sink'],
  [OS_TYPES.UNKNOWN]: [],
};

function getNavigator() {
  return typeof navigator !== 'undefined' ? navigator : null;
}

export function detectOperatingSystem() {
  const nav = getNavigator();
  if (!nav) return OS_TYPES.UNKNOWN;

  const ua = (nav.userAgent || '').toLowerCase();
  const platform = (nav.platform || '').toLowerCase();

  if (ua.includes('mac') || platform.includes('mac')) {
    return OS_TYPES.MACOS;
  }

  if (ua.includes('win') || platform.includes('win')) {
    return OS_TYPES.WINDOWS;
  }

  if (
    ua.includes('linux') ||
    ua.includes('x11') ||
    platform.includes('linux') ||
    platform.includes('x11')
  ) {
    return OS_TYPES.LINUX;
  }

  return OS_TYPES.UNKNOWN;
}

function sanitizeDevice(device) {
  return {
    deviceId: device.deviceId || '',
    groupId: device.groupId || '',
    kind: device.kind || 'unknown',
    label: device.label || '',
    hasLabel: Boolean(device.label),
  };
}

function uniqueByDeviceId(devices) {
  const seen = new Set();
  return devices.filter((device) => {
    const key = `${device.kind}:${device.deviceId || device.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function detectVirtualDevices(os, devices) {
  const hints = VIRTUAL_DEVICE_HINTS[os] || [];
  if (!hints.length) return [];

  const lowerDevices = devices.map((device) => ({
    original: device,
    label: (device.label || '').toLowerCase(),
  }));

  const matches = lowerDevices
    .filter(({ label }) => label && hints.some((hint) => label.includes(hint)))
    .map(({ original }) => sanitizeDevice(original));

  return uniqueByDeviceId(matches);
}

async function enumerateDevices() {
  const nav = getNavigator();
  if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.enumerateDevices !== 'function') {
    return { devices: [], error: 'enumerateDevicesUnavailable' };
  }

  try {
    const devices = await nav.mediaDevices.enumerateDevices();
    return { devices, error: null };
  } catch (error) {
    return {
      devices: [],
      error: {
        name: error?.name || 'EnumerateDevicesError',
        message: error?.message || String(error),
      },
    };
  }
}

function detectChromeTabCapture(nav) {
  if (!nav || !nav.mediaDevices) return { available: false, reason: 'mediaDevicesUnavailable' };
  const available = typeof nav.mediaDevices.getDisplayMedia === 'function';
  return {
    available,
    reason: available ? 'supported' : 'getDisplayMediaUnavailable',
  };
}

function detectMicrophoneAvailability(devices, enumerateError) {
  if (enumerateError) {
    return {
      available: false,
      reason: 'enumerateDevicesFailed',
      needsPermission: enumerateError.name === 'NotAllowedError',
    };
  }

  const inputs = devices.filter((device) => device.kind === 'audioinput');
  const hasVisibleLabels = inputs.some((device) => device.label);
  const available = inputs.length > 0;

  return {
    available,
    reason: available ? 'detected' : 'noAudioInputs',
    devices: uniqueByDeviceId(inputs.map(sanitizeDevice)),
    needsPermission: !hasVisibleLabels,
  };
}

export async function detectAudioRoutingCapabilities() {
  const nav = getNavigator();
  const os = detectOperatingSystem();
  const timestamp = Date.now();

  const { devices, error: enumerateError } = await enumerateDevices();

  const audioInputs = devices.filter((device) => device.kind === 'audioinput');
  const audioOutputs = devices.filter((device) => device.kind === 'audiooutput');

  const virtualDevices = detectVirtualDevices(os, audioInputs.concat(audioOutputs));
  const chromeTab = detectChromeTabCapture(nav);
  const microphone = detectMicrophoneAvailability(devices, enumerateError);

  const blackholeAvailable = virtualDevices.length > 0;

  const capabilityMatrix = {
    blackhole: {
      available: blackholeAvailable,
      reason: blackholeAvailable ? 'detected' : 'virtualDeviceMissing',
      devices: virtualDevices,
      needsPermission: !blackholeAvailable && microphone.needsPermission,
    },
    chromeTab,
    microphone,
  };

  const summary = {
    os,
    timestamp,
    capabilityMatrix,
    devices: {
      audioInputs: uniqueByDeviceId(audioInputs.map(sanitizeDevice)),
      audioOutputs: uniqueByDeviceId(audioOutputs.map(sanitizeDevice)),
    },
  };

  if (enumerateError) {
    summary.enumerateError = enumerateError;
  }

  return summary;
}

export const AudioRoutingDetector = {
  detectOperatingSystem,
  detectAudioRoutingCapabilities,
};

export default AudioRoutingDetector;




