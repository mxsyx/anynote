import React from 'react'
import ReactDOM from 'react-dom'
import Hello from 'components/Hello'

import './index.css'

const root = document.getElementById('root')

window.addEventListener('dbInited', () => {    
  import('./App').then(App => {
    ReactDOM.render(<App.default />, root)
  })
})

// Show welcome page.
ReactDOM.render(<Hello />, root)
