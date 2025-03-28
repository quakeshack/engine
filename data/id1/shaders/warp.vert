uniform mat4 uOrtho;

attribute vec2 aPosition;
attribute vec2 aTexCoord;

varying vec2 vTexCoord;

void main(void) {
  gl_Position = uOrtho * vec4(aPosition, 0.0, 1.0);

  vTexCoord = aTexCoord;
}
