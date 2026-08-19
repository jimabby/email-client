const { contextBridge, ipcRenderer } = require('electron');

// Minimal, one-directional bridge. The renderer can subscribe to shell events
// (a notification was clicked, the tray asked for a compose window) but gets no
// access to Node, the filesystem, or arbitrary IPC channels.
const CHANNELS = ['hermes:open', 'hermes:compose', 'hermes:backend-down'];

contextBridge.exposeInMainWorld('hermes', {
  isDesktop: true,

  /**
   * @param {'hermes:open'|'hermes:compose'|'hermes:backend-down'} channel
   * @param {(payload: unknown) => void} handler
   * @returns {() => void} unsubscribe
   */
  on(channel, handler) {
    if (!CHANNELS.includes(channel) || typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
