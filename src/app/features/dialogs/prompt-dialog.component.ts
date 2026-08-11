import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';

/**
 * Small reusable modal used for New Folder / Rename / Share-URL-result prompts,
 * so we don't pull in a full dialog/modal library just for these three cases.
 */
export interface PromptDialogChoice {
  id: string;
  label: string;
  icon?: string;
}

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
  /** When set, the dialog shows a list of choice buttons instead of the text input/confirm row - used for "Signed vs. unsigned URL" style pickers. */
  @Input() choices?: PromptDialogChoice[];
  @Output() confirmed = new EventEmitter<string>();
  @Output() cancelled = new EventEmitter<void>();
  @Output() choiceSelected = new EventEmitter<string>();

  onConfirm(): void {
    this.confirmed.emit(this.value);
  }

  onCancel(): void {
    this.cancelled.emit();
  }

  selectChoice(id: string): void {
    this.choiceSelected.emit(id);
  }

  copyToClipboard(): void {
    navigator.clipboard?.writeText(this.value);
  }
}
