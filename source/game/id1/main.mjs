// eslint-disable-next-line no-global-assign
try { self = Object.freeze({}); } catch (e) { console.debug(e); } // CR: self is poison

import { ServerGameAPI } from './GameAPI.mjs';
import { ClientGameAPI } from './client/ClientAPI.mjs';

const identification = {
  name: 'Quake',
  author: 'chrisnew',
  version: [1, 0, 0],
  capabilities: [],
};

export {
  identification,
  ServerGameAPI,
  ClientGameAPI,
};
