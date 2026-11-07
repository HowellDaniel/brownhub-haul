/**
 * BrownHub Haul — service area data.
 *
 * A place is a named, geolocated point the crew can reach. `kind` drives the
 * UI grouping (where luggage leaves from vs. where it lands) and `tier` drives
 * the pickup-availability rules in core/pricing.mjs.
 *
 * Coordinates are decimal degrees (WGS84). Distances are straight-line and are
 * inflated by ROAD_FACTOR in pricing.mjs, so small errors here shift a quote by
 * a few cedis rather than making it wrong.
 */

export const HOME_TIER = "home"; // residential / office collection
export const HUB_TIER = "hub"; // staffed counter, cheaper & always open
export const AWAY_TIER = "away"; // traveller's destination

export const PLACES = [
  // ——— Accra collection points (home / office) ———
  { id: "kokomlemle", name: "Kokomlemle", area: "Greater Accra", lat: 5.5708, lng: -0.2048, tier: HOME_TIER, base: true },
  { id: "accra-new-town", name: "Accra New Town", area: "Greater Accra", lat: 5.607, lng: -0.193, tier: HOME_TIER },
  { id: "osu", name: "Osu", area: "Greater Accra", lat: 5.556, lng: -0.1883, tier: HOME_TIER },
  { id: "cantonments", name: "Cantonments", area: "Greater Accra", lat: 5.5686, lng: -0.1741, tier: HOME_TIER },
  { id: "airport-residential", name: "Airport Residential", area: "Greater Accra", lat: 5.6037, lng: -0.166, tier: HOME_TIER },
  { id: "east-legon", name: "East Legon", area: "Greater Accra", lat: 5.6357, lng: -0.163, tier: HOME_TIER },
  { id: "dome", name: "Dome", area: "Greater Accra", lat: 5.6447, lng: -0.2266, tier: HOME_TIER },
  { id: "circle", name: "Kwame Nkrumah Circle", area: "Greater Accra", lat: 5.5731, lng: -0.2048, tier: HOME_TIER },
  { id: "kanshie", name: "Kanshie / Adenta", area: "Greater Accra", lat: 5.6173, lng: -0.1936, tier: HOME_TIER },
  { id: "themelincoln", name: "Theme / Lincoln", area: "Greater Accra", lat: 5.6239, lng: -0.0949, tier: HOME_TIER },

  // ——— Staffed counters ———
  { id: "kotoka", name: "Kotoka Intl. Airport (KIA)", area: "Departures hall", lat: 5.6053, lng: -0.1667, tier: HUB_TIER, counter: "BrownHub desk, Level 1" },
  { id: "tema-harbour", name: "Tema Community 1", area: "Greater Accra", lat: 5.6698, lng: -0.0172, tier: HUB_TIER, counter: "BrownHub counter" },

  // ——— Destinations outside Greater Accra ———
  { id: "cape-coast", name: "Cape Coast", area: "Central Region", lat: 5.1053, lng: -1.2466, tier: AWAY_TIER },
  { id: "kmasoku", name: "Kumasi (Ahodwo)", area: "Ashanti Region", lat: 6.6795, lng: -1.6371, tier: AWAY_TIER },
  { id: "kinte", name: "Kumasi (Kinteleya)", area: "Ashanti Region", lat: 6.7167, lng: -1.65, tier: AWAY_TIER },
  { id: "takoradi", name: "Takoradi", area: "Western Region", lat: 4.898, lng: -1.76, tier: AWAY_TIER },
  { id: "tamale", name: "Tamale", area: "Northern Region", lat: 9.4075, lng: -0.8533, tier: AWAY_TIER },
  { id: "ho", name: "Ho", area: "Volta Region", lat: 6.6019, lng: 0.4713, tier: AWAY_TIER },
  { id: "aburi", name: "Aburi", area: "Eastern Region", lat: 5.8428, lng: -0.1836, tier: AWAY_TIER },
  { id: "buipe", name: "Buipe Reserve", area: "Central Region", lat: 5.4361, lng: -0.7747, tier: AWAY_TIER },
  { id: "wli", name: "Wli Falls", area: "Volta Region", lat: 7.1478, lng: 0.5753, tier: AWAY_TIER },

  // ——— Regional capitals (international leg, quote-only) ———
  { id: "lwg", name: "Lagos (LOS)", area: "Nigeria", lat: 6.5167, lng: 3.375, tier: AWAY_TIER, intl: true },
  { id: "abj", name: "Abidjan (ABJ)", area: "Côte d'Ivoire", lat: 5.2616, lng: -3.9263, tier: AWAY_TIER, intl: true },
  { id: "lri", name: "Monrovia (Robertsfield)", area: "Liberia", lat: 6.2405, lng: -10.7449, tier: AWAY_TIER, intl: true },
  { id: "freetown", name: "Freetown (LUN)", area: "Sierra Leone", lat: 8.4822, lng: -13.2299, tier: AWAY_TIER, intl: true },
];

export const PLACE_BY_ID = Object.fromEntries(PLACES.map((p) => [p.id, p]));

/** Places luggage can leave from: home collections, staffed counters, office. */
export const ORIGINS = PLACES.filter((p) => p.tier !== AWAY_TIER);
/** Places luggage can arrive at. */
export const DESTINATIONS = PLACES.filter((p) => p.tier !== HOME_TIER);

export function getPlace(id) {
  const p = PLACE_BY_ID[id];
  if (!p) throw new Error(`unknown place: ${id}`);
  return p;
}

/**
 * Haversine distance in kilometres. Exported separately because the dashboard
 * shows the leg length and the quote must not disagree with it.
 */
export function distanceKm(a, b) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function legKm(fromId, toId) {
  return distanceKm(getPlace(fromId), getPlace(toId));
}
