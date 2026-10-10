import { CommonModule } from '@angular/common';
import { Component, EventEmitter, HostListener, Input, OnInit, Output, signal } from '@angular/core';
import { ObjectProperties, S3ListItem } from '../../core/models/models';
import { AppSettingsService } from '../../core/services/app-settings.service';
import { ElectronService } from '../../core/services/electron.service';

/**
 * Properties popup for a single selected file/folder. Takes the already-known
 * list item (name/key/type) plus an explicit connectionId+bucket so it works
 * the same way from both the single-pane view (driven by the active tab) and
 * the dual-pane view (driven by whichever pane's own connection/bucket state
 * the item came from) without depending on either one's service directly.
 *
 * Folders don't get a HeadObject round-trip (S3 "folders" are just prefixes,
 * not necessarily real objects) - only Name/Full path/Type are shown for those.
 */
@Component({
  selector: 'app-properties-dialog',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './properties-dialog.component.html',
  styleUrl: './properties-dialog.component.scss'
})
export class PropertiesDialogComponent implements OnInit {
  @Input({ required: true }) item!: S3ListItem;
  @Input() connectionId: string | null = null;
  @Input() bucket: string | null = null;
  @Output() closed = new EventEmitter<void>();

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly properties = signal<ObjectProperties | null>(null);

  constructor(
    private electron: ElectronService,
    public appSettings: AppSettingsService
  ) {}

  formatBytes = (bytes?: number) => this.appSettings.formatSize(bytes);

  async ngOnInit(): Promise<void> {
    if (this.item.type !== 'file' || !this.connectionId || !this.bucket) return;
    this.loading.set(true);
    try {
      const props = await this.electron.api.s3.getObjectProperties(this.connectionId, this.bucket, this.item.key);
      this.properties.set(props);
    } catch (err: any) {
      this.error.set(err?.message || String(err));
    } finally {
      this.loading.set(false);
    }
  }

  @HostListener('document:keydown.escape')
  close(): void {
    this.closed.emit();
  }
}
