import { CommonModule } from '@angular/common';
import { Component, ElementRef, EventEmitter, HostListener, Input, OnInit, Output, ViewChild, computed, signal } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { S3ListItem } from '../../core/models/models';
import { ElectronService } from '../../core/services/electron.service';
import { TransferService } from '../../core/services/transfer.service';
import { PreviewKind, getPreviewInfo } from '../../core/utils/preview-types';

function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

const ARCHIVED_CLASSES = new Set(['GLACIER', 'DEEP_ARCHIVE']);

const ZOOM_STEP = 1.25;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 10;

type PreviewContent =
  | { kind: 'image' | 'video' | 'audio'; url: string }
  | { kind: 'pdf'; url: SafeResourceUrl }
  | { kind: 'text'; text: string; truncated: boolean; totalSize: number };

/**
 * Quick Look-style viewer for a single file, with prev/next across the other
 * previewable files in the same listing. Like the Properties dialog it takes
 * an explicit connectionId + bucket so it works identically from the
 * single-pane list and either side of the dual-pane view.
 *
 * Media/PDF load straight from a short-lived presigned URL (no CORS needed,
 * video/audio stream). Text is fetched in the main process (first 1 MB) and
 * always shown as source, never rendered.
 */
@Component({
  selector: 'app-preview-dialog',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './preview-dialog.component.html',
  styleUrl: './preview-dialog.component.scss'
})
export class PreviewDialogComponent implements OnInit {
  @Input({ required: true }) items: S3ListItem[] = [];
  @Input({ required: true }) startKey!: string;
  @Input() connectionId: string | null = null;
  @Input() bucket: string | null = null;
  @Output() closed = new EventEmitter<void>();

  readonly index = signal(0);
  readonly item = computed<S3ListItem | undefined>(() => this.items[this.index()]);
  readonly kind = computed<PreviewKind | null>(() => {
    const item = this.item();
    return item ? getPreviewInfo(item.name)?.kind ?? null : null;
  });

  /** Fetching the URL / text from the main process. */
  readonly loading = signal(false);
  /** URL is in hand but the image/PDF/media element hasn't finished loading it yet. */
  readonly mediaLoading = signal(false);
  readonly error = signal<string | null>(null);
  readonly content = signal<PreviewContent | null>(null);

  /** Bumped per load so a slow response for a file the user has already stepped past is dropped. */
  private requestId = 0;

  /**
   * Image zoom: 'fit' shrinks to the viewport (never upscales); a number is an
   * explicit scale of the image's natural size (1 = 100%). `fitScale` is what
   * 'fit' works out to, so the % label and the first step away from fit start
   * from what's actually on screen.
   */
  readonly zoom = signal<number | 'fit'>('fit');
  readonly fitScale = signal(1);
  readonly scale = computed(() => {
    const z = this.zoom();
    return z === 'fit' ? this.fitScale() : z;
  });
  readonly zoomPercent = computed(() => Math.round(this.scale() * 100));
  readonly panning = signal(false);
  private naturalWidth = 0;
  private naturalHeight = 0;
  private pan: { x: number; y: number; left: number; top: number } | null = null;

  @ViewChild('imageScroller') private imageScroller?: ElementRef<HTMLDivElement>;

  formatBytes = formatBytes;

  constructor(
    private electron: ElectronService,
    private transfers: TransferService,
    private sanitizer: DomSanitizer
  ) {}

