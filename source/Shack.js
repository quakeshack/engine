/* global Shack, Cmd, Host, CL, M */

// eslint-disable-next-line no-global-assign
Shack = class Shack {
  static Init() {

    if (!Host.dedicated.value) {
      Shack.InitClientCommands();
    }
  }

  static InitClientCommands() {
    Cmd.AddCommand('shack_start', Shack.Start_f);
  }

  static Start_f() {
    if (CL.name.string.toLowerCase() === 'player') {
      M.Menu_MultiPlayer_f();
      return;
    }

    Cmd.text += 'connect self\n';
  }
};
