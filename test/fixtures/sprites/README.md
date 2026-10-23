# Sprite image fixtures

Tiny real files (8x4 pixels, three frames of 50, 100 and 200 ms unless the name says otherwise) for the header
parsers and the image sprite loader. They were written with Pillow 12 (`Image.save(..., save_all=True)`),
except `interlaced.gif` (ImageMagick `convert -size 5x20 gradient:red-blue -interlace GIF`) and `progressive.gif` (Pillow, from the former). Frame counts and
timings were cross-checked with Pillow's reader and `ffprobe`.

| File | What it covers |
|---|---|
| `anim.gif` | NETSCAPE loop count 0 (forever) |
| `anim-once.gif` | no NETSCAPE block: plays once |
| `anim-loop3.gif` | loop count 3: plays four times |
| `anim-zero-delay.gif` | delays of 0, 10 and 20 ms |
| `interlaced.gif` | one interlaced image, 5x20 |
| `progressive.gif` | the same image not interlaced (Pillow `save(..., interlace=False)`), what `interlaced.gif` has to decode to |
| `static.png` | a plain PNG |
| `anim.apng` | the default image is the first frame (`fcTL` before `IDAT`) |
| `anim-hidden-default.apng` | the default image is a fallback, two frames, two plays |
| `anim.webp`, `anim-loop2.webp` | animated, loop count 0 and 2 |
| `static-lossless.webp` | simple file, `VP8L` |
| `static-lossy.webp` | simple file, `VP8 ` |
| `static-lossy-alpha.webp` | extended file (`VP8X`, `ALPH`, `VP8 `) |
