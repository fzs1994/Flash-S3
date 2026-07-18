import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Output, signal } from '@angular/core';
import { S3BrowserService } from '../../core/services/s3-browser.service';
import { ThemeService } from '../../core/services/theme.service';
import { TransferService } from '../../core/services/transfer.service';
import { BookmarksComponent } from '../bookmarks/bookmarks.component';

@Component({
  selector: 'app-toolbar',
  standalone: true,
  imports: [CommonModule, BookmarksComponent],
  templateUrl: './toolbar.component.html',
  styleUrl: './toolbar.component.scss'
})
export class ToolbarComponent {
  @Output() newFolderRequested = new EventEmitter<void>();
  @Output() manageConnectionsRequested = new EventEmitter<void>();

  readonly exporting = signal(false);
  readonly exportError = signal<string | null>(null);

  constructor(
    public s3: S3BrowserService,
    public transfers: TransferService,
    public theme: ThemeService
  ) {}

  get hasBucket(): boolean {
    return !!this.s3.currentBucket();
  }

  refresh(): void {
    if (this.s3.currentBucket()) this.s3.refreshListing();
    else this.s3.loadBuckets();
  }

  uploadFiles(): void {
    const bucket = this.s3.currentBucket();
    if (bucket) this.transfers.uploadFilesDialog(bucket, this.s3.currentPrefix());
  }

  uploadFolder(): void {
    const bucket = this.s3.currentBucket();
    if (bucket) this.transfers.uploadFolderDialog(bucket, this.s3.currentPrefix());
  }

  async exportCsv(): Promise<void> {
    this.exporting.set(true);
    this.exportError.set(null);
    try {
      await this.s3.exportListingCsv();
    } catch (err: any) {
      this.exportError.set(err?.message || String(err));
    } finally {
      this.exporting.set(false);
    }
  }
}
