import { nearestAurora, normalizeLon } from "./forecast-core.mjs";

const LONGITUDE_COUNT = 360;
const MIN_LATITUDE = -90;
const MAX_LATITUDE = 90;
const LATITUDE_COUNT = MAX_LATITUDE - MIN_LATITUDE + 1;
const GRID_POINT_COUNT = LONGITUDE_COUNT * LATITUDE_COUNT;

function wrapLongitude(lon) {
  return ((lon % LONGITUDE_COUNT) + LONGITUDE_COUNT) % LONGITUDE_COUNT;
}

function slotFor(lon, lat) {
  return lon * LATITUDE_COUNT + (lat - MIN_LATITUDE);
}

function integerCandidates(value, minimum, maximum) {
  const lower = Math.max(minimum, Math.min(maximum, Math.floor(value)));
  const upper = Math.max(minimum, Math.min(maximum, Math.ceil(value)));
  return lower === upper ? [lower] : [lower, upper];
}

export function buildAuroraGridIndex(coordinates) {
  const pointsBySlot = new Array(GRID_POINT_COUNT);
  let indexedPointCount = 0;

  for (let order = 0; order < coordinates.length; order += 1) {
    const point = coordinates[order];
    if (!Array.isArray(point) || point.length < 3) continue;
    const [rawLon, lat, value] = point;
    if (!Number.isFinite(rawLon) || !Number.isFinite(lat) || !Number.isFinite(value)) continue;
    if (!Number.isInteger(rawLon) || !Number.isInteger(lat) || lat < MIN_LATITUDE || lat > MAX_LATITUDE) continue;

    const lon = wrapLongitude(rawLon);
    const slot = slotFor(lon, lat);
    if (pointsBySlot[slot]) continue;
    pointsBySlot[slot] = { point, order };
    indexedPointCount += 1;
  }

  return { pointsBySlot, indexedPointCount };
}

export function nearestAuroraFromGrid(gridIndex, coordinates, city) {
  if (!gridIndex || !Number.isFinite(city?.lat) || !Number.isFinite(city?.lon)) {
    return nearestAurora(coordinates, city);
  }

  const cityLon = city.lon < 0 ? city.lon + LONGITUDE_COUNT : city.lon;
  const longitudeCandidates = integerCandidates(cityLon, 0, LONGITUDE_COUNT).map((lon) => wrapLongitude(lon));
  const latitudeCandidates = integerCandidates(city.lat, MIN_LATITUDE, MAX_LATITUDE);
  const candidates = [];

  for (const lon of new Set(longitudeCandidates)) {
    for (const lat of latitudeCandidates) {
      const indexed = gridIndex.pointsBySlot[slotFor(lon, lat)];
      if (!indexed) return nearestAurora(coordinates, city);
      candidates.push(indexed);
    }
  }

  let best = null;
  for (const { point, order } of candidates) {
    const [lon, lat, value] = point;
    const dLat = lat - city.lat;
    const dLonRaw = Math.abs(lon - cityLon);
    const dLon = Math.min(dLonRaw, LONGITUDE_COUNT - dLonRaw);
    const distance = dLat * dLat + dLon * dLon * Math.cos((city.lat * Math.PI) / 180) ** 2;
    if (!best || distance < best.distance || (distance === best.distance && order < best.order)) {
      best = { value, lat, lon: normalizeLon(lon), distance, order };
    }
  }

  if (!best) return nearestAurora(coordinates, city);
  const { order: _order, ...result } = best;
  return result;
}
