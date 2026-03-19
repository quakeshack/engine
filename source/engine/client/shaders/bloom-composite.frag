#version 300 es
precision highp float;
precision highp sampler2D;

out vec4 fragColor;

uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform float uStrength;

in vec2 vTexCoord;

void main(void) {
  vec4 scene = texture(tScene, vTexCoord);
  vec3 bloom = texture(tBloom, vTexCoord).rgb;

  fragColor = vec4(scene.rgb + bloom * uStrength, scene.a);
}
