import { Injectable, signal } from '@angular/core';
import { AppSettingsService } from './app-settings.service';
import { ConnectionService } from './connection.service';
import { ElectronService } from './electron.service';

export interface TypedConfirmRequest {
  title: string;
  message: string;
  /** What the user has to type before the confirm button enables. */
  phrase: string;
  resolve: (ok: boolean) => void;
}

/**
 * Single entry point for "are you sure you want to delete?" so the Safety
 * preferences apply everywhere: skipping the prompt entirely, or - for
 * connections flagged Production - requiring the item name to be typed.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  /** The type-to-confirm dialog currently waiting on the user (rendered by ConfirmHostComponent). */
  readonly typed = signal<TypedConfirmRequest | null>(null);

  constructor(
    private electron: ElectronService,
    private settings: AppSettingsService,
    private connections: ConnectionService
  ) {}

  async confirmDelete(opts: { count: number; singleName?: string | null; connectionId: string | null }): Promise<boolean> {
    const s = this.settings.settings();
    const profile = this.connections.connections().find((c) => c.id === opts.connectionId);

    if (s.typeToConfirmProduction && profile?.isProduction) {
      const phrase = opts.count === 1 && opts.singleName ? opts.singleName : 'DELETE';
      return new Promise<boolean>((resolve) =>
        this.typed.set({
          title: `Delete from production ("${profile.name}")`,
          message:
            opts.count === 1
              ? `This permanently deletes "${opts.singleName}". It cannot be undone.`
              : `This permanently deletes ${opts.count} items. It cannot be undone.`,
          phrase,
          resolve
        })
      );
    }

    if (!s.confirmDelete) return true;
    return this.electron.api.dialogs.confirm(`Delete ${opts.count} item(s)?`, 'This action cannot be undone.');
  }

  resolveTyped(ok: boolean): void {
    const req = this.typed();
    this.typed.set(null);
    req?.resolve(ok);
  }
}
