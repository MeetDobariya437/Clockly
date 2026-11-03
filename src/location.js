import { invoke } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { CONFIG } from './config.js';

const isTauri = typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);

let cachedLocation = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // Cache for 5 minutes

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function getLocation(forceFresh = false) {
  const now = Date.now();
  if (!forceFresh && cachedLocation && (now - cacheTimestamp < CACHE_TTL_MS)) {
    return cachedLocation;
  }

  // 1. Mock mode
  if (CONFIG.MOCK) {
    await new Promise((r) => setTimeout(r, 200));
    cachedLocation = {
      lat: 23.06433,
      lng: 72.67752,
      accuracy: 10,
      source: 'mock',
    };
    cacheTimestamp = Date.now();
    return cachedLocation;
  }

  // 2. Try Native OS Geolocation (Windows Geolocator via Rust with 3s hard timeout)
  if (isTauri) {
    try {
      const loc = await withTimeout(invoke('get_location'), 3000);
      if (loc && typeof loc.lat === 'number' && typeof loc.lng === 'number') {
        cachedLocation = loc;
        cacheTimestamp = Date.now();
        return loc;
      }
    } catch (err) {
      console.warn('Native geolocation failed or timed out:', err);
    }
  }

  // 3. Fallback to WebView navigator.geolocation with 3s timeout
  if (typeof navigator !== 'undefined' && navigator.geolocation) {
    try {
      const loc = await withTimeout(
        new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              resolve({
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                accuracy: pos.coords.accuracy,
                source: 'webview',
              });
            },
            (error) => {
              reject(error);
            },
            {
              enableHighAccuracy: true,
              timeout: 2500,
              maximumAge: 60000,
            }
          );
        }),
        3000
      );
      if (loc && typeof loc.lat === 'number') {
        cachedLocation = loc;
        cacheTimestamp = Date.now();
        return loc;
      }
    } catch (browserErr) {
      console.warn('Webview geolocation failed or timed out:', browserErr);
    }
  }

  // 4. Fallback to IP-based lookup if allowed
  if (CONFIG.ALLOW_IP_FALLBACK) {
    try {
      const fetchImpl = isTauri
        ? tauriFetch
        : (typeof window !== 'undefined' && window.fetch ? window.fetch.bind(window) : fetch);
      const resp = await withTimeout(
        fetchImpl('https://ipwho.is/', { method: 'GET' }),
        3000
      );
      if (resp && resp.ok) {
        const data = await resp.json();
        if (data && data.success && typeof data.latitude === 'number') {
          const loc = {
            lat: data.latitude,
            lng: data.longitude,
            accuracy: 5000,
            source: 'ip',
          };
          cachedLocation = loc;
          cacheTimestamp = Date.now();
          return loc;
        }
      }
    } catch (ipErr) {
      console.warn('IP location fallback failed:', ipErr);
    }

    // Default safe fallback from endpoints.txt if all network lookups time out
    const officeFallback = {
      lat: 23.064330396148357,
      lng: 72.67752629185092,
      accuracy: 25,
      source: 'office_default',
    };
    cachedLocation = officeFallback;
    cacheTimestamp = Date.now();
    return officeFallback;
  }

  const error = new Error(
    'Location is off. Turn on Windows Location services (Settings > Privacy > Location) and try again.'
  );
  error.isLocationError = true;
  throw error;
}

export function clearLocationCache() {
  cachedLocation = null;
  cacheTimestamp = 0;
}
