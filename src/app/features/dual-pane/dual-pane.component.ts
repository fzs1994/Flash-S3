import { CommonModule } from '@angular/common';
import { Component, ElementRef, HostListener, signal } from '@angular/core';
import { PaneViewComponent } from './pane-view.component';

const MIN_PCT = 20;
const MAX_PCT = 80;
const STORAGE_KEY = 's3b:dualPaneLeftWidth';

function loadLeftWidth(): number {
  if (typeof localStorage === 'undefined') return 50;
  const raw = localStorage.getItem(STORAGE_KEY);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? Math.min(MAX_PCT, Math.max(MIN_PCT, parsed)) : 50;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Two independent, side-by-side browsing panes (classic Total-Commander-style
 * dual-pane file manager) - lets you park two different buckets/folders on
 * screen at once, even within the same account, and move files between them
 * with a click instead of round-tripping through the Copy/Move To dialog.
 */
@Component({
  selector: 'app-dual-pane',
  standalone: true,
  imports: [CommonModule, PaneViewComponent],
  templateUrl: './dual-pane.component.html',
  styleUrl: './dual-pane.component.scss'
})
export class DualPaneComponent {
  readonly leftWidthPct = signal(loadLeftWidth());
  private resizing = false;

  constructor(private elRef: ElementRef<HTMLElement>) {}

  startResize(ev: MouseEvent): void {
    ev.preventDefault();
    this.resizing = true;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }

  @HostListener('document:mousemove', ['$event'])
  onDocumentMouseMove(ev: MouseEvent): void {
    if (!this.resizing) return;
    const container = this.elRef.nativeElement.querySelector('.dual-pane');
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const pct = ((ev.clientX - rect.left) / rect.width) * 100;
    this.leftWidthPct.set(clamp(pct, MIN_PCT, MAX_PCT));
  }

  @HostListener('document:mouseup')
  onDocumentMouseUp(): void {
    if (!this.resizing) return;
    this.resizing = false;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, String(Math.round(this.leftWidthPct())));
    }
  }
}
