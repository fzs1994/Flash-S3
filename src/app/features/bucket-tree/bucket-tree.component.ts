import { CommonModule } from '@angular/common';
import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BucketFavoritesService } from '../../core/services/bucket-favorites.service';
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
    const connectionId = this.s3.activeConnectionId();
    let buckets = this.s3.buckets();

    if (this.favorites.showFavoritesOnly()) {
      buckets = buckets.filter((b) => this.favorites.isFavorite(connectionId, b.name));
    }
    if (term) {
      buckets = buckets.filter((b) => b.name.toLowerCase().includes(term));
    }
    return buckets;
  });

  constructor(
    public s3: S3BrowserService,
    public favorites: BucketFavoritesService
  ) {}

  select(bucketName: string): void {
    this.s3.openBucket(bucketName);
  }

  clearSearch(): void {
    this.searchTerm.set('');
  }

  isFavorite(bucketName: string): boolean {
    return this.favorites.isFavorite(this.s3.activeConnectionId(), bucketName);
  }

  toggleFavorite(bucketName: string, ev: Event): void {
    ev.stopPropagation();
    this.favorites.toggleFavorite(this.s3.activeConnectionId(), bucketName);
  }
}
