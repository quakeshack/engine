#version 300 es
precision highp float;
precision highp sampler2D;

out vec4 fragColor;

uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tAdaptation;
uniform float uStrength;

in vec2 vTexCoord;

void main(void) {
  vec4 scene = texture(tScene, vTexCoord);
  vec3 bloom = texture(tBloom, vTexCoord).rgb;
  float adaptation = texture(tAdaptation, vec2(0.5, 0.5)).r;

  fragColor = vec4(scene.rgb + bloom * (uStrength * adaptation), scene.a);
}
