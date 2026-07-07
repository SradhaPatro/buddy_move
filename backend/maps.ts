import { randomUUID } from "crypto";
import type { GeoPoint } from "../src/types";
import { logger } from "./logger";
import { TtlCache, cacheGet, cacheSet } from "./cache";

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const FALLBACK_KM = 8;
const ROUTE_CACHE_TTL = 3600_000;
const GEO_CACHE_TTL = 3600_000;

export interface DistanceResult {
  km: number;
  durationMin: number;
  source: "google" | "estimate" | "haversine";
  fallbackReason?: string;
}

const cache = new TtlCache<DistanceResult>("route", { maxSize: 2000, defaultTTL: ROUTE_CACHE_TTL });
const geoCache = new TtlCache<GeoPoint>("geo", { maxSize: 2000, defaultTTL: GEO_CACHE_TTL });

export function mapsConfigured(): boolean {
  return !!process.env.GOOGLE_MAPS_API_KEY;
}

/**
 * Convert great-circle meters to estimated road km (× 1.35 winding factor).
 */
function haversineKm(origin: GeoPoint, destination: GeoPoint): number {
  const meters = haversineMeters(origin, destination);
  return Math.max(1, Math.round((meters / 1000) * 1.35 * 10) / 10);
}

/**
 * Try to geocode both addresses, then return a haversine-based road estimate.
 * Returns null if either address cannot be geocoded.
 */
async function estimateFromGeocode(origin: string, destination: string): Promise<{ km: number; durationMin: number } | null> {
  const [originGeo, destGeo] = await Promise.all([geocode(origin), geocode(destination)]);
  if (originGeo && destGeo) {
    const km = haversineKm(originGeo, destGeo);
    return { km, durationMin: Math.round(km * 3) };
  }
  return null;
}

export async function getDistanceKm(origin: string, destination: string): Promise<DistanceResult> {
  const distanceStart = Date.now();
  const o = origin?.trim().toLowerCase();
  const d = destination?.trim().toLowerCase();
  if (o && d && o === d) {
    const ms = Date.now() - distanceStart;
    if (ms > 2000) {
      console.log("ACT_TIMING: getDistanceKm slow", { origin, destination, ms, source: "identity" });
    }
    return { km: 0, durationMin: 0, source: "google" };
  }
  const key = process.env.GOOGLE_MAPS_API_KEY;
  const cacheKey = `${origin}|${destination}`.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const redisCached = await cacheGet<DistanceResult>("route", cacheKey);
  if (redisCached) {
    cache.set(cacheKey, redisCached);
    return redisCached;
  }

  // Helper: on API failure, fall back to geocode→haversine before flat constant.
  async function apiFallback(reason: string): Promise<DistanceResult> {
    const geo = await estimateFromGeocode(origin, destination);
    if (geo) {
      return { km: geo.km, durationMin: geo.durationMin, source: "haversine", fallbackReason: reason };
    }
    return { km: FALLBACK_KM, durationMin: FALLBACK_KM * 3, source: "estimate", fallbackReason: reason };
  }

  if (!key) {
    const reason = "GOOGLE_MAPS_API_KEY not configured in environment";
    logger.warn({ reason }, "[maps] API key missing");
    const result = await apiFallback(reason);
    const totalMs = Date.now() - distanceStart;
    if (totalMs > 2000) {
      console.log("ACT_TIMING: getDistanceKm slow", { origin, destination, ms: totalMs, source: result.source, fallback: true });
    }
    return result;
  }

  const keyPrefix = key.substring(0, 8);
  logger.debug({ origin, destination, keyPrefix }, "[maps] Routes API request");

  let statusCode = 0;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const fetchStart = Date.now();
    const res = await fetch(ROUTES_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "routes.distanceMeters,routes.duration",
      },
      body: JSON.stringify({
        origin: { address: origin },
        destination: { address: destination },
        travelMode: "DRIVE",
      }),
    });
    clearTimeout(timeout);
    const fetchMs = Date.now() - fetchStart;
    if (fetchMs > 2000) {
      console.log("ACT_TIMING: getDistanceKm fetch slow", { origin, destination, ms: fetchMs });
    }
    statusCode = res.status;
    const data: any = await res.json();
    if (!res.ok || data.error) {
      const errStatus = data.error?.status || res.status;
      const errMsg = data.error?.message || res.statusText || "Unknown API error";
      const reason = `Routes API returned ${errStatus}: ${errMsg}`;
      logger.warn({ httpStatus: res.status, errStatus, errMsg }, "[maps] Routes API error");
      const result = await apiFallback(reason);
      const totalMs = Date.now() - distanceStart;
      if (totalMs > 2000) {
        console.log("ACT_TIMING: getDistanceKm slow", { origin, destination, ms: totalMs, source: result.source, fallback: true });
      }
      return result;
    }
    const route = data.routes?.[0];
    if (!route?.distanceMeters) {
      const reason = `No route found between addresses "${origin}" and "${destination}"`;
      logger.warn({ origin, destination }, "[maps] No route found");
      const result = await apiFallback(reason);
      const totalMs = Date.now() - distanceStart;
      if (totalMs > 2000) {
        console.log("ACT_TIMING: getDistanceKm slow", { origin, destination, ms: totalMs, source: result.source, fallback: true });
      }
      return result;
    }
    const km = Number((route.distanceMeters / 1000).toFixed(2));
    const durationMin = route.duration ? Math.round(parseInt(route.duration, 10) / 60) : Math.round(km * 3);
    const result: DistanceResult = { km, durationMin, source: "google" };
    cache.set(cacheKey, result);
    await cacheSet("route", cacheKey, result, ROUTE_CACHE_TTL);
    const totalMs = Date.now() - distanceStart;
    if (totalMs > 2000) {
      console.log("ACT_TIMING: getDistanceKm slow", { origin, destination, ms: totalMs, source: result.source, fallback: false });
    }
    logger.info({ km, durationMin, origin, destination }, "[maps] Routes API success");
    return result;
  } catch (e: any) {
    clearTimeout(timeout);
    const reason = `Routes API request failed: ${e?.message || e} (HTTP ${statusCode || 0})`;
    logger.error({ err: e, statusCode }, "[maps] Routes API request failed");
    const result = await apiFallback(reason);
    const totalMs = Date.now() - distanceStart;
    if (totalMs > 2000) {
      console.log("ACT_TIMING: getDistanceKm slow", { origin, destination, ms: totalMs, source: result.source, fallback: true });
    }
    return result;
  }
}

export async function geocode(address: string): Promise<GeoPoint | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key || !address) return null;
  const ck = address.trim().toLowerCase();
  const hit = geoCache.get(ck);
  if (hit) return hit;

  const redisHit = await cacheGet<GeoPoint>("geo", ck);
  if (redisHit) {
    geoCache.set(ck, redisHit);
    return redisHit;
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`${GEOCODE_URL}?address=${encodeURIComponent(address)}&key=${key}`, { signal: ctrl.signal });
    clearTimeout(t);
    const data: any = await res.json();
    if (data.status !== "OK" || !data.results?.length) {
      logger.warn({ address, geocodeStatus: data.status, error: data.error_message }, "[maps] geocode failed");
      return null;
    }
    const loc = data.results[0].geometry.location;
    const pt: GeoPoint = { lat: loc.lat, lng: loc.lng };
    geoCache.set(ck, pt);
    await cacheSet("geo", ck, pt, GEO_CACHE_TTL);
    return pt;
  } catch (e: any) {
    clearTimeout(t);
    logger.warn({ err: e }, "[maps] geocode request failed");
    return null;
  }
}

export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}
