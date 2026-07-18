import { Injectable } from '@angular/core';

declare global {
  interface Window {
    electronAPI?: any;
  }
}

/**
 * Single point of access to window.electronAPI (exposed by electron/preload.js).
 * Throws a clear error if the app is somehow loaded outside Electron, instead
 * of failing with a cryptic "undefined is not a function" deep in a component.
 */
@Injectable({ providedIn: 'root' })
export class ElectronService {
  get api(): any {
    if (!window.electronAPI) {
      throw new Error('electronAPI bridge is not available. This app must run inside the Flash S3 Electron shell.');
    }
    return window.electronAPI;
  }

  get isElectron(): boolean {
    return !!window.electronAPI;
  }
}
