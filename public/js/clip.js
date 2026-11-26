import * as THREE from 'three';

// "Mixed" terrain: our own LiDAR ground + road near the rider, Google Photorealistic 3D Tiles further away.
// Google's photogrammetry is made from aircraft: great for mountains and valleys, but at road level
// hedges and trees turn into blobs that close over narrow lanes. Both materials read the same uniforms
// and discard fragments with a dithered cross-fade between r0 and r1 (metres from the rider).
export const CLIP = {
  on: { value: 0 },
  center: { value: new THREE.Vector2() },
  r0: { value: 140 },
  r1: { value: 260 },
};

/** keepOuter = true: material visible beyond the radius (Google); false: visible inside (own terrain). */
export function addClip(m, keepOuter) {
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = (sh, r) => {
    if (prev) prev.call(m, sh, r);
    sh.uniforms.clipOn = CLIP.on;
    sh.uniforms.clipC = CLIP.center;
    sh.uniforms.clipR0 = CLIP.r0;
    sh.uniforms.clipR1 = CLIP.r1;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vClipW;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 clipWP = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          clipWP = instanceMatrix * clipWP;
        #endif
        vClipW = (modelMatrix * clipWP).xz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vClipW;\nuniform float clipOn, clipR0, clipR1;\nuniform vec2 clipC;')
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (clipOn > 0.5) {
          float clipT = clamp((distance(vClipW, clipC) - clipR0) / (clipR1 - clipR0), 0.0, 1.0);
          float clipH = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);
          if (${keepOuter ? 'clipT < clipH' : 'clipT > clipH'}) discard;
        }`);
  };
  m.customProgramCacheKey = () => (prevKey ? prevKey.call(m) : '') + (prev ? prev.toString() : '') + '|clip' + (keepOuter ? 'O' : 'I');
  m.needsUpdate = true;
  return m;
}
