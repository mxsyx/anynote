const electron = require('electron');

const app = electron.app;
const BrowserWindow = electron.BrowserWindow;

/**
 * Disable menu.
 */
const Menu = electron.Menu;
Menu.setApplicationMenu(null);


class Desktop {
  constructor() {
    this.window = new BrowserWindow({
      width: 800,
      height: 600,
      webPreferences: {
        nodeIntegration: true
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
    this.window.loadURL('http://127.0.0.1:8081')
  
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
