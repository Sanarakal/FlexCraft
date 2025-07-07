import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

type Listener = (ev: IpcRendererEvent, ...args: unknown[]) => void;

contextBridge.exposeInMainWorld('electron', {
  /** слушаем однократно либо постоянно */
  on   : (channel: string, listener: Listener) => ipcRenderer.on(channel, listener),

  /** отписываем слушатель (Electron ≥ 14: removeListener ≈ off) */
  off  : (channel: string, listener: Listener) => ipcRenderer.removeListener(channel, listener),

  /** invoke/handle RPC */
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  snapshot: () => ipcRenderer.invoke('snapshot-ui'),
});
