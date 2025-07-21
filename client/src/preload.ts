/* ────────────────────────────────────────────────────────────────
 * preload.ts – expose API → window.electron
 * дата: 19 Jul 2025
 * ──────────────────────────────────────────────────────────────── */
import {
  contextBridge,
  ipcRenderer,
  IpcRendererEvent,
} from 'electron';

type Listener = (e: IpcRendererEvent, ...args: unknown[]) => void;

contextBridge.exposeInMainWorld('electron', {
  /* events */
  on : (c: string, fn: Listener) => ipcRenderer.on(c, fn),
  off: (c: string, fn: Listener) => ipcRenderer.removeListener(c, fn),

  /* invoke */
  invoke: (c: string, ...args: unknown[]) => ipcRenderer.invoke(c, ...args),

  /* snapshot (для renderer‑отладчика) */
  snapshot: () => ipcRenderer.invoke('snapshot-ui'),

  /* безопасное открытие ссылок через main‑process */
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
});
