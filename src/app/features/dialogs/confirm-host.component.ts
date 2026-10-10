import { CommonModule } from '@angular/common';
import { Component, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ConfirmService } from '../../core/services/confirm.service';

/** Renders ConfirmService's type-to-confirm dialog; mounted once in AppComponent. */
@Component({
  selector: 'app-confirm-host',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="overlay" *ngIf="confirm.typed() as req" (click)="cancel()">
      <div class="box" (click)="$event.stopPropagation()">
        <h3><i class="fi fi-sr-triangle-warning ic-red"></i> {{ req.title }}</h3>
        <p>{{ req.message }}</p>
        <label>
          Type <code>{{ req.phrase }}</code> to confirm
        </label>
        <input
          #field
          type="text"
          autofocus
          [(ngModel)]="typedValue"
          (keydown.enter)="submit(req.phrase)"
          autocomplete="off"
          spellcheck="false"
        />
        <div class="actions">
          <button (click)="cancel()">Cancel</button>
          <button class="danger" [disabled]="typedValue !== req.phrase" (click)="submit(req.phrase)">Delete</button>
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      .overlay {
        position: fixed;
        inset: 0;
        background: var(--s3b-overlay);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 90;
      }
      .box {
        width: 400px;
        background: var(--s3b-surface);
        color: var(--s3b-text);
        border-radius: 6px;
        padding: 20px;
        box-shadow: 0 8px 30px var(--s3b-shadow);
      }
      h3 {
        margin: 0 0 10px;
        font-size: 14px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      p {
        margin: 0 0 12px;
        font-size: 12px;
        color: var(--s3b-muted);
      }
      label {
        display: block;
        font-size: 12px;
        margin-bottom: 4px;
      }
      code {
        font-weight: 700;
        user-select: all;
      }
      input {
        width: 100%;
        box-sizing: border-box;
        padding: 6px 8px;
        border: 1px solid var(--s3b-border);
        border-radius: 3px;
        background: var(--s3b-surface);
        color: var(--s3b-text);
        font-size: 13px;
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 16px;
      }
      button {
        padding: 6px 12px;
        border: 1px solid var(--s3b-border);
        border-radius: 3px;
        background: var(--s3b-surface);
        color: var(--s3b-text);
        cursor: pointer;
      }
      button.danger {
        background: var(--s3b-red);
        border-color: var(--s3b-red);
        color: #fff;
      }
      button:disabled {
        opacity: 0.5;
        cursor: default;
      }
    `
  ]
})
export class ConfirmHostComponent {
  typedValue = '';

  constructor(public confirm: ConfirmService) {}

  submit(phrase: string): void {
    if (this.typedValue !== phrase) return;
    this.typedValue = '';
    this.confirm.resolveTyped(true);
  }

  cancel(): void {
    this.typedValue = '';
    this.confirm.resolveTyped(false);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.confirm.typed()) this.cancel();
  }
}
