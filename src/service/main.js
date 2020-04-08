const electron = require('electron');
const path = require('path')
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;

const a  = require('./index')

/**
 * Disable menu.
 */
//const Menu = electron.Menu;
//Menu.setApplicationMenu(null);

class Desktop {
  constructor() {
    this.window = new BrowserWindow({
      width: 800,
      height: 600,
      webPreferences: {
        nodeIntegration: true,
        preload: path.join(__dirname, './renderer.js')
      }
    });
    this.develop();
  }

  /**
   * Debug for developers.
   */
  develop() {
    const globalShortcut = electron.globalShortcut;
    globalShortcut.register('Control+Shift+i', () => {
      this.window.webContents.openDevTools();
    })
  }
  
  run() {
    // Load index.html file.
    this.window.loadURL('http://127.0.0.1:8080')
  
    // Set minimum window size.
    this.window.setMinimumSize(360, 580);

    // Handle window closed.
    this.window.on('closed', () => {
      this.window = null
    });
  }

  close() {
    // Keep app active on MacOS.
    if (process.platform !== 'darwin') {
      app.quit()
    }
  }
}


app.on('ready', () => {
  const desktop = new Desktop();
  desktop.run();
});
 
electron.ipcMain.on('noteContentChanged', (e,content) => {
  a.saveNote(content);
})