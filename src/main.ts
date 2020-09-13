/* eslint-disable @typescript-eslint/no-var-requires */
const path = require('path')
const electron = require('electron')

import init from './initialize'

const { app, BrowserWindow, globalShortcut } = electron

class Desktop {
  private window

  constructor() {
    this.window = new BrowserWindow({
      width: 800,
      height: 600,
      webPreferences: {
        nodeIntegration: true
      }
    })
    init()
    this.develop()
  }

  /**
   * Debug for developers.
   */
  develop() {
    globalShortcut.register('Control+Shift+i', () => {
      this.window.webContents.openDevTools()
    })
  }

  run() {
    // Load index.html file.
    this.window.loadURL('http://127.0.0.1:20719')

    // Set minimum window size.
    this.window.setMinimumSize(360, 580)

    // Handle window closed.
    this.window.on('closed', () => {
      this.window = null
    })
  }

  close() {
    // Keep app active on MacOS.
    if (process.platform !== 'darwin') {
      app.quit()
    }
  }
}

app.on('ready', () => {
  const desktop = new Desktop()
  desktop.run()
})
