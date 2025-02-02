// eslint-disable-next-line no-global-assign
self = Object.freeze({}); // CR: self is poison

import { ServerGameAPI } from './GameAPI.mjs';

const ClientGameAPI = null;

const identification = {
  name: 'Quake',
  author: 'chrisnew',
  version: [1, 0, 0],
};

export {
  identification,
  ServerGameAPI,
  ClientGameAPI,
};
