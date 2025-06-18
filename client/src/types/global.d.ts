import type { IpcRendererEvent } from 'electron';

export interface IElectronAPI {
  invoke<T = unknown>(channel: string, args?: any): Promise<T>;
  on(
    channel: string,
    listener: (event: IpcRendererEvent, data: any) => void
  ): void;
}

declare global {
  interface Window {
    electron: IElectronAPI;
  }
}
