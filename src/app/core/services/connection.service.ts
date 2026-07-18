import { Injectable, signal } from '@angular/core';
import { ConnectionProfile, ConnectionProfileInput } from '../models/models';
import { ElectronService } from './electron.service';

/**
 * Manages saved connection *profiles* only (CRUD against the encrypted
 * credential store). Which profile(s) are actually open and which one is
 * focused is a separate concept, owned by S3BrowserService's tabs - a
 * profile can be saved here without ever being opened, and the same
 * profile can be reopened into a tab any number of times.
 */
@Injectable({ providedIn: 'root' })
export class ConnectionService {
  readonly connections = signal<ConnectionProfile[]>([]);

  constructor(private electron: ElectronService) {}

  async refresh(): Promise<void> {
    const list = await this.electron.api.connections.list();
    this.connections.set(list);
  }

  async save(profile: ConnectionProfileInput): Promise<string> {
    const res = await this.electron.api.connections.save(profile);
    await this.refresh();
    return res.id;
  }

  async remove(id: string): Promise<void> {
    await this.electron.api.connections.remove(id);
    await this.refresh();
  }

  async test(profile: ConnectionProfileInput): Promise<{ ok: boolean; error?: string }> {
    return this.electron.api.connections.test(profile);
  }
}
