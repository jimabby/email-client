const { contextBridge, ipcRenderer } = require('electron');

// Minimal, two-channel bridge. The renderer can subscribe to shell events (a
// notification was clicked, the tray asked for a compose window, the shell
// wants a taskbar badge drawn) and can tell the shell about two pieces of
// chrome state. It gets no access to Node, the filesystem, or arbitrary IPC.
const CHANNELS = ['hermes:open', 'hermes:compose', 'hermes:backend-down', 'hermes:badge'];

contextBridge.exposeInMainWorld('hermes', {
  isDesktop: true,

  /**
   * @param {'hermes:open'|'hermes:compose'|'hermes:backend-down'|'hermes:badge'} channel
   * @param {(payload: unknown) => void} handler
   * @returns {() => void} unsubscribe
   */
  on(channel, handler) {
    if (!CHANNELS.includes(channel) || typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  /**
   * Report chrome state to the shell.
   *
   * `theme` lets the next launch paint the correct background before the first
   * frame — the renderer's choice lives in localStorage, which the main process
   * cannot read. `badgeDataUrl` is a PNG the renderer rasterised for the
   * Windows taskbar overlay, which needs a real image rather than a number.
   *
   * Both fields are re-validated in the main process; the shape check here is
   * only to keep obvious mistakes off the wire.
   *
   * @param {{ theme?: 'light'|'dark', badgeDataUrl?: string }} state
   */
  setChrome(state) {
    if (!state || typeof state !== 'object') return;
    const payload = {};
    if (state.theme === 'light' || state.theme === 'dark') payload.theme = state.theme;
    if (typeof state.badgeDataUrl === 'string') payload.badgeDataUrl = state.badgeDataUrl;
    if (Object.keys(payload).length) ipcRenderer.send('hermes:chrome', payload);
  },
});