  ngOnInit(): void {
    const start = this.items.findIndex((i) => i.key === this.startKey);
    this.index.set(Math.max(0, start));
    this.load();
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(ev: KeyboardEvent): void {
    // Let a focused video/audio keep its own Space (play/pause) and arrow (seek) keys.
    const onMedia = (ev.target as HTMLElement | null)?.closest?.('video, audio');
    if (ev.key === 'Escape' || (ev.key === ' ' && !onMedia)) {
      ev.preventDefault();
      this.close();
    } else if (ev.key === 'ArrowLeft' && !onMedia) {
      ev.preventDefault();
      this.prev();
    } else if (ev.key === 'ArrowRight' && !onMedia) {
      ev.preventDefault();
      this.next();
    } else if (this.kind() === 'image' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      // Plain keys only - Ctrl +/-/0 stay with Electron's own whole-window zoom.
      const actions: Record<string, () => void> = {
        '+': () => this.zoomIn(),
        '=': () => this.zoomIn(),
        '-': () => this.zoomOut(),
        '0': () => this.zoomToFit(),
        '1': () => this.zoomActualSize()
      };
      const action = actions[ev.key];
      if (action) {
        ev.preventDefault();
        action();
      }
    }
  }

  @HostListener('window:resize')
  onResize(): void {
    this.updateFitScale();
  }

  get hasPrev(): boolean {
    return this.index() > 0;
  }

  get hasNext(): boolean {
    return this.index() < this.items.length - 1;
  }

  prev(): void {
    if (!this.hasPrev) return;
    this.index.update((i) => i - 1);
    this.load();
  }

  next(): void {
    if (!this.hasNext) return;
    this.index.update((i) => i + 1);
    this.load();
  }

  private async load(): Promise<void> {
    const id = ++this.requestId;
    const item = this.item();
    const info = item ? getPreviewInfo(item.name) : null;
    this.content.set(null);
    this.error.set(null);
    this.mediaLoading.set(false);
    this.zoom.set('fit');
    this.naturalWidth = this.naturalHeight = 0;
    if (!item || !info || !this.connectionId || !this.bucket) return;

    if (item.storageClass && ARCHIVED_CLASSES.has(item.storageClass)) {
      this.error.set(`This object is archived (${item.storageClass}) - restore it before previewing.`);
      return;
    }

    this.loading.set(true);
    try {
      if (info.kind === 'text') {
        const res = await this.electron.api.s3.getTextPreview(this.connectionId, this.bucket, item.key);
        if (id !== this.requestId) return;
        this.content.set({ kind: 'text', text: this.prettify(item.name, res.text, res.truncated), truncated: res.truncated, totalSize: res.totalSize });
      } else {
        const { url } = await this.electron.api.s3.getPreviewUrl(this.connectionId, this.bucket, item.key, info.mime);
        if (id !== this.requestId) return;
        this.mediaLoading.set(info.kind !== 'audio');
        this.content.set(
          info.kind === 'pdf'
            ? { kind: 'pdf', url: this.sanitizer.bypassSecurityTrustResourceUrl(url) }
            : { kind: info.kind, url }
        );
      }
    } catch (err: any) {
      if (id !== this.requestId) return;
      this.error.set(this.cleanError(err));
    } finally {
      if (id === this.requestId) this.loading.set(false);
    }
  }

  /** Pretty-prints complete JSON; anything else (or JSON cut off at the 1 MB limit) is shown as-is. */
  private prettify(name: string, text: string, truncated: boolean): string {
    if (truncated || !name.toLowerCase().endsWith('.json')) return text;
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }

  /** Electron prefixes IPC rejections with "Error invoking remote method '...': Error: " - strip it for display. */
  private cleanError(err: any): string {
    const msg = err?.message || String(err);
    return msg.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
  }

  onMediaLoaded(): void {
    this.mediaLoading.set(false);
  }

  onImageLoaded(img: HTMLImageElement): void {
    // SVGs without intrinsic dimensions report 0 - treat their fitted size as "100%" instead.
    this.naturalWidth = img.naturalWidth || img.clientWidth;
    this.naturalHeight = img.naturalHeight || img.clientHeight;
    this.updateFitScale();
    this.onMediaLoaded();
  }

  get imageWidth(): number | null {
    return this.zoom() === 'fit' || !this.naturalWidth ? null : Math.round(this.naturalWidth * this.scale());
  }

  get imageHeight(): number | null {
    return this.zoom() === 'fit' || !this.naturalHeight ? null : Math.round(this.naturalHeight * this.scale());
  }

  get canZoomIn(): boolean {
    return this.scale() < MAX_ZOOM;
  }

  get canZoomOut(): boolean {
    return this.scale() > MIN_ZOOM;
  }

  zoomIn(anchor?: { x: number; y: number }): void {
    this.setZoom(this.scale() * ZOOM_STEP, anchor);
  }

  zoomOut(anchor?: { x: number; y: number }): void {
    this.setZoom(this.scale() / ZOOM_STEP, anchor);
  }

  zoomToFit(): void {
    this.zoom.set('fit');
  }

  zoomActualSize(): void {
    this.setZoom(1);
  }

  /** Double-click toggles between fit and 100%, keeping the clicked point under the cursor. */
  onImageDoubleClick(ev: MouseEvent): void {
    if (this.zoom() === 'fit') this.setZoom(1, this.scrollerPoint(ev));
    else this.zoomToFit();
  }

  /** Ctrl+wheel zooms around the cursor; a plain wheel just scrolls a zoomed-in image. */
  onImageWheel(ev: WheelEvent): void {
    if (!ev.ctrlKey && !ev.metaKey) return;
    ev.preventDefault();
    const anchor = this.scrollerPoint(ev);
    if (ev.deltaY < 0) this.zoomIn(anchor);
    else if (ev.deltaY > 0) this.zoomOut(anchor);
  }

  /** Drag to pan once the image is bigger than the viewport. */
  onImageMouseDown(ev: MouseEvent): void {
    const el = this.imageScroller?.nativeElement;
    if (ev.button !== 0 || !el || !this.isOverflowing()) return;
    ev.preventDefault();
    this.pan = { x: ev.clientX, y: ev.clientY, left: el.scrollLeft, top: el.scrollTop };
    this.panning.set(true);
  }

  @HostListener('document:mousemove', ['$event'])
  onPanMove(ev: MouseEvent): void {
    const el = this.imageScroller?.nativeElement;
    if (!this.pan || !el) return;
    el.scrollLeft = this.pan.left - (ev.clientX - this.pan.x);
    el.scrollTop = this.pan.top - (ev.clientY - this.pan.y);
  }

  @HostListener('document:mouseup')
  onPanEnd(): void {
    this.pan = null;
    this.panning.set(false);
  }

  isOverflowing(): boolean {
    const el = this.imageScroller?.nativeElement;
    return !!el && (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight);
  }

  private setZoom(next: number, anchor?: { x: number; y: number }): void {
    const el = this.imageScroller?.nativeElement;
    const prev = this.scale();
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    if (clamped === prev && this.zoom() !== 'fit') return;

    // Keep the point under the anchor (cursor, or the viewport centre) fixed while the image grows/shrinks.
    const point = anchor ?? (el ? { x: el.clientWidth / 2, y: el.clientHeight / 2 } : { x: 0, y: 0 });
    const contentX = el ? el.scrollLeft + point.x : 0;
    const contentY = el ? el.scrollTop + point.y : 0;
    this.zoom.set(clamped);
    if (!el) return;
    const ratio = clamped / prev;
    requestAnimationFrame(() => {
      el.scrollLeft = contentX * ratio - point.x;
      el.scrollTop = contentY * ratio - point.y;
    });
  }

  private updateFitScale(): void {
    const el = this.imageScroller?.nativeElement;
    if (!el || !this.naturalWidth || !this.naturalHeight) return;
    this.fitScale.set(Math.min(1, el.clientWidth / this.naturalWidth, el.clientHeight / this.naturalHeight));
  }

  private scrollerPoint(ev: MouseEvent): { x: number; y: number } | undefined {
    const el = this.imageScroller?.nativeElement;
    if (!el) return undefined;
    const rect = el.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  onMediaError(): void {
    this.mediaLoading.set(false);
    this.error.set('This file could not be displayed. It may be corrupt or use an unsupported encoding.');
  }

  download(): void {
    const item = this.item();
    if (!item || !this.bucket) return;
    this.transfers.downloadItemsDialog(this.bucket, [{ key: item.key, name: item.name, size: item.size }], this.connectionId ?? undefined);
  }

  /**
   * Only a click that both starts and ends on the backdrop closes the viewer -
   * releasing a pan drag outside the dialog also fires a click on the
   * backdrop (the common ancestor), which mustn't count.
   */
  private pressedOnOverlay = false;

  onOverlayMouseDown(ev: MouseEvent): void {
    this.pressedOnOverlay = ev.target === ev.currentTarget;
  }

  onOverlayClick(ev: MouseEvent): void {
    if (this.pressedOnOverlay && ev.target === ev.currentTarget) this.close();
    this.pressedOnOverlay = false;
  }

  close(): void {
    this.closed.emit();
  }
}
