import { Injectable, effect, signal, untracked } from '@angular/core';
import { AppSettingsService } from './app-settings.service';

const STORAGE_KEY = 's3b:theme';
type Theme = 'light' | 'dark';

function loadInitialTheme(): Theme {
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  }
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

/**
 * Applies the `dark` class to <html> (so every component's CSS variables,
 * which cascade from :root, pick up the dark palette automatically) and
 * persists the choice across restarts.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly theme = signal<Theme>(loadInitialTheme());

  constructor(private appSettings: AppSettingsService) {
    // The persisted choice (shared by every window through the main process) wins over this window's stored value.
    effect(
      () => {
        const saved = this.appSettings.settings().theme;
        if (saved === 'light' || saved === 'dark') untracked(() => this.theme.set(saved));
      },
      { allowSignalWrites: true }
    );
    // The settings window is a separate renderer - follow theme changes made there (and vice versa).
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key === STORAGE_KEY && (e.newValue === 'light' || e.newValue === 'dark')) this.theme.set(e.newValue);
      });
    }
    effect(() => {
      const mode = this.theme();
      if (typeof document !== 'undefined') {
        document.documentElement.classList.toggle('dark', mode === 'dark');
      }
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, mode);
      }
    });
  }

  setTheme(mode: Theme): void {
    this.theme.set(mode);
    // Persist through the main process so the other window follows (localStorage isn't shared between them).
    this.appSettings.update({ theme: mode }).catch(() => {});
  }

  toggle(): void {
    this.setTheme(this.theme() === 'dark' ? 'light' : 'dark');
  }
}
