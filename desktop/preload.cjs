// The only bridge between the page and the app: deck commands in, and the offline page's two buttons.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('deckDesktop', {
  /** cb(cmd): 'new' | 'stop' | 'shell' | 'palette' | 'next' | 'prev' | 'tab:1'..'tab:9' */
  on(cb) {
    ipcRenderer.on('deck', (_e, cmd) => cb(String(cmd)))
  },
  start: () => ipcRenderer.invoke('deck:start'),
  retry: () => ipcRenderer.invoke('deck:retry'),
})
