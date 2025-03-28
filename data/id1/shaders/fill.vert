uniform mat4 uOrtho;

attribute vec2 aPosition;
attribute vec4 aColor;

varying vec4 vColor;

void main(void) {
  gl_Position = uOrtho * vec4(aPosition, 0.0, 1.0);
  vColor = aColor;
}
