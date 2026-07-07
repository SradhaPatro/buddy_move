// Lazily loads the Google Maps JavaScript API (with the Places library) exactly
// once, returning a promise that resolves when window.google.maps is ready.
let loader: Promise<void> | null = null;

export function loadGoogleMaps(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  // Already present (e.g. after an HMR reload that reset this module's state).
  if ((window as any).google?.maps) return Promise.resolve();
  if (loader) return loader;

  const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;
  if (!key) return Promise.reject(new Error('VITE_GOOGLE_MAPS_API_KEY not set'));

  loader = new Promise<void>((resolve, reject) => {
    // Reuse an existing tag rather than injecting a duplicate script.
    const existing = document.getElementById('google-maps-js') as HTMLScriptElement | null;
    if (existing) {
      if ((window as any).google?.maps) return resolve();
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Failed to load Google Maps JS')));
      return;
    }
    const script = document.createElement('script');
    script.id = 'google-maps-js';
    script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places&loading=async&v=weekly`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google Maps JS'));
    document.head.appendChild(script);
  }).catch((e) => {
    // CRITICAL: a one-off load failure must not poison the singleton forever.
    // Reset so the next call (e.g. the user typing again) retries the load.
    loader = null;
    throw e;
  });
  return loader;
}

export const googleMapsEnabled = !!import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
