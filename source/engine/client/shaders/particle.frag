#version 300 es
precision highp float;

layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragEmissive;

in vec2 vCoord;
flat in vec3 vColor;
#include "fog-fragment.glsl"

void main(void) {
  // apply fog (particles keep alpha)
  fragColor = vec4(mix(uFogColor, vColor, vFog), 1.0 - smoothstep(0.75, 1.0, length(vCoord)));
  fragEmissive = vec4(0.0);
}
