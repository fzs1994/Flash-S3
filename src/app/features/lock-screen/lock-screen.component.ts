import { CommonModule } from '@angular/common';
import { Component, NgZone, OnDestroy, OnInit, effect, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AppSettingsService } from '../../core/services/app-settings.service';
import { ElectronService } from '../../core/services/electron.service';

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'];

/**
 * Idle lock: after "Lock after N minutes" without input the whole UI is
 * covered until the PIN is entered. Transfers keep running underneath.
 */
@Component({
  selector: 'app-lock-screen',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="lock overlay" *ngIf="locked()">
      <div class="box">
        <i class="fi fi-sr-lock ic-blue big"></i>
        <h3>Flash S3 is locked</h3>
        <input
          type="password"
          [(ngModel)]="pin"
          (keydown.enter)="unlock()"
          placeholder="Enter PIN"
          autocomplete="off"
          autofocus
        />
        <p class="err" *ngIf="error()">{{ error() }}</p>
        <button (click)="unlock()" [disabled]="!pin || busy()">Unlock</button>
      </div>
    </div>
  `,
  styles: [
    `
      .lock {
        position: fixed;
        inset: 0;
        z-index: 1000;
        background: var(--s3b-surface);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .box {
        width: 280px;
        text-align: center;
        color: var(--s3b-text);
      }
      .big {
        font-size: 34px;
      }
      h3 {
        margin: 10px 0 14px;
        font-size: 15px;
      }
      input {
        width: 100%;
        box-sizing: border-box;
        padding: 8px 10px;
        border: 1px solid var(--s3b-border);
        border-radius: 3px;
        background: var(--s3b-surface);
        color: var(--s3b-text);
        font-size: 14px;
        text-align: center;
      }
      button {
        margin-top: 12px;
        padding: 6px 18px;
        border: none;
        border-radius: 3px;
        background: var(--s3b-blue);
        color: #fff;
        cursor: pointer;
      }
      button:disabled {
        opacity: 0.6;
      }
      .err {
        margin: 8px 0 0;
        font-size: 12px;
        color: var(--s3b-red);
      }
    `
  ]
})
export class LockScreenComponent implements OnInit, OnDestroy {
  readonly locked = signal(false);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  pin = '';

  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onActivity = () => this.resetTimer();

  constructor(
    private settings: AppSettingsService,
    private electron: ElectronService,
    private zone: NgZone
  ) {
    // Re-arm whenever the preference changes (a new timeout, or the PIN being removed).
    effect(() => {
      this.settings.settings().lockAfterMinutes;
      untracked(() => this.resetTimer());
    });
  }

  ngOnInit(): void {
    // Activity listeners run outside Angular so mousemove doesn't trigger change detection.
    this.zone.runOutsideAngular(() => {
      for (const ev of ACTIVITY_EVENTS) document.addEventListener(ev, this.onActivity, { passive: true, capture: true });
    });
  }

  ngOnDestroy(): void {
    for (const ev of ACTIVITY_EVENTS) document.removeEventListener(ev, this.onActivity, { capture: true });
    if (this.timer) clearTimeout(this.timer);
  }

  private resetTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const minutes = this.settings.settings().lockAfterMinutes;
    if (!minutes || this.locked()) return;
    this.timer = setTimeout(() => this.zone.run(() => this.locked.set(true)), minutes * 60_000);
  }

  async unlock(): Promise<void> {
    if (!this.pin) return;
    this.busy.set(true);
    try {
      const ok = await this.electron.api.lock.verify(this.pin);
      if (ok) {
        this.locked.set(false);
        this.error.set(null);
        this.resetTimer();
      } else {
        this.error.set('Incorrect PIN.');
      }
    } finally {
      this.pin = '';
      this.busy.set(false);
    }
  }
}
