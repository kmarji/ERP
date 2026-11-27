// The phone's position for a clock-in, and the reason in plain words when the browser will not give one.
export type Fix = { lat: number; lng: number; accuracy: number };

const read = (p: GeolocationPosition): Fix => ({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy });

// Best GPS fix within `ms`: watch until the reading is good (30 m) or time runs out, then use the most accurate one seen.
// A single getCurrentPosition often returns a coarse or cached fix, which is why a second try used to "work".
export function position(ms = 12_000) {
  return new Promise<Fix>((ok, no) => {
    if (!navigator.geolocation) return no(new Error('no geolocation'));
    let best: GeolocationPosition | null = null;
    const done = () => { navigator.geolocation.clearWatch(id); clearTimeout(timer); best ? ok(read(best)) : no(new Error('no fix')); };
    const id = navigator.geolocation.watchPosition((p) => { if (!best || p.coords.accuracy < best.coords.accuracy) best = p; if (p.coords.accuracy <= 30) done(); }, (e) => { if (!best) { navigator.geolocation.clearWatch(id); clearTimeout(timer); no(e); } }, { enableHighAccuracy: true, maximumAge: 0, timeout: ms });
    const timer = setTimeout(done, ms);
  });
}

// Phones often fail the high-accuracy GPS watch (indoors, cold start); fall back to a coarse network/Wi-Fi fix before giving up.
const coarse = () => new Promise<Fix>((ok, no) => navigator.geolocation.getCurrentPosition((p) => ok(read(p)), no, { enableHighAccuracy: false, maximumAge: 60_000, timeout: 15_000 }));

const why = (e: any) =>
  !window.isSecureContext ? 'This page is not on https, so the browser cannot share your location.'
  : e?.code === 1 ? 'Location is blocked for this website. Allow it in the browser (iPhone: Settings > Privacy & Security > Location Services > Safari Websites > While Using the App). If you opened the link inside WhatsApp or another app, open it in Safari or Chrome instead. · الموقع محظور لهذا الموقع: اسمح به من إعدادات المتصفح، وافتح الرابط في Safari أو Chrome'
  : e?.code === 2 ? 'Your phone could not determine its position; turn on Location/GPS. · تعذر تحديد موقعك: شغّل خدمة الموقع'
  : 'Locating timed out; move near a window and try again. · انتهت مهلة تحديد الموقع: اقترب من نافذة وحاول مجدداً';

export async function locate(): Promise<{ fix?: Fix; problem?: string }> {
  try { return { fix: await position().catch(() => coarse()) }; } catch (e) { return { problem: why(e) }; }
}
