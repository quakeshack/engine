# Console

Everything related to this is in:

* `Console.js`
* `Cmd.js`
* `Cvar.js`
* `Key.js`

## Console Frontend

* `Con.DrawNotify` is responsible for drawing the chat input box.
* `Con.DrawInput` draws the input box for the actual console.
* `Con.DrawConsole` is responsible for drawing everything.
* `Key.dest.value` decides what is receiving key strokes:
  * `Key.dest.console` is for the console
  * `Key.dest.message` is for chatting
  * However, actual handling of the key strokes is happening in `Key.Console`.

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
