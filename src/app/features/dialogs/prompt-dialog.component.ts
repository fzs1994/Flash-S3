import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';

/**
 * Small reusable modal used for New Folder / Rename / Share-URL-result prompts,
 * so we don't pull in a full dialog/modal library just for these three cases.
 */
@Component({
  selector: 'app-prompt-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './prompt-dialog.component.html',
  styleUrl: './prompt-dialog.component.scss'
})
export class PromptDialogComponent {
  @Input() title = '';
  @Input() label = '';
  @Input() value = '';
  @Input() readonlyValue = false;
  @Input() confirmLabel = 'OK';
  @Output() confirmed = new EventEmitter<string>();
  @Output() cancelled = new EventEmitter<void>();

  onConfirm(): void {
    this.confirmed.emit(this.value);
  }

  onCancel(): void {
    this.cancelled.emit();
  }

  copyToClipboard(): void {
    navigator.clipboard?.writeText(this.value);
  }
}
