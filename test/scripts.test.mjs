import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const SETTINGS = readFileSync(new URL("location-settings.js", root), "utf8");

// 在沙箱中執行 location-settings.js，回傳 $done 的結果與寫入的鍵值。
function runSettings({ url, headers = {}, argument, injected } = {}) {
  const store = {};
  let done = null;
  const src = injected ? SETTINGS.replace('/*__ILS_ALLOWED_ORIGIN__*/""', JSON.stringify(injected)) : SETTINGS;
  const ctx = {
    $request: { url, headers },
    $persistentStore: { read: (k) => (k in store ? store[k] : null), write: (v, k) => { store[k] = v; return true; } },
    $done: (o) => { done = o; },
  };
  if (argument !== undefined) ctx.$argument = argument;
  vm.runInNewContext(src, ctx);
  return { res: done.response, body: JSON.parse(done.response.body), store };
}

const SAVE = "https://gs-loc.apple.com/ils-settings/save";
const SITE = "https://picker.example.workers.dev";

test("settings：未設定網域時維持舊行為（CORS *）", () => {
  const { res, body, store } = runSettings({ url: SAVE + "?lat=25&lon=121" });
  assert.equal(body.success, true);
  assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
  assert.equal(store.enabled, "true");
});

test("settings：經緯度超出範圍拒絕寫入", () => {
  const { body, store } = runSettings({ url: SAVE + "?lat=91&lon=121" });
  assert.equal(body.success, false);
  assert.equal(store.latitude, undefined);
  assert.equal(runSettings({ url: SAVE + "?lat=10&lon=-180.5" }).body.success, false);
});

test("settings：設定網域後，來源不符回 403、相符則限制 CORS", () => {
  const bad = runSettings({ url: SAVE + "?action=query", headers: { Origin: "https://evil.com" }, injected: SITE });
  assert.equal(bad.res.status, 403);
  assert.equal(bad.res.headers["Access-Control-Allow-Origin"], SITE);
  const badRef = runSettings({ url: SAVE + "?lat=1&lon=1", headers: { referer: "https://evil.com/p" }, argument: "origin=" + SITE });
  assert.equal(badRef.res.status, 403);
  assert.equal(badRef.store.latitude, undefined);
  const ok = runSettings({ url: SAVE + "?lat=1&lon=2", headers: { origin: SITE }, injected: SITE });
  assert.equal(ok.res.status, 200);
  assert.equal(ok.body.success, true);
  assert.equal(ok.res.headers["Access-Control-Allow-Origin"], SITE);
  const okRef = runSettings({ url: SAVE + "?lat=1&lon=2", headers: { Referer: SITE + "/picker" }, argument: "origin=" + SITE });
  assert.equal(okRef.res.status, 200);
});

test("settings：無 Origin/Referer 的捷徑請求可用，瀏覽器跨站請求拒絕", () => {
  assert.equal(runSettings({ url: SAVE + "?lat=1&lon=2", injected: SITE }).res.status, 200);
  const xs = runSettings({ url: SAVE + "?lat=1&lon=2", headers: { "Sec-Fetch-Site": "cross-site" }, injected: SITE });
  assert.equal(xs.res.status, 403);
});

function loadCommonJs(file, extra = {}) {
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(new URL(file, root), "utf8"), { module, console, Math, ...extra });
  return module.exports;
}

test("spoofer：隨機擾動只套用一次（normalizeConfig 重複呼叫不疊加）", () => {
  const api = loadCommonJs("location-spoofer.js");
  const first = api.normalizeConfig({ enabled: true, latitude: 25, longitude: 121, randomRadius: 500 });
  const again = api.normalizeConfig(first);
  assert.equal(again.latitude, first.latitude);
  assert.equal(again.longitude, first.longitude);
});

test("QX：$prefs 損壞時仍呼叫 $done({})", () => {
  let done = null;
  vm.runInNewContext(readFileSync(new URL("location-spoofer-qx.js", root), "utf8"), {
    console, Math,
    $response: { bodyBytes: new Uint8Array([1, 2, 3]).buffer },
    $prefs: { valueForKey: (k) => (k === "latitude" ? "999" : k === "enabled" ? "true" : null) },
    $done: (o) => { done = o; },
  });
  assert.ok(done, "$done 未被呼叫");
  assert.equal(Object.keys(done).length, 0);
});
