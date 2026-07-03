// 评分与文案核心 —— tools/build.mjs（静态生成）与 workers/forecast-worker.js（实时 API）共用。
// 🚨 这是全站唯一的评分实现：改这里会同时影响静态页和 API，改完跑 `node --test tests/`。
// （2026-07-03 抽取：此前两处各有一份副本，半球化时被迫 lockstep 双改，故合并。）

export function normalizeLon(lon) {
  return lon > 180 ? lon - 360 : lon;
}

// 在 NOAA OVATION 全球网格中找离城市最近的点（经度做 360 环绕处理）
export function nearestAurora(coordinates, city) {
  if (!coordinates.length) return { value: 0, lat: null, lon: null };
  const cityLon = city.lon < 0 ? city.lon + 360 : city.lon;
  let best = null;
  for (const point of coordinates) {
    const [lon, lat, value] = point;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(value)) continue;
    const dLat = lat - city.lat;
    const dLonRaw = Math.abs(lon - cityLon);
    const dLon = Math.min(dLonRaw, 360 - dLonRaw);
    const distance = dLat * dLat + dLon * dLon * Math.cos((city.lat * Math.PI) / 180) ** 2;
    if (!best || distance < best.distance) best = { value, lat, lon: normalizeLon(lon), distance };
  }
  return best || { value: 0, lat: null, lon: null };
}

export function scoreCity(city, auroraValue, kp, bestCloud) {
  // Math.abs：南北半球对称——南半球高纬（如 -45 的 Queenstown）与北半球同纬度同等加成
  const latitudeBoost = Math.max(0, Math.abs(city.lat) - 39) * 1.25;
  const auroraBoost = Math.min(52, auroraValue * 1.5);
  const kpBoost = Math.min(30, kp * 5.8);
  const cloudBoost = bestCloud == null ? 4 : Math.max(0, 100 - bestCloud) * 0.12;
  const score = Math.round(Math.min(99, auroraBoost + kpBoost + latitudeBoost + cloudBoost));
  return Math.max(3, score);
}

export function labelForScore(score) {
  if (score >= 72) return "Great";
  if (score >= 52) return "Good";
  if (score >= 32) return "Possible";
  return "Low";
}

// 半球感知的方向词：北半球看北边地平线（oval 向赤道扩张=向南），南半球全部对调。
// 对北半球城市输出与历史版本逐字节一致。
export function directionWords(city) {
  const southern = city.lat < 0;
  return {
    horizon: southern ? "southern" : "northern",
    look: southern ? "south" : "north",
    ovalPush: southern ? "north" : "south",
    darkSites: southern ? "south of town" : "north of town",
    marginalEdge: southern ? "northern edge" : "southern edge",
  };
}

export function guidanceFor(city, score, kp, bestCloud) {
  const dir = directionWords(city);
  if (score >= 72) {
    return `Conditions are strong for ${city.name}. Find a dark ${dir.horizon} horizon and check the sky after local twilight.`;
  }
  if (score >= 52) {
    return `${city.name} has a reasonable chance if clouds stay low and the aurora oval pushes ${dir.ovalPush}. Dark sites ${dir.darkSites} help.`;
  }
  if (score >= 32) {
    return `Aurora is possible near ${city.name}, but it may require a camera, a darker location, or a stronger-than-forecast Kp pulse.`;
  }
  if (kp >= 5) {
    return `${city.name} is on the ${dir.marginalEdge} for this forecast. Watch updates, but do not expect easy naked-eye aurora.`;
  }
  if (bestCloud != null && bestCloud > 70) {
    return `Cloud cover is the main problem for ${city.name}. Check again if the sky clears later tonight.`;
  }
  return `${city.name} is unlikely tonight under the current NOAA forecast. Higher latitude cities have a better setup.`;
}
