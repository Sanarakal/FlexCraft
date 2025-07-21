declare module '*.png' {
  const value: string;
  export default value;
}
/* глобальный API, который preload кладёт в window */
export interface IElectronAPI {
  on   : (channel: string, listener: (...args: any[]) => void) => void;
  off  : (channel: string, listener: (...args: any[]) => void) => void;
  invoke: (channel: string, ...args: any[]) => Promise<any>;
  snapshot(): Promise<string>;
}

declare global {
  interface Window {
    electron: IElectronAPI;
  }
}
