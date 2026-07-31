# Console

Everything related to this is in:

* `Console.ts`
* `Cmd.ts`
* `Cvar.ts`
* `Key.ts`

## Console Frontend

The console is a Quake 3 Arena / Doom 3-style drop-down drawer, not the classic Quake 1 "one of
four destinations" model: it's an independent overlay (`Con.isOpen`) that can pop open on top of
*either* live gameplay or the menu, renders above everything else on screen, and takes exclusive
keyboard focus while open — but doesn't pause the game behind it (world simulation and rendering
both keep running; only client-side input routing changes).

* `Con.isOpen` is the single source of truth for whether the drawer is toggled open —
  independent of `Key.destination`, which continues to mean "what's active *underneath* the
  console" (`game`, `menu`, or `message`; the old `console` destination value is gone).
* `Con.ToggleConsole_f` (bound to `` ` ``/`~` by default via `bind`, like any other command) just
  flips `Con.isOpen` and releases pointer lock on open, so mouselook doesn't keep spinning the
  camera while you type.
* `Key.Event()` gives an open console dispatch priority over whichever destination is
  underneath: Escape closes it first (before touching the menu/game/message logic), and any key
  it doesn't consume as text (e.g. the toggle key itself) still executes its bound command, via
  the same `Key.consolekeys` typable-vs-bound-key split used before.
* `Con.DrawNotify` draws the small recent-lines/chat-composition overlay shown when the console
  itself is closed (`Key.destination === game || message`).
* `Con.DrawInput` draws the blinking input-line prompt, gated on `Con.isOpen`.
* `Con.DrawConsole` draws the whole panel (background, scrollback, input line) for a given slide
  height; `SCR.UpdateScreen()` calls it either *before* the menu (the passive backdrop shown
  whenever there's no valid connected game — `Con.forcedup`) or *after* the menu (the
  actively-toggled drawer), so the interactive console always ends up on top.
* Actual key handling (typing, history, tab-complete, scrollback) happens in `Key.Console`,
  exactly as before — only the routing around it changed.

### Console Background Customization

By default the engine will render the color-indexed `gfx/conback.lmp` with the version burned into it.

However, you can provide a `gfx/conback.png` as a fallback.

## Console Variables

Use the `Cvar` class to register console variables.

```js
SV.maxvelocity = new Cvar('sv_maxvelocity', '2000');
```

It replaced the old interface:

```js
Host.framerate = Cvar.RegisterVariable('host_framerate', '0');
```

The new `Cvar` class gives you a bunch of new features such as flags to control whether it’s read-only, it should be written to the config or whether it’s important to server logic.

You can also provide a description that will be shown in the help for it:

```js
Host.dedicated = new Cvar('dedicated', dedicated ? '1' : '0', Cvar.FLAG.READONLY, 'Set to 1, if running in dedicated server mode.');
```

Values in `boolean` will be translated into `'1'` and `'0'`.

For all flags, check out `Cvar.FLAG`.

The old `string` and `value` properties remain for now.


## Console Commands

The command interface has changed significantly.

```js
Cmd.AddCommand('status', Host.Status_f);
Cmd.AddCommand('map', Host.Map_f);
```

**NOTE**: Make sure to always suffix the functions that are supposed to be console command handlers with `_f`.

We no longer support `Cmd.argv`, `Cmd.client` etc. In order to allow parallel servers and asynchroneous processing of commands, we provide context for console commands in `this`, it will be a `ConsoleCommand` instance.

The following should give you the idea on the console command structure:

```js
Host.Map_f = function(mapname, ...spawnparms) {
  if (mapname === undefined) {
    Con.Print('Usage: map <map>\n');
    return;
  }

  if (this.client) {
    return;
  }

  /* … */
};
```

You can see that the command line is parsed and tokens are mapped to the function’s arguments accordingly.

In case you need the full command line, you can use `this.args`.
The name is stored in `this.command`, the arguments are kept in `this.argv` for convenient’s sake. If the command arrived through a forward, the issuer is available in `this.client`, an instance of `ServerClient`.

In server commands that are invoked by the client on the frontend, use `this.forward()` to forward the command to the server.

```js
Host.Fly_f = function() {
  if (this.forward()) {
    return;
  }

  /* … */
};
```

A call to `this.forward()` will return true, when the command has been forwarded.

It’s also possible to register a console command handler class based on `ConsoleCommand`. You then have to override `run()`.

For example:


```js
class EchoConsoleCommand extends ConsoleCommand {
  run() {
    Con.Print(`${this.args}\n`);
  }
};

/* … */

Cmd.AddCommand('echo', EchoConsoleCommand);
```

This is useful when a set of commands share a common prolog or logic.
