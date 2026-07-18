import { CommonModule } from '@angular/common';
import { Component, computed } from '@angular/core';
import { S3BrowserService } from '../../core/services/s3-browser.service';

@Component({
  selector: 'app-status-bar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './status-bar.component.html',
  styleUrl: './status-bar.component.scss'
})
export class StatusBarComponent {
  readonly itemCount = computed(() => this.s3.items().length);
  readonly selectedCount = computed(() => this.s3.selectedKeys().size);
  readonly connectionName = computed(() => this.s3.activeTab()?.name ?? null);

  constructor(public s3: S3BrowserService) {}
}
