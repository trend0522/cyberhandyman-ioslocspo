import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedHost, isFetchable, parseCoords, MAX_INPUT_LEN } from "../src/parse.js";
import { getPageHtml } from "../src/page.js";

test("isAllowedHost：只允許地圖服務網域", () => {
  for (const h of ["maps.apple.com", "surl.amap.com", "j.map.baidu.com", "maps.app.goo.gl", "www.google.com", "google.com.tw", "www.google.co.jp"]) {
    assert.equal(isAllowedHost(h), true, h);
  }
  for (const h of ["evil.com", "apple.com.evil.com", "notgoogle.com", "example.org", ""]) {
    assert.equal(isAllowedHost(h), false, h);
  }
  assert.equal(isFetchable("https://evil.com/x"), false);
  assert.equal(isFetchable("https://maps.apple.com/?q=1"), true);
});

test("parseCoords：u 超過 2KB 直接拒絕", async () => {
  await assert.rejects(parseCoords("https://maps.apple.com/?x=" + "a".repeat(MAX_INPUT_LEN)), /過長/);
});

test("parseCoords：不在白名單的網域不發出請求、重新導向到白名單外即停止", async () => {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (u) => {
    calls.push(u);
    return new Response("", { status: 302, headers: { location: "https://evil.example.com/next" } });
  };
  try {
    await assert.rejects(parseCoords("https://evil.com/abc"));
    assert.equal(calls.length, 0);
    await assert.rejects(parseCoords("https://maps.app.goo.gl/abc"));
    assert.deepEqual(calls, ["https://maps.app.goo.gl/abc"]);
  } finally {
    globalThis.fetch = orig;
  }
});

test("parseCoords：不需請求即可解析的連結仍正常", async () => {
  const r = await parseCoords("https://maps.apple.com/?ll=25.033626,121.564215&name=Taipei101");
  assert.equal(r.lat, 25.033626);
  assert.equal(r.lon, 121.564215);
});

test("page.js parseLocalCoords：超出範圍回傳 null", () => {
  const html = getPageHtml();
  const m = html.match(/function parseLocalCoords\(text\) \{[\s\S]*?\n\}/);
  assert.ok(m, "找不到 parseLocalCoords");
  const parseLocalCoords = new Function(m[0] + "\nreturn parseLocalCoords;")();
  assert.deepEqual(parseLocalCoords("25.03, 121.56"), { lat: 25.03, lon: 121.56 });
  assert.deepEqual(parseLocalCoords("121.56, 25.03"), { lat: 25.03, lon: 121.56 });
  assert.equal(parseLocalCoords("200.5, 300.5"), null);
  assert.equal(parseLocalCoords("hello"), null);
});
