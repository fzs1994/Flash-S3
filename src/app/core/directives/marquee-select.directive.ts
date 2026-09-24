import { Directive, ElementRef, EventEmitter, NgZone, OnDestroy, Output } from '@angular/core';

export interface MarqueeSelectEvent {
  /** Keys (from each row's `data-select-key`) currently inside the box. */
  keys: string[];
  /** Ctrl/Cmd/Shift was held when the drag started - add to the existing selection instead of replacing it. */
  additive: boolean;
}

/** Keys from `anchor` to `target` inclusive, in list order. Empty when either isn't in the list. */
export function rangeKeys(orderedKeys: string[], anchor: string, target: string): string[] {
  const a = orderedKeys.indexOf(anchor);
  const b = orderedKeys.indexOf(target);
  if (a === -1 || b === -1) return [];
  return orderedKeys.slice(Math.min(a, b), Math.max(a, b) + 1);
}

const DRAG_THRESHOLD = 5;
const AUTO_SCROLL_SPEED = 12;

/**
 * Explorer-style rubber-band selection. Put it on the scrolling list element
 * and tag each selectable row with `data-select-key`. Dragging with the left
 * button draws a box (in scroll-content coordinates, so it stays put while
 * the list auto-scrolls near its top/bottom edge) and emits the keys of every
 * row it touches. A plain click on empty space emits an empty selection so
 * the host can clear it; a plain click on a row is left to the row's own
 * click handler. After a real drag, the click that the browser fires on
 * mouseup is swallowed so it doesn't collapse the selection back to one row.
 */
@Directive({
  selector: '[appMarqueeSelect]',
  standalone: true,
  // The box is absolutely positioned in the host's content coordinates, so the host must be its containing block.
  host: { '[style.position]': "'relative'" }
})
export class MarqueeSelectDirective implements OnDestroy {
  @Output() marqueeStart = new EventEmitter<void>();
  @Output() marqueeChange = new EventEmitter<MarqueeSelectEvent>();

  private startX = 0;
  private startY = 0;
  private lastClientX = 0;
  private lastClientY = 0;
  private additive = false;
  private startedOnRow = false;
  private dragging = false;
  private box: HTMLDivElement | null = null;
  private scrollFrame: number | null = null;
  private lastSignature: string | null = null;

  constructor(private host: ElementRef<HTMLElement>, private zone: NgZone) {
    const el = host.nativeElement;
    this.zone.runOutsideAngular(() => el.addEventListener('mousedown', this.onMouseDown));
  }

  ngOnDestroy(): void {
    this.host.nativeElement.removeEventListener('mousedown', this.onMouseDown);
    this.stopTracking();
  }

  private onMouseDown = (ev: MouseEvent): void => {
    if (ev.button !== 0) return;
    const el = this.host.nativeElement;
    const target = ev.target as HTMLElement;
    if (target.closest('input, textarea, select, button, a, th')) return;
    // Ignore presses on the scrollbar itself.
    const rect = el.getBoundingClientRect();
    if (ev.clientX >= rect.left + el.clientWidth || ev.clientY >= rect.top + el.clientHeight) return;

    const p = this.toContent(ev.clientX, ev.clientY);
    this.startX = p.x;
    this.startY = p.y;
    this.lastClientX = ev.clientX;
    this.lastClientY = ev.clientY;
    this.additive = ev.ctrlKey || ev.metaKey || ev.shiftKey;
    this.startedOnRow = !!target.closest('[data-select-key]');
    this.dragging = false;

    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
  };

  private onMouseMove = (ev: MouseEvent): void => {
    this.lastClientX = ev.clientX;
    this.lastClientY = ev.clientY;
    const p = this.toContent(ev.clientX, ev.clientY);
    if (!this.dragging) {
      if (Math.abs(p.x - this.startX) < DRAG_THRESHOLD && Math.abs(p.y - this.startY) < DRAG_THRESHOLD) return;
      this.dragging = true;
      this.lastSignature = null;
      window.getSelection()?.removeAllRanges();
      this.zone.run(() => this.marqueeStart.emit());
      this.box = document.createElement('div');
      this.box.className = 's3b-marquee';
      this.host.nativeElement.appendChild(this.box);
    }
    ev.preventDefault();
    this.update();
    this.ensureAutoScroll();
  };

  private onMouseUp = (): void => {
    const wasDragging = this.dragging;
    const clickedEmpty = !wasDragging && !this.startedOnRow;
    this.stopTracking();

    if (wasDragging) {
      const swallow = (e: MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
      };
      window.addEventListener('click', swallow, true);
      // The click (if any) is dispatched right after mouseup, before timers run.
      setTimeout(() => window.removeEventListener('click', swallow, true));
    } else if (clickedEmpty) {
      this.zone.run(() => this.marqueeChange.emit({ keys: [], additive: this.additive }));
    }
  };

  private stopTracking(): void {
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    if (this.scrollFrame !== null) cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = null;
    this.box?.remove();
    this.box = null;
    this.dragging = false;
  }

  /** Viewport point -> coordinates within the host's scrollable content. */
  private toContent(clientX: number, clientY: number): { x: number; y: number } {
    const el = this.host.nativeElement;
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - rect.left, el.clientWidth)) + el.scrollLeft;
    const y = Math.max(0, Math.min(clientY - rect.top, el.clientHeight)) + el.scrollTop;
    return { x, y };
  }

  private update(): void {
    if (!this.box) return;
    const el = this.host.nativeElement;
    const p = this.toContent(this.lastClientX, this.lastClientY);
    const left = Math.min(this.startX, p.x);
    const top = Math.min(this.startY, p.y);
    const right = Math.max(this.startX, p.x);
    const bottom = Math.max(this.startY, p.y);
    Object.assign(this.box.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${right - left}px`,
      height: `${bottom - top}px`
    });

    const hostRect = el.getBoundingClientRect();
    const keys: string[] = [];
    el.querySelectorAll<HTMLElement>('[data-select-key]').forEach((row) => {
      const r = row.getBoundingClientRect();
      const rTop = r.top - hostRect.top + el.scrollTop;
      const rLeft = r.left - hostRect.left + el.scrollLeft;
      if (rTop < bottom && rTop + r.height > top && rLeft < right && rLeft + r.width > left) {
        keys.push(row.dataset['selectKey']!);
      }
    });
    const signature = keys.join('\n');
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.zone.run(() => this.marqueeChange.emit({ keys, additive: this.additive }));
  }

  /** Keeps scrolling while the pointer is held above/below the list, even if the mouse stops moving. */
  private ensureAutoScroll(): void {
    if (this.scrollFrame !== null) return;
    const step = () => {
      this.scrollFrame = null;
      if (!this.dragging) return;
      const el = this.host.nativeElement;
      const rect = el.getBoundingClientRect();
      let dy = 0;
      if (this.lastClientY < rect.top) dy = -AUTO_SCROLL_SPEED;
      else if (this.lastClientY > rect.top + el.clientHeight) dy = AUTO_SCROLL_SPEED;
      if (!dy) return;
      const before = el.scrollTop;
      el.scrollTop += dy;
      if (el.scrollTop !== before) this.update();
      this.scrollFrame = requestAnimationFrame(step);
    };
    this.scrollFrame = requestAnimationFrame(step);
  }
}
