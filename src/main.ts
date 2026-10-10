import { bootstrapApplication } from '@angular/platform-browser';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import 'zone.js';
import { AppComponent } from './app/app.component';
import { routes } from './app/app.routes';
import { SettingsWindowComponent } from './app/features/settings-window/settings-window.component';

// The General Settings window is a second BrowserWindow loading this same bundle with #/settings.
const root = location.hash.startsWith('#/settings') ? SettingsWindowComponent : AppComponent;

bootstrapApplication(root, {
  providers: [provideAnimations(), provideRouter(routes)]
}).catch(err => console.error(err));
