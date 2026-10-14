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

  /** Copies text via Electron's native clipboard, falling back to the web API outside the shell. */
  async copyText(text: string): Promise<void> {
    if (window.electronAPI?.clipboard?.writeText) {
      window.electronAPI.clipboard.writeText(text);
      return;
    }
    await navigator.clipboard.writeText(text);
  }

  get isElectron(): boolean {
    return !!window.electronAPI;
  }
}
