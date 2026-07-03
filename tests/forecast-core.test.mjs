// lib/forecast-core.mjs 的行为锁定测试。跑法：node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { scoreCity, labelForScore, directionWords, guidanceFor, nearestAurora, normalizeLon } from "../lib/forecast-core.mjs";

test("scoreCity: 北半球公式与历史版本一致（恒等性锚点）", () => {
  // 旧公式 Math.max(0, lat - 39) * 1.25 对正纬度的期望值，抽固定样本锁死
  const fairbanks = { name: "Fairbanks", lat: 64.8378, lon: -147.7164 };
  // latBoost=32.297, auroraBoost=30, kpBoost=17.4, cloudBoost=9.6 → round(89.3)=89
  assert.equal(scoreCity(fairbanks, 20, 3, 20), 89);
  const calgary = { name: "Calgary", lat: 51.0501, lon: -114.0853 };
  // latBoost=15.063, aurora=0, kp=11.6, cloud(null)=4 → round(30.66)=31
  assert.equal(scoreCity(calgary, 0, 2, null), 31);
});

test("scoreCity: 南北半球同纬度同分（对称性）", () => {
  const north = { name: "N", lat: 45.03, lon: 168.66 };
  const south = { name: "S", lat: -45.03, lon: 168.66 };
  for (const [aurora, kp, cloud] of [[0, 1, null], [15, 4, 30], [40, 7, 80]]) {
    assert.equal(scoreCity(north, aurora, kp, cloud), scoreCity(south, aurora, kp, cloud));
  }
});

test("scoreCity: 边界（下限 3 / 上限 99）", () => {
  assert.equal(scoreCity({ lat: 10 }, 0, 0, 100), 3);
  assert.equal(scoreCity({ lat: 70 }, 60, 9, 0), 99);
});

test("labelForScore: 阈值边界", () => {
  assert.equal(labelForScore(72), "Great");
  assert.equal(labelForScore(71), "Good");
  assert.equal(labelForScore(52), "Good");
  assert.equal(labelForScore(51), "Possible");
  assert.equal(labelForScore(32), "Possible");
  assert.equal(labelForScore(31), "Low");
});

test("directionWords: 北半球看北、南半球看南", () => {
  const north = directionWords({ lat: 51 });
  assert.deepEqual(north, {
    horizon: "northern", look: "north", ovalPush: "south",
    darkSites: "north of town", marginalEdge: "southern edge",
  });
  const south = directionWords({ lat: -42.9 });
  assert.deepEqual(south, {
    horizon: "southern", look: "south", ovalPush: "north",
    darkSites: "south of town", marginalEdge: "northern edge",
  });
});

test("guidanceFor: 文案方向随半球翻转", () => {
  const north = { name: "Calgary", lat: 51.05 };
  const south = { name: "Hobart", lat: -42.88 };
  assert.match(guidanceFor(north, 80, 5, 10), /northern horizon/);
  assert.match(guidanceFor(south, 80, 5, 10), /southern horizon/);
  assert.match(guidanceFor(north, 60, 5, 10), /pushes south.*north of town/);
  assert.match(guidanceFor(south, 60, 5, 10), /pushes north.*south of town/);
  assert.match(guidanceFor(north, 10, 6, 10), /southern edge/);
  assert.match(guidanceFor(south, 10, 6, 10), /northern edge/);
});

test("nearestAurora: 找最近网格点，含南半球与经度环绕", () => {
  const grid = [
    [210, 65, 8],    // 北半球点（东经 210 = 西经 150）
    [147, -70, 5],   // 南半球点
    [359, 51, 2],    // 经度环绕测试点
  ];
  const hobart = { lat: -42.88, lon: 147.33 };
  assert.equal(nearestAurora(grid, hobart).value, 5);
  const fairbanks = { lat: 64.84, lon: -147.72 };
  assert.equal(nearestAurora(grid, fairbanks).value, 8);
  // 伦敦 lon≈0，最近应是 lon=359 的点（环绕后距离 1 度）
  const london = { lat: 51.5, lon: -0.1 };
  assert.equal(nearestAurora(grid, london).value, 2);
  assert.deepEqual(nearestAurora([], hobart), { value: 0, lat: null, lon: null });
});

test("normalizeLon: 0-360 转 -180..180", () => {
  assert.equal(normalizeLon(210), -150);
  assert.equal(normalizeLon(180), 180);
  assert.equal(normalizeLon(30), 30);
});
