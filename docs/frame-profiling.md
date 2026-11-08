# Frame Profiling

Where a frame of the browser client spends its time, measured in the running game: `r_speeds` shows it on the screen,
`r_profile` prints it to the console, `r_bench` compares settings at the spot the player stands. The code is
`client/FrameProfiler.ts` (the sections and their times), `client/FrameBenchmark.ts` (`r_bench`) and
`client/BenchReport.ts` (its table).

For a comparison of two builds at fixed views, outside the game, use `scripts/renderer-capture/gpu-bench.mjs`
(`browser-verification.md`, section 9).

## `r_speeds`

`r_speeds 1` shows the frame rate, the draw counters of the frame (draw calls, triangles, texture binds, entities,
transparent items, scene copies, point shadows) and a table of the sections of the frame:

```
section                    cpu ms  worst gpu ms calls
draw                         0.32   0.61   0.75
  scene                      0.07   0.11   0.01
    world                    1.18   1.90   4.17
    transparent              0.42   0.70   0.20
      world surfaces         0.05   0.09   0.31  2.0
...
host                         0.01   0.02   0.00
  prediction                 1.63   2.40   0.00
  sound                      0.01   0.03   0.00
total cpu 5.73 ms, gpu 10.42 ms; 13.30 ms between frames (worst 27.1), 1.0 host frames each
most cpu: prediction 1.63 ms, most gpu: world 4.17 ms
```

- **Every number is the section's own time**, the sections nested in it left out, so all rows add up to the frame.
  A section that only groups others shows almost nothing itself.
- **cpu ms** is main-thread time per drawn frame, averaged over half a second. GL calls only queue commands, so a
  section that draws a lot can be cheap here.
- **worst** is the CPU time of the section in its slowest frame of that half second. A section with a small average
  and a large worst is a hitch, not a steady cost. When the worst time between frames is large and no section's worst
  explains it, the time went outside the engine's code (garbage collection, the browser, the compositor).
- **gpu ms** comes from `EXT_disjoint_timer_query_webgl2`. Chrome on the desktop has it, Firefox usually does not; the
  column then shows `-` and the total says so. Results arrive a few frames late and are counted in the window they
  arrive in.
- **calls** is how often the section ran per drawn frame, left empty for once.
- **host** is the host frame (network, client, local server, prediction, sound). It runs before the browser asks for
  the drawing and is measured on the CPU only, per drawn frame: two host frames between two drawn frames count twice.

`r_speeds 2` also calls `gl.finish()` at every section border while drawing, so the CPU column includes waiting for the
GPU. It is the fallback without timer queries; it slows the frame down and leaves the GPU idle between sections, so
compare the rows with each other, not with the frame rate of `r_speeds 1`.

`r_profile` prints the table of the last half second to the console, to copy it out.

## `r_bench`

```
r_bench [frames] [rounds] [cvar ...]
r_bench stop
```

Measures the settings as they are, then with every named cvar set to 0, one at a time, then all of them at 0, and
prints one table. Without cvars it takes `gl_msaa`, `r_shadows`, `r_shadow_point`, `r_refraction` and `r_bloom`. A cvar
that is 0 already is left out, a name that is no cvar stops it before it starts.

- **Stand still while it runs.** The numbers depend on what is in view.
- Every variant first waits 30 frames (a changed `gl_msaa` builds new targets, GPU times arrive late), then measures
  `frames` drawn frames (default 120).
- The variants are measured `rounds` times (default 2), one after the other in each round, so a drift (a GPU that warms
  up and clocks down) hits all of them alike. The table shows the mean of the rounds; **spread** is how far the GPU
  time of the rounds lay apart, and a **dgpu** (GPU time less the first row) below it is noise.
- The section columns (`scene`, `world`, `transp`, `sky`, `shadow`, `post`) include what is nested in them.
- Below the table, every variant lists the three sections whose own GPU time changed most against the first row.
- `r_speeds` is on while it runs. Every cvar is put back at the end, by `r_bench stop`, and when the game ends during
  the run.

## Adding a section

```ts
FrameProfiler.begin('world');
brushRenderer.render(worldEntity.model, worldEntity, 0);
FrameProfiler.end();
```

- A section is named by its string; the same name inside the same parent adds to the same row. Several call sites can
  open the same name, and a section can open different ones (`R.DrawEntitiesOnList` opens one per model renderer,
  `ModelRenderer.profileName`).
- `begin` and `end` pair up within one task. **Never across an `await`**: the browser can draw a frame in between,
  which resets the open sections (`ClientHost.RunFrame` opens `host` after `Host.BeginFrame`, not around it).
- While `r_speeds` is 0 a section costs a check of a flag. While it is on, each one costs two `performance.now()` calls
  and, while drawing, a timer query; a section per item in a loop of hundreds distorts what it measures. Group by kind
  instead, as `TransparentPass` does.
- Timer queries cannot nest: opening a section ends the query of the one around it and closing it starts a new one, so
  every section's GPU time is its own. Nothing else may run a `TIME_ELAPSED` query while `r_speeds` is on, which is why
  `gpu-bench.mjs` needs it off.
