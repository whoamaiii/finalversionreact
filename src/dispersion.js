import * as THREE from 'three';
import { RenderPass } from 'postprocessing';

// Builds a full-screen overlay scene using the provided dispersion fragment shader.
// Exposes a RenderPass for the existing composer and an update() method to feed uniforms.
export function createDispersionLayer() {
  const overlayScene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);

  const vertexShader = `
    void main() {
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

  // Based on user's dispersion shader; extended with tint, brightness/contrast, warp, and twist
  const fragmentShader = `
    precision highp float;
    uniform vec2 r; // resolution
    uniform float t; // time
    uniform float zoom;
    uniform vec2 offset;
    uniform float uOpacity; // overlay opacity
    uniform float uWarp; // intensity boost / pseudo-warp
    uniform vec3 uTint; // color tint
    uniform float uTintMix; // mix amount 0..1
    uniform float uBrightness; // multiply
    uniform float uContrast; // (x-0.5)*c+0.5
    uniform float uTwist; // radians of screen-space swirl
    uniform float uTwistFalloff; // 0=center only, 1=linear, >1 pushes to edges
    uniform float uTravel; // forward travel along z

    // Avoid colliding with built-in tanh by using a custom helper
    vec4 myTanh(vec4 x){ vec4 e = exp(2.0 * x); return (e - 1.0) / (e + 1.0); }

    void main(){
      vec2 FC = gl_FragCoord.xy;
      vec4 o = vec4(0.0);
      vec3 p, a; float z, d, s, i;

      vec3 rayOrigin = vec3(offset, zoom + uTravel);
      vec3 rayDir = normalize(vec3(FC * 2.0 - r, 1.0 - r.y));

      // Screen-space twist around center, with radial falloff
      float minAxis = min(r.x, r.y);
      vec2 fromCenter = (FC - 0.5 * r) / max(1.0, 0.5 * minAxis);
      float rad = clamp(length(fromCenter), 0.0, 1.0);
      float ang = uTwist * pow(1.0 - rad, max(0.0, uTwistFalloff));
      float cs = cos(ang); float sn = sin(ang);
      mat2 rot = mat2(cs, -sn, sn, cs);
      rayDir.xy = rot * rayDir.xy;

      float warp = 1.0 + max(0.0, uWarp);
      i = 0.0; z = 0.0; p = rayOrigin + z * rayDir; a = p;
      d = 2.0; a -= sin(a * d + t + i).yzx / d * warp; d = 3.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 4.0; a -= sin(a * d + t + i).yzx / d * warp; d = 5.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 6.0; a -= sin(a * d + t + i).yzx / d * warp;
      p = abs(p); s = a.z + a.y - t;
      z += d = abs(2.0 - max(max(p.x, p.y), p.y)) + abs(cos(s)) / 7.0;
      o += (cos(s - z + vec4(0, 1, 8, 0)) + 1.0) / d;

      i = 1.0; p = rayOrigin + z * rayDir; a = p;
      d = 2.0; a -= sin(a * d + t + i).yzx / d * warp; d = 3.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 4.0; a -= sin(a * d + t + i).yzx / d * warp; d = 5.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 6.0; a -= sin(a * d + t + i).yzx / d * warp;
      p = abs(p); s = a.z + a.y - t;
      z += d = abs(2.0 - max(max(p.x, p.y), p.y)) + abs(cos(s)) / 7.0;
      o += (cos(s - z + vec4(0, 1, 8, 0)) + 1.0) / d;

      i = 2.0; p = rayOrigin + z * rayDir; a = p;
      d = 2.0; a -= sin(a * d + t + i).yzx / d * warp; d = 3.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 4.0; a -= sin(a * d + t + i).yzx / d * warp; d = 5.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 6.0; a -= sin(a * d + t + i).yzx / d * warp;
      p = abs(p); s = a.z + a.y - t;
      z += d = abs(2.0 - max(max(p.x, p.y), p.y)) + abs(cos(s)) / 7.0;
      o += (cos(s - z + vec4(0, 1, 8, 0)) + 1.0) / d;

      i = 3.0; p = rayOrigin + z * rayDir; a = p;
      d = 2.0; a -= sin(a * d + t + i).yzx / d * warp; d = 3.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 4.0; a -= sin(a * d + t + i).yzx / d * warp; d = 5.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 6.0; a -= sin(a * d + t + i).yzx / d * warp;
      p = abs(p); s = a.z + a.y - t;
      z += d = abs(2.0 - max(max(p.x, p.y), p.y)) + abs(cos(s)) / 7.0;
      o += (cos(s - z + vec4(0, 1, 8, 0)) + 1.0) / d;

      i = 4.0; p = rayOrigin + z * rayDir; a = p;
      d = 2.0; a -= sin(a * d + t + i).yzx / d * warp; d = 3.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 4.0; a -= sin(a * d + t + i).yzx / d * warp; d = 5.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 6.0; a -= sin(a * d + t + i).yzx / d * warp;
      p = abs(p); s = a.z + a.y - t;
      z += d = abs(2.0 - max(max(p.x, p.y), p.y)) + abs(cos(s)) / 7.0;
      o += (cos(s - z + vec4(0, 1, 8, 0)) + 1.0) / d;

      i = 5.0; p = rayOrigin + z * rayDir; a = p;
      d = 2.0; a -= sin(a * d + t + i).yzx / d * warp; d = 3.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 4.0; a -= sin(a * d + t + i).yzx / d * warp; d = 5.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 6.0; a -= sin(a * d + t + i).yzx / d * warp;
      p = abs(p); s = a.z + a.y - t;
      z += d = abs(2.0 - max(max(p.x, p.y), p.y)) + abs(cos(s)) / 7.0;
      o += (cos(s - z + vec4(0, 1, 8, 0)) + 1.0) / d;

      i = 6.0; p = rayOrigin + z * rayDir; a = p;
      d = 2.0; a -= sin(a * d + t + i).yzx / d * warp; d = 3.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 4.0; a -= sin(a * d + t + i).yzx / d * warp; d = 5.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 6.0; a -= sin(a * d + t + i).yzx / d * warp;
      p = abs(p); s = a.z + a.y - t;
      z += d = abs(2.0 - max(max(p.x, p.y), p.y)) + abs(cos(s)) / 7.0;
      o += (cos(s - z + vec4(0, 1, 8, 0)) + 1.0) / d;

      i = 7.0; p = rayOrigin + z * rayDir; a = p;
      d = 2.0; a -= sin(a * d + t + i).yzx / d * warp; d = 3.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 4.0; a -= sin(a * d + t + i).yzx / d * warp; d = 5.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 6.0; a -= sin(a * d + t + i).yzx / d * warp;
      p = abs(p); s = a.z + a.y - t;
      z += d = abs(2.0 - max(max(p.x, p.y), p.y)) + abs(cos(s)) / 7.0;
      o += (cos(s - z + vec4(0, 1, 8, 0)) + 1.0) / d;

      i = 8.0; p = rayOrigin + z * rayDir; a = p;
      d = 2.0; a -= sin(a * d + t + i).yzx / d * warp; d = 3.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 4.0; a -= sin(a * d + t + i).yzx / d * warp; d = 5.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 6.0; a -= sin(a * d + t + i).yzx / d * warp;
      p = abs(p); s = a.z + a.y - t;
      z += d = abs(2.0 - max(max(p.x, p.y), p.y)) + abs(cos(s)) / 7.0;
      o += (cos(s - z + vec4(0, 1, 8, 0)) + 1.0) / d;

      i = 9.0; p = rayOrigin + z * rayDir; a = p;
      d = 2.0; a -= sin(a * d + t + i).yzx / d * warp; d = 3.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 4.0; a -= sin(a * d + t + i).yzx / d * warp; d = 5.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 6.0; a -= sin(a * d + t + i).yzx / d * warp;
      p = abs(p); s = a.z + a.y - t;
      z += d = abs(2.0 - max(max(p.x, p.y), p.y)) + abs(cos(s)) / 7.0;
      o += (cos(s - z + vec4(0, 1, 8, 0)) + 1.0) / d;

      i = 10.0; p = rayOrigin + z * rayDir; a = p;
      d = 2.0; a -= sin(a * d + t + i).yzx / d * warp; d = 3.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 4.0; a -= sin(a * d + t + i).yzx / d * warp; d = 5.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 6.0; a -= sin(a * d + t + i).yzx / d * warp;
      p = abs(p); s = a.z + a.y - t;
      z += d = abs(2.0 - max(max(p.x, p.y), p.y)) + abs(cos(s)) / 7.0;
      o += (cos(s - z + vec4(0, 1, 8, 0)) + 1.0) / d;

      i = 11.0; p = rayOrigin + z * rayDir; a = p;
      d = 2.0; a -= sin(a * d + t + i).yzx / d * warp; d = 3.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 4.0; a -= sin(a * d + t + i).yzx / d * warp; d = 5.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 6.0; a -= sin(a * d + t + i).yzx / d * warp;
      p = abs(p); s = a.z + a.y - t;
      z += d = abs(2.0 - max(max(p.x, p.y), p.y)) + abs(cos(s)) / 7.0;
      o += (cos(s - z + vec4(0, 1, 8, 0)) + 1.0) / d;

      i = 12.0; p = rayOrigin + z * rayDir; a = p;
      d = 2.0; a -= sin(a * d + t + i).yzx / d * warp; d = 3.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 4.0; a -= sin(a * d + t + i).yzx / d * warp; d = 5.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 6.0; a -= sin(a * d + t + i).yzx / d * warp;
      p = abs(p); s = a.z + a.y - t;
      z += d = abs(2.0 - max(max(p.x, p.y), p.y)) + abs(cos(s)) / 7.0;
      o += (cos(s - z + vec4(0, 1, 8, 0)) + 1.0) / d;

      i = 13.0; p = rayOrigin + z * rayDir; a = p;
      d = 2.0; a -= sin(a * d + t + i).yzx / d * warp; d = 3.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 4.0; a -= sin(a * d + t + i).yzx / d * warp; d = 5.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 6.0; a -= sin(a * d + t + i).yzx / d * warp;
      p = abs(p); s = a.z + a.y - t;
      z += d = abs(2.0 - max(max(p.x, p.y), p.y)) + abs(cos(s)) / 7.0;
      o += (cos(s - z + vec4(0, 1, 8, 0)) + 1.0) / d;

      i = 14.0; p = rayOrigin + z * rayDir; a = p;
      d = 2.0; a -= sin(a * d + t + i).yzx / d * warp; d = 3.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 4.0; a -= sin(a * d + t + i).yzx / d * warp; d = 5.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 6.0; a -= sin(a * d + t + i).yzx / d * warp;
      p = abs(p); s = a.z + a.y - t;
      z += d = abs(2.0 - max(max(p.x, p.y), p.y)) + abs(cos(s)) / 7.0;
      o += (cos(s - z + vec4(0, 1, 8, 0)) + 1.0) / d;

      i = 15.0; p = rayOrigin + z * rayDir; a = p;
      d = 2.0; a -= sin(a * d + t + i).yzx / d * warp; d = 3.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 4.0; a -= sin(a * d + t + i).yzx / d * warp; d = 5.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 6.0; a -= sin(a * d + t + i).yzx / d * warp;
      p = abs(p); s = a.z + a.y - t;
      z += d = abs(2.0 - max(max(p.x, p.y), p.y)) + abs(cos(s)) / 7.0;
      o += (cos(s - z + vec4(0, 1, 8, 0)) + 1.0) / d;

      i = 16.0; p = rayOrigin + z * rayDir; a = p;
      d = 2.0; a -= sin(a * d + t + i).yzx / d * warp; d = 3.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 4.0; a -= sin(a * d + t + i).yzx / d * warp; d = 5.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 6.0; a -= sin(a * d + t + i).yzx / d * warp;
      p = abs(p); s = a.z + a.y - t;
      z += d = abs(2.0 - max(max(p.x, p.y), p.y)) + abs(cos(s)) / 7.0;
      o += (cos(s - z + vec4(0, 1, 8, 0)) + 1.0) / d;

      i = 17.0; p = rayOrigin + z * rayDir; a = p;
      d = 2.0; a -= sin(a * d + t + i).yzx / d * warp; d = 3.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 4.0; a -= sin(a * d + t + i).yzx / d * warp; d = 5.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 6.0; a -= sin(a * d + t + i).yzx / d * warp;
      p = abs(p); s = a.z + a.y - t;
      z += d = abs(2.0 - max(max(p.x, p.y), p.y)) + abs(cos(s)) / 7.0;
      o += (cos(s - z + vec4(0, 1, 8, 0)) + 1.0) / d;

      i = 18.0; p = rayOrigin + z * rayDir; a = p;
      d = 2.0; a -= sin(a * d + t + i).yzx / d * warp; d = 3.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 4.0; a -= sin(a * d + t + i).yzx / d * warp; d = 5.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 6.0; a -= sin(a * d + t + i).yzx / d * warp;
      p = abs(p); s = a.z + a.y - t;
      z += d = abs(2.0 - max(max(p.x, p.y), p.y)) + abs(cos(s)) / 7.0;
      o += (cos(s - z + vec4(0, 1, 8, 0)) + 1.0) / d;

      i = 19.0; p = rayOrigin + z * rayDir; a = p;
      d = 2.0; a -= sin(a * d + t + i).yzx / d * warp; d = 3.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 4.0; a -= sin(a * d + t + i).yzx / d * warp; d = 5.0; a -= sin(a * d + t + i).yzx / d * warp;
      d = 6.0; a -= sin(a * d + t + i).yzx / d * warp;
      p = abs(p); s = a.z + a.y - t;
      z += d = abs(2.0 - max(max(p.x, p.y), p.y)) + abs(cos(s)) / 7.0;
      o += (cos(s - z + vec4(0, 1, 8, 0)) + 1.0) / d;

      o = myTanh(o / 200.0);
      vec3 col = o.rgb;
      col = (col - 0.5) * max(0.0, uContrast) + 0.5;
      col *= max(0.0, uBrightness);
      col = mix(col, uTint, clamp(uTintMix, 0.0, 1.0));
      col = clamp(col * (1.0 + max(0.0, uWarp) * 0.5), 0.0, 1.0);
      gl_FragColor = vec4(col, uOpacity);
    }
  `;

  const geometry = new THREE.PlaneGeometry(2, 2);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      r: { value: new THREE.Vector2(1, 1) },
      t: { value: 0 },
      zoom: { value: 0 },
      offset: { value: new THREE.Vector2(0, 0) },
      uOpacity: { value: 0.5 },
      uWarp: { value: 0.0 },
      uTint: { value: new THREE.Color(1, 1, 1) },
      uTintMix: { value: 0.0 },
      uBrightness: { value: 1.0 },
      uContrast: { value: 1.0 },
      uTwist: { value: 0.0 },
      uTwistFalloff: { value: 1.2 },
      uTravel: { value: 0.0 },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  overlayScene.add(mesh);

  const pass = new RenderPass(overlayScene, camera);
  pass.clear = false; // overlay
  pass.renderToScreen = true; // ensure final composited output goes to screen

  function setSize(width, height) {
    if (material?.uniforms?.r?.value) {
      material.uniforms.r.value.set(width, height);
    }
  }

  function update({ time, zoom = 0, offsetX = 0, offsetY = 0, opacity = 0.5, width, height, warp = 0, tint = null, tintMix = 0, brightness = 1, contrast = 1, twist = 0, twistFalloff = 1.2, travel = 0 }) {
    if (!material || !material.uniforms) return;
    material.uniforms.t.value = time || 0;
    material.uniforms.zoom.value = zoom;
    material.uniforms.offset.value.set(offsetX, offsetY);
    material.uniforms.uOpacity.value = THREE.MathUtils.clamp(opacity, 0.0, 1.0);
    material.uniforms.uWarp.value = warp;
    material.uniforms.uTintMix.value = THREE.MathUtils.clamp(tintMix, 0.0, 1.0);
    material.uniforms.uBrightness.value = Math.max(0, brightness);
    material.uniforms.uContrast.value = Math.max(0, contrast);
    material.uniforms.uTwist.value = twist;
    material.uniforms.uTwistFalloff.value = twistFalloff;
    material.uniforms.uTravel.value = travel;
    if (tint && material.uniforms.uTint?.value?.set) {
      material.uniforms.uTint.value.set(tint.r, tint.g, tint.b);
    }
    if (typeof width === 'number' && typeof height === 'number' && isFinite(width) && isFinite(height)) {
      material.uniforms.r.value.set(width, height);
    }
  }

  function setEnabled(enabled) {
    pass.enabled = !!enabled;
  }

  return { scene: overlayScene, camera, mesh, material, pass, setSize, update, setEnabled };
}


