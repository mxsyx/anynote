const electron = require('electron')
const path = require('path')
const { app, BrowserWindow, Menu, globalShortcut } = electron

const { saveNote } = require('../../build/servcie')


class Desktop {
  constructor() {
    this.window = new BrowserWindow({
      width: 800,
      height: 600,
      webPreferences: {
        nodeIntegration: true,
        preload: path.join(__dirname, 'preload.js'),
      },
    })
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
    this.window.loadURL('http://127.0.0.1:6888')

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

electron.ipcMain.on('noteContentChanged', (e, content) => {
  saveNote(content)
})
