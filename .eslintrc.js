module.exports = {
  'env': {
    'browser': true,
    'es6': true,
  },
  'extends': [
    'google',
  ],
  'globals': {
    'Atomics': 'readonly',
    'SharedArrayBuffer': 'readonly',
  },
  'parserOptions': {
    'ecmaVersion': 2018,
  },
  'rules': {
    'max-len': 'off',
    'new-cap': 'off',
    'no-mixed-spaces-and-tabs': 'off',
    'no-tabs': 'off',
    'camelcase': 'off',
  },
};
