#version 300 es
precision highp float;

out vec4 fragColor;

uniform float uGamma;

in float vAlpha;

void main(void) {
  fragColor = vec4(1.0, pow(0.5, uGamma), 0.0, vAlpha);
}
