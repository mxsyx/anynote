/* eslint-disable @typescript-eslint/no-var-requires */
const anynote = {
  remote: require('electron').remote,
  actions: require('./service').actions
}

Object.defineProperty(global, 'anynote', {
  value: anynote,
  configurable: false,
  writable: false,
  enumerable: false
})
