import { CommonModule } from '@angular/common';
import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { S3BrowserService } from '../../core/services/s3-browser.service';

@Component({
  selector: 'app-bucket-tree',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './bucket-tree.component.html',
  styleUrl: './bucket-tree.component.scss'
})
export class BucketTreeComponent {
  readonly searchTerm = signal('');

  readonly filteredBuckets = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    const buckets = this.s3.buckets();
    if (!term) return buckets;
    return buckets.filter((b) => b.name.toLowerCase().includes(term));
  });

  constructor(public s3: S3BrowserService) {}

  select(bucketName: string): void {
    this.s3.openBucket(bucketName);
  }

  clearSearch(): void {
    this.searchTerm.set('');
  }
}
