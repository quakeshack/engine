#version 300 es
precision highp float;
precision highp sampler2D;

out vec4 fragColor;

uniform sampler2D tTexture;
/** Axis direction: (1,0) = horizontal pass, (0,1) = vertical pass. */
uniform vec2 uDirection;
/** Spread of the Gaussian in pixels. */
uniform float uRadius;

in vec2 vTexCoord;

// 9-tap separable Gaussian kernel (sigma=1.5, half-width=4).
// Weights are symmetric: w[0] is center, w[1..4] are offsets 1..4.
const float W0 = 0.2670;
const float W1 = 0.2135;
const float W2 = 0.1097;
const float W3 = 0.0360;
const float W4 = 0.0076;

void main(void) {
  vec2 step = uDirection / vec2(textureSize(tTexture, 0)) * max(uRadius, 0.0);

  vec4 result =
    texture(tTexture, vTexCoord)           * W0 +
    texture(tTexture, vTexCoord + step)    * W1 +
    texture(tTexture, vTexCoord - step)    * W1 +
    texture(tTexture, vTexCoord + 2.0*step) * W2 +
    texture(tTexture, vTexCoord - 2.0*step) * W2 +
    texture(tTexture, vTexCoord + 3.0*step) * W3 +
    texture(tTexture, vTexCoord - 3.0*step) * W3 +
    texture(tTexture, vTexCoord + 4.0*step) * W4 +
    texture(tTexture, vTexCoord - 4.0*step) * W4;

  fragColor = result;
}
