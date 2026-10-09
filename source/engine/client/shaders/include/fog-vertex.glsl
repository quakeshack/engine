// Distance fog, computed per vertex and interpolated to the fragment shader (see fog-fragment.glsl).
uniform vec4 uFogParams; // start, end, density, mode
out float vFog;

/**
 * Fog factor for a vertex: 1.0 means no fog, 0.0 means fully fogged. Evaluates all modes and selects one with
 * step() masks instead of branching. The mode is uFogParams.w: -1 none, 0 linear, 1 exp, 2 exp2.
 * @param dist World-space distance between the vertex and the view origin.
 */
float computeFog(float dist) {
  float fogLinear = clamp((uFogParams.y - dist) / max(0.0001, uFogParams.y - uFogParams.x), 0.0, 1.0);
  float fogExp = clamp(exp(-uFogParams.z * dist), 0.0, 1.0);
  float fogExp2 = clamp(exp(-uFogParams.z * uFogParams.z * dist * dist), 0.0, 1.0);

  float isNoFog = step(uFogParams.w, -0.5);
  float isLinear = step(uFogParams.w, 0.5) * (1.0 - isNoFog);
  float isExp = step(abs(uFogParams.w - 1.0), 0.5) * (1.0 - isNoFog - isLinear);

  return mix(mix(mix(fogExp2, fogExp, isExp), fogLinear, isLinear), 1.0, isNoFog);
}
