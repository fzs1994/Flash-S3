import { Component, EventEmitter, Input, Output } from '@angular/core';
import { BucketInfo } from '../../core/models/models';
import { DropdownComponent, DropdownOption } from '../dropdown/dropdown.component';

/** Searchable bucket picker: a thin wrapper that feeds a bucket list into the shared dropdown. */
@Component({
  selector: 'app-bucket-select',
  standalone: true,
  imports: [DropdownComponent],
  template: `
    <app-dropdown
      [options]="options"
      [value]="value"
      [disabled]="disabled"
      [placeholder]="placeholder"
      [searchable]="true"
      searchPlaceholder="Search buckets…"
      emptyText="No buckets"
      (valueChange)="valueChange.emit($event)"
    ></app-dropdown>
  `,
  styles: [':host { display: block; min-width: 0; }']
})
export class BucketSelectComponent {
  @Input() set buckets(list: BucketInfo[]) {
    this.options = (list ?? []).map((b) => ({ value: b.name, label: b.name, icon: 'fi-sr-database' }));
  }
  @Input() value: string | null = null;
  @Input() disabled = false;
  @Input() placeholder = 'Choose a bucket…';
  @Output() valueChange = new EventEmitter<string>();

  options: DropdownOption[] = [];
}
