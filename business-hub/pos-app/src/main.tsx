import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { OverrideProvider } from './components/Override';
import './index.css';
import { I18nProvider } from './lib/i18n';
import { startBackground } from './lib/offline';
import { SessionProvider } from './lib/session';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

startBackground();
// The service worker only caches the app shell so the tablet can start without a connection; production builds only.
// the native app bundles its assets, so the service worker is only for the browser/PWA build
if (import.meta.env.PROD && 'serviceWorker' in navigator && !(window as any).Capacitor?.isNativePlatform?.()) window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js'));

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <SessionProvider>
          <OverrideProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </OverrideProvider>
        </SessionProvider>
      </I18nProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
