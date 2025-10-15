import * as THREE from 'three';

const eyeVertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const eyeFragmentShader = `
  precision highp float;

  varying vec2 vUv;

  uniform float uTime;
  uniform float uPupilRadius;
  uniform float uPupilAspect;
  uniform float uBlink;
  uniform float uHue;
  uniform float uSat;
  uniform float uIrisGain;
  uniform float uFiberContrast;
  uniform float uFiberNoiseScale;
  uniform float uLimbus;
  uniform vec2 uGlintPos;
  uniform float uGlintSize;
  uniform float uGlintIntensity;
  uniform float uAlpha;

  float hash(float n) { return fract(sin(n) * 43758.5453); }
  float noise(vec2 x) {
    vec2 i = floor(x);
    vec2 f = fract(x);
    float a = hash(i.x + i.y * 57.0);
    float b = hash(i.x + 1.0 + i.y * 57.0);
    float c = hash(i.x + (i.y + 1.0) * 57.0);
    float d = hash(i.x + 1.0 + (i.y + 1.0) * 57.0);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  float fbm(vec2 x) {
    float n = 0.0;
    float amp = 0.55;
    float freq = 1.0;
    for (int i = 0; i < 4; i++) {
      n += amp * noise(x * freq);
      freq *= 2.3;
      amp *= 0.55;
    }
    return n;
  }

  vec3 hsl2rgb(float h, float s, float l) {
    float c = (1.0 - abs(2.0 * l - 1.0)) * s;
    float hp = h * 6.0;
    float x = c * (1.0 - abs(mod(hp, 2.0) - 1.0));
    vec3 rgb;
    if (hp < 1.0) rgb = vec3(c, x, 0.0);
    else if (hp < 2.0) rgb = vec3(x, c, 0.0);
    else if (hp < 3.0) rgb = vec3(0.0, c, x);
    else if (hp < 4.0) rgb = vec3(0.0, x, c);
    else if (hp < 5.0) rgb = vec3(x, 0.0, c);
    else rgb = vec3(c, 0.0, x);
    float m = l - 0.5 * c;
    return rgb + vec3(m);
  }

  void main() {
    vec2 p = vUv - 0.5;
    float len = length(p) * 2.0;
    float angle = atan(p.y, p.x);

    float blinkMask = smoothstep(0.0, 0.2, abs(p.y) - (uBlink * 0.5));
    if (blinkMask <= 0.0001) discard;

    float aspectMix = mix(1.0, 0.25, clamp(uPupilAspect, 0.0, 1.0));
    vec2 slitVec = vec2(p.x, p.y * aspectMix);
    float pupilRadius = clamp(uPupilRadius, 0.02, 0.98);
    float pupil = smoothstep(pupilRadius, pupilRadius - 0.05, length(slitVec));

    float baseNoise = fbm(vec2(angle * 1.2, len * uFiberNoiseScale) + uTime * 0.03);
    float fiber = pow(clamp(baseNoise * 1.35, 0.0, 1.0), mix(1.2, 2.2, clamp(uFiberContrast, 0.0, 2.0)));

    float irisGain = clamp(uIrisGain, 0.0, 2.5);
    float limb = smoothstep(0.65, 1.2, len);
    float limbusDark = clamp(uLimbus, 0.0, 1.5);
    float irisLightness = 0.42 + fiber * 0.38 * irisGain;
    irisLightness *= mix(1.0, 0.35, limb * limbusDark);
    vec3 irisColor = hsl2rgb(fract(uHue), clamp(uSat, 0.0, 1.0), clamp(irisLightness, 0.0, 1.0));

    vec3 pupilColor = vec3(0.03);
    vec3 finalColor = mix(irisColor, pupilColor, pupil);

    float glint = exp(-pow(distance(p * 1.9, uGlintPos), 2.0) / max(1e-3, uGlintSize * 0.6));
    finalColor += vec3(glint * uGlintIntensity);

    float alpha = smoothstep(1.4, 1.0, len);
    alpha *= blinkMask;
    alpha *= uAlpha;

    gl_FragColor = vec4(finalColor, clamp(alpha, 0.0, 1.0));
  }
`;

