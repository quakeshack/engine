#version 300 es
precision highp float;
precision highp sampler2D;

out vec4 fragColor;

uniform sampler2D tTexture;
uniform float uCoverageThreshold;

const vec3 LUMINANCE = vec3(0.2126, 0.7152, 0.0722);
const int SAMPLE_COLUMNS = 8;
const int SAMPLE_ROWS = 6;
const float SAMPLE_COUNT = 48.0;

void main(void) {
  float averageLuminance = 0.0;
  float coverage = 0.0;

  for (int row = 0; row < SAMPLE_ROWS; ++row) {
    for (int column = 0; column < SAMPLE_COLUMNS; ++column) {
      vec2 sampleCoord = vec2(
        (float(column) + 0.5) / float(SAMPLE_COLUMNS),
        (float(row) + 0.5) / float(SAMPLE_ROWS)
      );
      float luminance = dot(texture(tTexture, sampleCoord).rgb, LUMINANCE);

      averageLuminance += luminance;
      coverage += smoothstep(uCoverageThreshold * 0.5, uCoverageThreshold * 1.5, luminance);
    }
  }

  fragColor = vec4(
    clamp(averageLuminance / SAMPLE_COUNT, 0.0, 1.0),
    clamp(coverage / SAMPLE_COUNT, 0.0, 1.0),
    0.0,
    1.0
  );
}
