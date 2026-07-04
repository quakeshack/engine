#version 300 es
precision highp float;
precision highp sampler2D;

out vec4 fragColor;

uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tAdaptation;
uniform float uStrength;
uniform vec2 uBloomTexelOffset;

in vec2 vTexCoord;

void main(void) {
  vec4 scene = texture(tScene, vTexCoord);

  // 3x3 tent upsample instead of a single bilinear tap. Reconstructing the
  // low-resolution bloom buffer with only one tap per screen pixel leaves the
  // low-res texel grid visible as faceted, blocky edges that crawl when the
  // camera moves. Blending a small neighborhood smooths that reconstruction.
  vec3 bloom = texture(tBloom, vTexCoord).rgb * 0.25;
  bloom += texture(tBloom, vTexCoord + uBloomTexelOffset * vec2(-1.0, 0.0)).rgb * 0.125;
  bloom += texture(tBloom, vTexCoord + uBloomTexelOffset * vec2(1.0, 0.0)).rgb * 0.125;
  bloom += texture(tBloom, vTexCoord + uBloomTexelOffset * vec2(0.0, -1.0)).rgb * 0.125;
  bloom += texture(tBloom, vTexCoord + uBloomTexelOffset * vec2(0.0, 1.0)).rgb * 0.125;
  bloom += texture(tBloom, vTexCoord + uBloomTexelOffset * vec2(-1.0, -1.0)).rgb * 0.0625;
  bloom += texture(tBloom, vTexCoord + uBloomTexelOffset * vec2(1.0, -1.0)).rgb * 0.0625;
  bloom += texture(tBloom, vTexCoord + uBloomTexelOffset * vec2(-1.0, 1.0)).rgb * 0.0625;
  bloom += texture(tBloom, vTexCoord + uBloomTexelOffset * vec2(1.0, 1.0)).rgb * 0.0625;

  float adaptation = texture(tAdaptation, vec2(0.5, 0.5)).r;

  fragColor = vec4(scene.rgb + bloom * (uStrength * adaptation), scene.a);
}
