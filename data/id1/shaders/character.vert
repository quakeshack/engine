uniform vec2 uCharacter;
uniform vec2 uDest;
uniform mat4 uOrtho;

attribute vec2 aPosition;

varying vec2 vTexCoord;

void main(void) {
  gl_Position = uOrtho * vec4(aPosition * 8.0 + uDest, 0.0, 1.0);
  vTexCoord = (aPosition + uCharacter) * 0.0625;
}
