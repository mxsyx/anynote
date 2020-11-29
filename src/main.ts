import * as path from 'path'
import * as electron from 'electron'

const { app, BrowserWindow, Menu,  globalShortcut } = electron

class Desktop {
  private window

  constructor() {
    this.window = new BrowserWindow({
      fullscreen: true,
      webPreferences: {
        nodeIntegration: true,
        preload: path.resolve(__dirname, 'preload.js')
      }
    }) 
    Menu.setApplicationMenu(null);
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
    this.window.loadURL('http://127.0.0.1:8187')
    
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

app.on('ready', async () => {
  const desktop = new Desktop()
  desktop.run()
})
