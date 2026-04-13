#version 300 es
precision highp float;
precision highp sampler2D;

out vec4 fragColor;

uniform sampler2D tTexture;
uniform float uTime;
uniform float uSaturation;
uniform float uContrast;
uniform float uExposure;
uniform vec3 uTintColor;
uniform float uTintStrength;
uniform float uPulseStrength;
uniform float uPulsePeriod;

in vec2 vTexCoord;

vec3 applySaturation(vec3 color, float saturation) {
  float luminance = dot(color, vec3(0.299, 0.587, 0.114));
  return mix(vec3(luminance), color, saturation);
}

void main(void) {
  vec4 texel = texture(tTexture, vTexCoord);
  vec3 color = texel.rgb;

  float period = max(uPulsePeriod, 0.001);
  float pulse = 0.5 + 0.5 * sin(uTime * (6.283185 / period));
  float effectiveSaturation = uSaturation + uPulseStrength * pulse;
  color = applySaturation(color, clamp(effectiveSaturation, 0.0, 3.0));

  color = (color - 0.5) * max(uContrast, 0.0) + 0.5;
  color += vec3(uExposure);

  color = mix(color, color * uTintColor, clamp(uTintStrength, 0.0, 1.0));

  fragColor = vec4(clamp(color, 0.0, 1.0), texel.a);
}
