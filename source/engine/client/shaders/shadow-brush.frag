#version 300 es
precision highp float;

uniform float uCasterFade;

float hash2D(vec2 p) {
  // dithering function to fade out shadow casters at a distance
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main(void) {
  if (hash2D(gl_FragCoord.xy) > uCasterFade) {
    discard;
  }

  // Depth is written automatically by the rasterizer.
}
