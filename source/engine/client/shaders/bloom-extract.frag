#version 300 es
precision highp float;
precision highp sampler2D;

out vec4 fragColor;

uniform sampler2D tTexture;
uniform vec2 uTexelOffset;

in vec2 vTexCoord;

void main(void) {
  // Wide 13-tap box downsample (as used in Call of Duty: Advanced Warfare's
  // "Next Generation Post Processing" bloom) instead of a single point/bilinear
  // tap. A single tap only samples one spot per output texel, so small bright
  // highlights (specular glints, distant lights) can alias in and out of the
  // downsampled buffer as the camera moves, making the bloom shimmer/flicker.
  // Averaging a full neighborhood keeps the downsample temporally stable.
  vec3 a = texture(tTexture, vTexCoord + uTexelOffset * vec2(-1.0, -1.0)).rgb;
  vec3 b = texture(tTexture, vTexCoord + uTexelOffset * vec2(0.0, -1.0)).rgb;
  vec3 c = texture(tTexture, vTexCoord + uTexelOffset * vec2(1.0, -1.0)).rgb;
  vec3 d = texture(tTexture, vTexCoord + uTexelOffset * vec2(-0.5, -0.5)).rgb;
  vec3 e = texture(tTexture, vTexCoord + uTexelOffset * vec2(0.5, -0.5)).rgb;
  vec3 f = texture(tTexture, vTexCoord + uTexelOffset * vec2(-1.0, 0.0)).rgb;
  vec3 g = texture(tTexture, vTexCoord).rgb;
  vec3 h = texture(tTexture, vTexCoord + uTexelOffset * vec2(1.0, 0.0)).rgb;
  vec3 i = texture(tTexture, vTexCoord + uTexelOffset * vec2(-0.5, 0.5)).rgb;
  vec3 j = texture(tTexture, vTexCoord + uTexelOffset * vec2(0.5, 0.5)).rgb;
  vec3 k = texture(tTexture, vTexCoord + uTexelOffset * vec2(-1.0, 1.0)).rgb;
  vec3 l = texture(tTexture, vTexCoord + uTexelOffset * vec2(0.0, 1.0)).rgb;
  vec3 m = texture(tTexture, vTexCoord + uTexelOffset * vec2(1.0, 1.0)).rgb;

  vec3 color = (d + e + i + j) * 0.125;
  color += (a + b + g + f) * 0.03125;
  color += (b + c + h + g) * 0.03125;
  color += (f + g + l + k) * 0.03125;
  color += (g + h + m + l) * 0.03125;

  fragColor = vec4(color, 1.0);
}
