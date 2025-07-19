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