const corneaVertexShader = `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vNormal = normalMatrix * normal;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vView = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const corneaFragmentShader = `
  precision highp float;

  varying vec3 vNormal;
  varying vec3 vView;

  uniform float uTime;
  uniform float uFresnel;
  uniform vec3 uTint;
  uniform float uOpacity;

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(vView);
    float fresnel = pow(1.0 - max(0.0, dot(N, V)), 3.0) * uFresnel;
    vec3 base = mix(uTint, vec3(1.0), 0.35);
    float alpha = clamp(uOpacity * fresnel, 0.0, 1.0);
    gl_FragColor = vec4(base * fresnel, alpha);
  }
`;

export function createEyeLayer() {
  const geometry = new THREE.PlaneGeometry(1, 1, 1, 1);
  const uniforms = {
    uTime: { value: 0 },
    uPupilRadius: { value: 0.25 },
    uPupilAspect: { value: 0 },
    uBlink: { value: 0 },
    uHue: { value: 0.6 },
    uSat: { value: 0.6 },
    uIrisGain: { value: 1.0 },
    uFiberContrast: { value: 1.0 },
    uFiberNoiseScale: { value: 3.0 },
    uLimbus: { value: 0.6 },
    uGlintPos: { value: new THREE.Vector2(0.2, -0.1) },
    uGlintSize: { value: 0.04 },
    uGlintIntensity: { value: 1.0 },
    uAlpha: { value: 1.0 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: eyeVertexShader,
    fragmentShader: eyeFragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.NormalBlending,
  });
  material.extensions = { derivatives: false };
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 6;
  mesh.frustumCulled = false;
  mesh.userData.uniforms = uniforms;
  mesh.visible = true;
  return mesh;
}

export function createCornea(radius = 1.0) {
  const geometry = new THREE.SphereGeometry(radius, 48, 32);
  geometry.scale(1, 1, 0.95);
  const uniforms = {
    uTime: { value: 0 },
    uFresnel: { value: 1.2 },
    uTint: { value: new THREE.Color(0xffffff) },
    uOpacity: { value: 0.6 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: corneaVertexShader,
    fragmentShader: corneaFragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 7;
  mesh.frustumCulled = false;
  mesh.userData.uniforms = uniforms;
  return mesh;
}

export function updateEyeUniforms(mesh, values = {}) {
  if (!mesh?.material || mesh.material.type !== 'ShaderMaterial') return;
  const uniforms = mesh.userData?.uniforms || mesh.material.uniforms;
  if (!uniforms) return;
  try {
    if (typeof values.time === 'number') uniforms.uTime.value = values.time;
    if (typeof values.pupilRadius === 'number') uniforms.uPupilRadius.value = values.pupilRadius;
    if (typeof values.pupilAspect === 'number') uniforms.uPupilAspect.value = values.pupilAspect;
    if (typeof values.blink === 'number') uniforms.uBlink.value = values.blink;
    if (typeof values.hue === 'number') uniforms.uHue.value = values.hue;
    if (typeof values.saturation === 'number') uniforms.uSat.value = values.saturation;
    if (typeof values.irisGain === 'number') uniforms.uIrisGain.value = values.irisGain;
    if (typeof values.fiberContrast === 'number') uniforms.uFiberContrast.value = values.fiberContrast;
    if (typeof values.fiberNoiseScale === 'number') uniforms.uFiberNoiseScale.value = values.fiberNoiseScale;
    if (typeof values.limbus === 'number') uniforms.uLimbus.value = values.limbus;
    if (values.glintPos instanceof THREE.Vector2) uniforms.uGlintPos.value.copy(values.glintPos);
    if (typeof values.glintSize === 'number') uniforms.uGlintSize.value = values.glintSize;
    if (typeof values.glintIntensity === 'number') uniforms.uGlintIntensity.value = values.glintIntensity;
    if (typeof values.alpha === 'number') uniforms.uAlpha.value = values.alpha;
  } catch (e) {
    mesh.visible = false;
    console.error('Eye shader uniform update failed; hiding eye mesh.', e);
  }
}
