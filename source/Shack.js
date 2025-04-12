/* global Shack, Cmd, Host, CL, M */

Shack = {
  Init() {

    if (!Host.dedicated.value) {
      this.InitClientCommands();
    }
  },

  InitClientCommands() {
    Cmd.AddCommand('shack_start', this.Start_f);
  },

  Start_f() {
    if (CL.name.string.toLowerCase() === 'player') {
      M.Menu_MultiPlayer_f();
      return;
    }

    Cmd.text += 'connect self\n';
  }
};
