#version 300 es
precision highp float;
precision highp sampler2D;

out vec4 fragColor;

uniform sampler2D tMetric;
uniform sampler2D tPrevious;
uniform float uFrameTime;
uniform float uSettleRate;
uniform float uRecoverRate;
uniform float uFirstFrame;
uniform float uMinMultiplier;
uniform float uBrightnessStart;
uniform float uBrightnessEnd;
uniform float uCoverageStart;
uniform float uCoverageEnd;

float saturate(float value) {
  return clamp(value, 0.0, 1.0);
}

float smoothUnit(float value) {
  float clamped = saturate(value);

  return clamped * clamped * (3.0 - 2.0 * clamped);
}

float remapMetric(float value, float start, float end) {
  return saturate((value - start) / (end - start)) * step(start + 0.0001, end);
}

float resolveTarget(float averageLuminance, float coverage) {
  float brightnessPressure = smoothUnit(remapMetric(averageLuminance, uBrightnessStart, uBrightnessEnd));
  float coveragePressure = smoothUnit(remapMetric(coverage, uCoverageStart, uCoverageEnd));

  return 1.0 - (1.0 - uMinMultiplier) * (brightnessPressure * coveragePressure);
}

float advanceAdaptation(float current, float target) {
  float rate = target < current ? uSettleRate : uRecoverRate;
  float blend = 1.0 - exp(-max(uFrameTime, 0.0) * rate);

  return mix(current, target, blend);
}

void main(void) {
  vec2 sampleCoord = vec2(0.5, 0.5);
  vec2 metric = texture(tMetric, sampleCoord).rg;
  float current = texture(tPrevious, sampleCoord).r;
  float target = resolveTarget(metric.r, metric.g);
  float adapted = uFirstFrame > 0.5 ? 1.0 : advanceAdaptation(current, target);

  fragColor = vec4(vec3(saturate(adapted)), 1.0);
}
