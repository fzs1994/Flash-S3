import { CommonModule } from '@angular/common';
import { Component, ElementRef, EventEmitter, HostBinding, HostListener, Input, Output, ViewChild, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

export interface DropdownOption {
  value: any;
  label: string;
  icon?: string;
}

/**
 * App-wide replacement for the native <select>: a button that opens a floating
 * menu (optionally with a search box, per-option icons and a tick on the
 * current value). The menu is position:fixed so scrolling / overflow:hidden
 * parents such as dialogs and panes never clip it.
 */
@Component({
  selector: 'app-dropdown',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './dropdown.component.html',
  styleUrl: './dropdown.component.scss'
})
export class DropdownComponent {
  @Input() options: DropdownOption[] = [];
  @Input() value: any = null;
  @Input() placeholder = 'Select…';
  @Input() disabled = false;
  @Input() searchable = false;
  @Input() searchPlaceholder = 'Search…';
  @Input() emptyText = 'No options';
  /** Icon class shown at the start of the trigger, e.g. 'fi-sr-filter'. */
  @Input() triggerIcon = '';
  /** Which edge of the trigger the menu lines up with. */
  @Input() align: 'left' | 'right' = 'left';
  /** Highlights the trigger as "active" (e.g. a filter is applied). */
  @Input() active = false;
  /** Compact = shrink-to-fit trigger instead of filling its container. */
  @Input() compact = false;
  @Output() valueChange = new EventEmitter<any>();

  @ViewChild('trigger') trigger?: ElementRef<HTMLButtonElement>;
  @ViewChild('searchInput') set searchInput(ref: ElementRef<HTMLInputElement> | undefined) {
    if (ref) setTimeout(() => ref.nativeElement.focus());
  }

  /** Without a search box, focus the list itself so arrow keys / Enter / Esc work. */
  @ViewChild('list') set list(ref: ElementRef<HTMLElement> | undefined) {
    if (ref && !this.searchable) setTimeout(() => ref.nativeElement.focus());
  }
  @HostBinding('class.compact') get compactClass(): boolean {
    return this.compact;
  }

  readonly open = signal(false);
  readonly menuStyle = signal<Record<string, string>>({});
  search = '';
  highlighted = 0;

  constructor(private host: ElementRef<HTMLElement>) {}

  get selected(): DropdownOption | undefined {
    return this.options.find((o) => o.value === this.value);
  }

  get filtered(): DropdownOption[] {
    const q = this.search.trim().toLowerCase();
    return q ? this.options.filter((o) => o.label.toLowerCase().includes(q)) : this.options;
  }

  toggle(): void {
    if (this.disabled) return;
    if (this.open()) {
      this.close();
      return;
    }
    const rect = this.trigger!.nativeElement.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < 240 && rect.top > spaceBelow;
    const minWidth = Math.max(rect.width, 170);
    this.menuStyle.set({
      minWidth: `${minWidth}px`,
      ...(this.align === 'right' ? { right: `${window.innerWidth - rect.right}px` } : { left: `${rect.left}px` }),
      ...(openUp ? { bottom: `${window.innerHeight - rect.top + 6}px` } : { top: `${rect.bottom + 6}px` }),
      maxHeight: `${Math.max(160, Math.min(320, (openUp ? rect.top : spaceBelow) - 16))}px`
    });
    this.search = '';
    this.highlighted = Math.max(0, this.options.findIndex((o) => o.value === this.value));
    this.open.set(true);
  }

  close(): void {
    this.open.set(false);
  }

  choose(option: DropdownOption): void {
    this.valueChange.emit(option.value);
    this.close();
  }

  onKey(ev: KeyboardEvent): void {
    const list = this.filtered;
    if (ev.key === 'ArrowDown') {
      this.highlighted = Math.min(list.length - 1, this.highlighted + 1);
      ev.preventDefault();
    } else if (ev.key === 'ArrowUp') {
      this.highlighted = Math.max(0, this.highlighted - 1);
      ev.preventDefault();
    } else if (ev.key === 'Enter') {
      if (list[this.highlighted]) this.choose(list[this.highlighted]);
      ev.preventDefault();
    } else if (ev.key === 'Escape') {
      // Close just this menu, not a dialog that may be hosting it.
      ev.stopPropagation();
      this.close();
      this.trigger?.nativeElement.focus();
    }
  }

  @HostListener('document:mousedown', ['$event'])
  onDocumentMouseDown(ev: MouseEvent): void {
    if (this.open() && !this.host.nativeElement.contains(ev.target as Node)) this.close();
  }

  @HostListener('window:resize')
  @HostListener('window:blur')
  onViewportChange(): void {
    this.close();
  }
}
