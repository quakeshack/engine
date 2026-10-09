float hash2D(vec2 p) {
  // dithering function to fade out shadow casters at a distance
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}
