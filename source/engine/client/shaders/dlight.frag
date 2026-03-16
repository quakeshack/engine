#version 300 es
precision highp float;

out vec4 fragColor;

uniform float uGamma;

in float vAlpha;

void main(void) {
  fragColor = vec4(pow(1.0, uGamma), pow(0.5, uGamma), 0.0, vAlpha);
}
