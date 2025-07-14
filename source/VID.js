/* global VID, COM, GL, Sys */

// eslint-disable-next-line no-global-assign
VID = {};

// FIXME: make d_8to24table private, expose methods to do a 8-to-24
// TODO: rewrite existing code to use d_8to24table_u8 instead

// NOTE: stuff moved to W.mjs

VID.Init = async function() {
  const $progress = document.getElementById('progress');
  $progress.parentElement.removeChild($progress);

  document.getElementById('console').style.display = 'none';

  GL.Init();
  await VID.LoadPalette();
};

VID.Shutdown = function() {
  GL.Shutdown();

  document.getElementById('console').style.display = 'block';
};
