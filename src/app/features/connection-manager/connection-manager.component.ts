import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ConnectionProfile, ConnectionProfileInput } from '../../core/models/models';
import { ConnectionService } from '../../core/services/connection.service';
import { S3BrowserService } from '../../core/services/s3-browser.service';

@Component({
  selector: 'app-connection-manager',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './connection-manager.component.html',
  styleUrl: './connection-manager.component.scss'
})
export class ConnectionManagerComponent {
  @Output() connected = new EventEmitter<string>();

  readonly showForm = signal(false);
  readonly isEditing = signal(false);
  readonly testing = signal(false);
  readonly testResult = signal<{ ok: boolean; error?: string } | null>(null);
  readonly saving = signal(false);

  form: ConnectionProfileInput = { name: '', region: 'us-east-1', accessKeyId: '', secretAccessKey: '' };

  readonly regions = [
    'us-east-1',
    'us-east-2',
    'us-west-1',
    'us-west-2',
    'eu-west-1',
    'eu-west-2',
    'eu-central-1',
    'ap-south-1',
    'ap-southeast-1',
    'ap-southeast-2',
    'ap-northeast-1',
    'sa-east-1',
    'ca-central-1'
  ];

  constructor(
    public connectionService: ConnectionService,
    public s3: S3BrowserService
  ) {
    this.connectionService.refresh();
  }

  isOpen(id: string): boolean {
    return this.s3.tabs().some((t) => t.connectionId === id);
  }

  isActive(id: string): boolean {
    return this.s3.activeConnectionId() === id;
  }

  newConnection(): void {
    this.form = { name: '', region: 'us-east-1', accessKeyId: '', secretAccessKey: '' };
    this.isEditing.set(false);
    this.testResult.set(null);
    this.showForm.set(true);
  }

  editConnection(c: ConnectionProfile, ev: Event): void {
    ev.stopPropagation();
    this.form = {
      id: c.id,
      name: c.name,
      region: c.region,
      accessKeyId: c.accessKeyId,
      secretAccessKey: ''
    };
    this.isEditing.set(true);
    this.testResult.set(null);
    this.showForm.set(true);
  }

  cancel(): void {
    this.showForm.set(false);
  }

  async testConnection(): Promise<void> {
    this.testing.set(true);
    this.testResult.set(null);
    try {
      const res = await this.connectionService.test(this.form);
      this.testResult.set(res);
    } finally {
      this.testing.set(false);
    }
  }

  async save(): Promise<void> {
    this.saving.set(true);
    try {
      const id = await this.connectionService.save(this.form);
      this.showForm.set(false);
      this.select(id);
    } finally {
      this.saving.set(false);
    }
  }

  select(id: string): void {
    this.connected.emit(id);
  }

  async remove(c: ConnectionProfile, ev: Event): Promise<void> {
    ev.stopPropagation();
    const detail = this.isOpen(c.id)
      ? 'This will also close its open tab and delete its stored credentials. This cannot be undone.'
      : 'This will delete its stored credentials. This cannot be undone.';
    const ok = await (window as any).electronAPI.dialogs.confirm(`Delete connection "${c.name}"?`, detail);
    if (!ok) return;
    await this.connectionService.remove(c.id);
    // The profile (and its credentials) are gone - any open tab for it is now dead weight.
    if (this.isOpen(c.id)) this.s3.closeConnectionTab(c.id);
  }
}
