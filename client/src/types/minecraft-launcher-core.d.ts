import 'minecraft-launcher-core';

declare module 'minecraft-launcher-core' {
  interface ILauncherOptions {
    /** передаётся игре после `--` */
    extraArguments?: string[];
    /** запуск дочернего процесса в detached-режиме */
    detached?: boolean;
  }
}
