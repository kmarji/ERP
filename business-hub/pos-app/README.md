# Business Hub tablet POS

Touch-first POS for 10-inch tablets (landscape, English/Arabic RTL). Separate Vite app; talks to the same API.

- Run: `npm install && npm run dev` (port 5174). `VITE_API_URL` defaults to `http://localhost:3000`. Production: `npm run build && npm run preview`.
- Sign in, pick the branch (Branch screen), open a shift, then take orders. `/kds` is the kitchen display.
- Device enrollment: a manager creates the tablet in the back office (`POST /pos/devices`, returns `id` and a one-time `key`). Paste both on the Branch screen; this also downloads the offline menu.
- Offline: connectivity is tracked from real requests. Offline, the tablet sells from the cached menu and only takes cash for dine-in, takeaway and pickup (the server's `capabilities` list is shown for everything blocked). Categories and tables come from the cached bundle.
- Offline sales are stored in IndexedDB with a provisional receipt and uploaded to `POST /pos/sync` when the connection returns (also automatically every 15 s, or "Sync now"). Applied and duplicate sales are cleared.
- Rejected sales stay on the Offline sales screen with the server's reason; they are never dropped. A manager retries them in the back office.
- After login (with a device configured) the app swaps its token for a 12h session via `POST /pos/session`, so long offline periods do not expire it. Sync also needs the device key.
- A service worker (production build only) caches the app shell so the tablet starts without a connection.

## iOS and Android app (Capacitor)
The same code ships as a native app (`jo.businesshub.pos`, landscape only) via Capacitor; the web assets are bundled, so there is no service worker in the native build and the offline outbox (IndexedDB) works as in the browser.

1. Point it at your real API: `VITE_API_URL=https://api.yourdomain.com npm run native:sync`. `localhost` means the tablet itself, so use a reachable https URL (an `http://` LAN address needs Android cleartext enabled and an iOS ATS exception).
2. Add `https://localhost,capacitor://localhost` to the backend `CORS_ORIGIN` (already in `docker/docker-compose.yml`).
3. Android: `npm run android` opens Android Studio (needs the Android SDK); build a signed APK/AAB from there.
4. iOS: `npm run ios` opens Xcode (macOS only, with CocoaPods); set your signing team, then run or archive.

Not built or run on a device yet: this machine has neither the Android SDK nor Xcode. Icons and splash are Capacitor defaults; add yours with `@capacitor/assets`. Printers and card terminals are not wired in the native shell.

### Receipt printer (network ESC/POS) and card terminal
- **Printer:** Branch screen, "Receipt printer": enter the printer's LAN IP (port 9100, 58 or 80 mm), Save, then Test print. The Print button on a receipt then sends it straight to the printer. The receipt is drawn as an image, so Arabic prints on any ESC/POS printer without code-page setup. The browser build keeps using the system print dialog. Give the printer a fixed IP (DHCP reservation). Printing is on demand; there is no auto-print or cash-drawer kick yet.
- **Card terminal:** standalone mode. The cashier takes the card on the bank's terminal and keys the approval code on the Pay screen (now required for card/digital, so settlements can be matched later). Declines are recorded the same way. This is not an integrated terminal; a vendor SDK would plug into the backend `PosTerminalAdapter`.
- Needs Capacitor 7 (Android Studio with a recent Android Gradle plugin, Xcode 16+). Printing was tested only as far as the ESC/POS encoder; no real printer was available.
