/* eslint-disable @typescript-eslint/no-var-requires */
const anynote = {
  remote: require('electron').remote,
  actions: require('./service').actions,
  storage: require('./service').actions.Storage
}

const myEvent = new Event('dbinited', { bubbles: true, cancelable: false })


;(function () {
  Object.defineProperty(global, 'anynote', {
    value: anynote,
    configurable: false,
    writable: false,
    enumerable: false
  })
  const storage = new anynote.Storage()
  


  Object.defineProperty(global, 'storage', {
    value: storage,
    configurable: false,
    writable: false,
    enumerable: false
  })
  storage.init().then(() => {
    setTimeout(() => {
      window.dispatchEvent(myEvent)
    }, 100)
  })
})()
 