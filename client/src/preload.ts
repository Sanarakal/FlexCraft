import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

export interface IElectronAPI {
  invoke<T = unknown>(channel: string, args?: any): Promise<T>;
  on(channel: string, listener: (e: IpcRendererEvent, data: any) => void): void;
}

const api: IElectronAPI = {
  invoke: (c, a) => ipcRenderer.invoke(c, a),
  on   : (c, fn) => ipcRenderer.on(c, fn),
};

contextBridge.exposeInMainWorld('electron', api);
