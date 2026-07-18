import { CommonModule } from '@angular/common';
import { AfterViewInit, Component, ElementRef, EventEmitter, HostListener, Input, Output, signal } from '@angular/core';

export interface ContextMenuItem {
  type: 'item';
  id: string;
  label: string;
  icon: string;
  colorClass?: string;
  danger?: boolean;
}
export interface ContextMenuDivider {
  type: 'divider';
}
export type ContextMenuEntry = ContextMenuItem | ContextMenuDivider;

/**
 * Generic positioned popup menu (right-click style). Renders at the given
 * viewport coordinates, clamped so it never spills off-screen, and closes
 * itself on an outside click or Escape - the caller just needs to react to
 * `itemSelected`/`closed` and stop rendering it.
 */
@Component({
  selector: 'app-context-menu',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './context-menu.component.html',
  styleUrl: './context-menu.component.scss'
})
export class ContextMenuComponent implements AfterViewInit {
  @Input() x = 0;
  @Input() y = 0;
  @Input() items: ContextMenuEntry[] = [];
  @Output() itemSelected = new EventEmitter<string>();
  @Output() closed = new EventEmitter<void>();

  readonly left = signal(0);
  readonly top = signal(0);

  constructor(private elRef: ElementRef<HTMLElement>) {}

  ngAfterViewInit(): void {
    // Clamp so the menu never renders partially off the window edge.
    const el = this.elRef.nativeElement.querySelector<HTMLElement>('.ctx-menu');
    if (!el) {
      this.left.set(this.x);
      this.top.set(this.y);
      return;
    }
    const rect = el.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - rect.width - 4);
    const maxTop = Math.max(0, window.innerHeight - rect.height - 4);
    this.left.set(Math.min(this.x, maxLeft));
    this.top.set(Math.min(this.y, maxTop));
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(ev: MouseEvent): void {
    // Use composedPath() (the propagation path captured at dispatch time)
    // rather than a live Node.contains() check - a menu item's own click
    // handler can trigger a re-render mid-bubble that detaches ev.target
    // before this listener runs, which would make contains() wrongly report
    // "outside" and close the menu the same click that chose an action.
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [ev.target as Node];
    if (!path.includes(this.elRef.nativeElement)) {
      this.closed.emit();
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closed.emit();
  }

  select(item: ContextMenuItem): void {
    this.itemSelected.emit(item.id);
    this.closed.emit();
  }
}
