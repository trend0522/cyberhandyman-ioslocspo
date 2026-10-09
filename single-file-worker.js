/**
 * iOS Location Spoofer — stateless picker, single-file Cloudflare Worker (AUTO-GENERATED).
 * DO NOT EDIT BY HAND. Source of truth: src/*.js (repo root). Regenerate:
 *   node scripts/build-single.mjs
 * Mirrors the Hono build (src/index.js) exactly: landing + /picker + /api/parse +
 * PWA manifest/icons + self-hosted module scripts & manifests. Stateless.
 */

/* ---- minimal Hono shim (so this single-file mirrors src/index.js one-to-one) ---- */
class Hono {
  constructor() { this._routes = []; this._err = null; }
  get(p, h) { this._routes.push(["GET", p, h]); return this; }
  post(p, h) { this._routes.push(["POST", p, h]); return this; }
  onError(fn) { this._err = fn; }
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const c = {
      env, executionCtx: ctx,
      req: {
        url: request.url,
        method: request.method,
        query: (k) => url.searchParams.get(k),
        header: (k) => request.headers.get(k),
        json: () => request.json(),
        raw: request,
      },
      _h: {},
      header(k, v) { this._h[k] = v; },
      html(s) { return new Response(s, { headers: { "Content-Type": "text/html;charset=utf-8", ...this._h } }); },
      json(o, status) { return new Response(JSON.stringify(o), { status: status || 200, headers: { "Content-Type": "application/json", ...this._h } }); },
      text(s, status) { return new Response(s, { status: status || 200, headers: { "Content-Type": "text/plain; charset=utf-8", ...this._h } }); },
      body(b, status, headers) { return new Response(b, { status: status || 200, headers: { ...this._h, ...(headers || {}) } }); },
    };
    try {
      for (const [m, p, h] of this._routes) { if (m === request.method && url.pathname === p) return await h(c); }
      return new Response("Not found", { status: 404 });
    } catch (e) { if (this._err) return this._err(e, c); throw e; }
  }
}

/* ==== inlined from src/parse.js ==== */

// 座標解析：接受地圖連結（Apple 地圖／高德／百度，含短連結），取出經緯度＋名稱。
// 高德為 GCJ-02；Apple 地圖在中國大陸同為 GCJ-02。兩者都轉 WGS84 再餵給 wloc；
// gcj02ToWgs84 內含 out_of_china 判斷，境外座標原樣回傳（不動作）。
//
// 本檔案與上游 Yu9191/wloc v1.1（worker/src/parse.js）保持同步：inRange 值域檢查、
// 高德 position=/lnglat= 經緯度反序、港澳台（Apple／Google 直接提供 WGS84 不做 GCJ 反算）、
// 百度 BD09MC 內文解析、以及 fetch 的 SSRF／資源上限加固。

function safeDecode(s) {
  if (!s) return "";
  try {
    return decodeURIComponent(String(s).replace(/\+/g, " "));
  } catch (e) {
    return String(s);
  }
}

// 從一段字串裡取出經緯度＋名稱。相容：
//  Apple 地圖 coordinate=/ll=/sll=緯度,經度  （名稱在 name=...）
//  高德 ?p=POIID,緯度,經度,名稱,城市  （逗號或 %2C）
//  高德 ?q=緯度,經度,名稱           （新版分享連結，逗號或 %2C）
//  純文字 緯度,經度
//  高德 URI ?lnglat=/?position=經度,緯度  （與上面幾條順序相反）
// opts.allowBare=false 時不啟用「兩個裸小數」備援。掃描頁面內文必須關掉它：
// 內文裡任何一對小數都會命中（百度頁面的 "view_dir":"-0.8477,0.0000" 就是如此），
// 結果是靜默回傳一個錯誤座標 —— 比解析失敗危險得多。
function extractFromString(s, opts) {
  const hit = extractRaw(s, opts);
  // 值域是最後一道閘。上面的備援規則不帶語意，匹配到什麼就回傳什麼，經緯顛倒
  // （lat=113.9）或純粹的垃圾數字都能一路走到呼叫端。這裡擋掉的是「解析成了錯的」，
  // 它比「解析失敗」危險得多 —— 後者會提示使用者，前者會把裝置定位挪到別處。
  return hit && inRange(hit.lat, hit.lon) ? hit : null;
}

// 緯度絕對值 <= 90，經度 <= 180；NaN / Infinity 一併擋掉。
function inRange(lat, lon) {
  return (
    Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
  );
}

function extractRaw(s, opts) {
  if (!s) return null;
  const allowBare = !opts || opts.allowBare !== false;
  const str = String(s);
  let m;
  // 前綴 (?:^|[?&]) 是必需的：無錨定時 "ll=" 會匹配任何以 ll 結尾的參數名，
  // 例如 scroll=1.5,2.5 / pull=... 都會被當成座標。
  m = str.match(/(?:^|[?&])(?:coordinate|ll|sll)=(-?\d{1,3}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)/i);
  if (m) return { lat: +m[1], lon: +m[2], name: queryName(str), src: "apple" };
  // Google: !3d<lat>!4d<lon> 是地點圖釘的真實座標，必須優先於 @lat,lon —— 後者是
  // 相機視埠中心，與縮放層級綁定，可以離目標十幾公里。
  m = str.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);
  if (m) return { lat: +m[1], lon: +m[2], name: googleName(str), src: "google" };
  m = str.match(
    /[?&]p=[^,&%]*(?:,|%2C)(-?\d{1,3}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)(?:(?:,|%2C)((?:(?!,|%2C|&).)+))?/i
  );
  if (m) return { lat: +m[1], lon: +m[2], name: m[3] ? safeDecode(m[3]) : "", src: "amap" };
  m = str.match(
    /[?&]q=(-?\d{1,3}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)(?:(?:,|%2C)((?:(?!,|%2C|&).)+))?/i
  );
  if (m) return { lat: +m[1], lon: +m[2], name: m[3] ? safeDecode(m[3]) : "", src: "amap" };
  // 高德 URI API 的 lnglat= / position= 是「經度,緯度」序，與上面所有規則相反。
  // 不要照搬舊頁面裡的 location=/center= 規則：那條也按 lon,lat 解，但百度的
  // location= 實際是 lat,lng，搬過來會把百度連結解顛倒。寧可少認一種也不要認錯。
  m = str.match(/(?:^|[?&])(?:lnglat|position)=(-?\d{1,3}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)/i);
  if (m) return { lat: +m[2], lon: +m[1], name: queryName(str), src: "amap" };
  // 百度網頁版把 BD09MC 公尺制座標寫進路徑：/poi/名稱/@12709535.375,2529761.45,19z
  // 位數（6~9）本身就把它和經緯度形式的 @ 區分開了。
  // 這是港澳台百度連結在伺服器端唯一能取得座標的形式 —— 那些地區的分享連結展開後
  // 內文裡沒有座標，得由頁面腳本帶反爬 token 去查 detailConInfo，Worker 重現不了。
  m = str.match(/baidu\.com\/[^\s]*?@(-?\d{6,9}(?:\.\d+)?)(?:,|%2C)(-?\d{6,9}(?:\.\d+)?)/i);
  if (m) {
    const bd = bd09mcToBd09(+m[1], +m[2]);
    if (bd) return { lat: bd.lat, lon: bd.lon, name: baiduPathName(str), src: "baidu" };
  }
  // 只有在沒有圖釘座標時才退而求其次用視埠中心。
  m = str.match(/\/maps\/[^\s]*@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (m) return { lat: +m[1], lon: +m[2], name: googleName(str), src: "google" };
  if (allowBare) {
    m = str.match(/(-?\d{1,3}\.\d{4,})\s*(?:,|%2C)\s*(-?\d{1,3}\.\d{4,})/);
    if (m) return { lat: +m[1], lon: +m[2], name: "", src: "text" };
  }
  return null;
}

// 查詢字串裡的 ?name=/ &name= —— Apple 地圖和高德 URI 都用這個鍵。
function queryName(str) {
  const m = str.match(/[?&]name=([^&]+)/i);
  return m ? safeDecode(m[1]) : "";
}

// 百度網頁版的地名在路徑裡：/poi/Apple台北101/@...
function baiduPathName(str) {
  const m = str.match(/\/poi\/([^/@?]+)/);
  return m ? safeDecode(m[1]).trim() : "";
}

// Google 的地名在路徑裡：/maps/place/Apple+Park/@...
function googleName(str) {
  const m = str.match(/\/maps\/place\/([^/@?]+)/);
  return m ? safeDecode(m[1]).replace(/\+/g, " ").trim() : "";
}

// /api/parse 會去 fetch 呼叫端給的任意 URL。Workers 出網到不了內網，所以經典的
// SSRF（打內網／中繼資料服務）基本上不成立，剩下的風險是資源耗盡 —— 一個永不結束的
// 回應能把子請求卡死，一個幾百 MB 的回應能把 128 MB 的 Worker 記憶體撐爆。下面兩個
// 常數和 isFetchable() 擋的就是這個，而不是「防止存取某些站點」。
const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 512 * 1024;

function isFetchable(u) {
  let url;
  try {
    url = new URL(u);
  } catch (e) {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const h = url.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith("[")) return false; // IP 字面值
  return true;
}

// 只讀取前 MAX_BODY_BYTES，讀滿就截斷連線。座標總在頁面靠前的位置，讀全文沒有效益。
async function readCapped(resp) {
  if (!resp.body || typeof resp.body.getReader !== "function") {
    return (await resp.text()).slice(0, MAX_BODY_BYTES);
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  try {
    await reader.cancel();
  } catch (e) {}
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

function isBaiduHost(u) {
  try {
    return /(^|\.)baidu\.com$/i.test(new URL(u).hostname);
  } catch (e) {
    return false;
  }
}

// 接受原文（可能含中文地名＋連結），取出 URL，必要時跟隨重新導向展開短連結，提取座標。
async function parseCoords(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("空輸入");

  const urlMatch = text.match(/https?:\/\/[^\s'"<>]+/i);
  let target = urlMatch ? urlMatch[0] : text;

  let hit = extractFromString(target);
  if (hit) return hit;

  if (urlMatch) {
    let cur = target;
    for (let i = 0; i < 5; i++) {
      if (!isFetchable(cur)) break;
      let resp;
      try {
        resp = await fetch(cur, {
          redirect: "manual",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: {
            "user-agent":
              "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/24A5370h Safari/604.1",
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "zh-CN,zh-Hans;q=0.9",
          },
        });
      } catch (e) {
        break;
      }
      const loc = resp.headers.get("location");
      if (loc) {
        hit = extractFromString(loc);
        if (hit) return hit;
        cur = new URL(loc, cur).toString();
        hit = extractFromString(cur);
        if (hit) return hit;
        continue;
      }
      hit = extractFromString(resp.url);
      if (hit) return hit;
      try {
        const body = await readCapped(resp);
        hit = extractFromString(body, { allowBare: false });
        if (hit) return hit;
        // 百度分享連結展開後 URL 裡只有 uid，座標以 BD09MC 麥卡托公尺制藏在內文中。
        if (isBaiduHost(cur)) {
          hit = extractBaiduFromBody(body);
          if (hit) return hit;
        }
      } catch (e) {}
      break;
    }
  }
  // 百度對大陸 POI 會把座標直接輸出在行動版頁面裡，港澳台的則不會 —— 那邊要靠頁面
  // 腳本帶 auth/seckey 反爬 token 去查 detailConInfo，伺服器端無法重現。與其只說一句
  // 「解析不了」，不如告訴使用者那條確實可行的方法。
  if (urlMatch && isBaiduHost(target)) {
    throw new Error(
      "百度這條連結的座標要靠網頁腳本才能取得（港澳台的 POI 多為此類）。" +
        "請在瀏覽器開啟該連結，等網址列顯示 map.baidu.com/poi/名稱/@數字,數字,19z 之後，複製整條網址再貼上。"
    );
  }
  throw new Error("無法從連結中解析出經緯度");
}

function round6(n) {
  return Math.round(Number(n) * 1e6) / 1e6;
}

// ---- 百度：BD09MC（麥卡托公尺制）-> BD09（經緯度）----
// 百度用的不是標準 Web 麥卡托，而是按緯度分 6 段的高次多項式擬合。
// 用標準麥卡托逆算會差約 10 公里，必須用下面這張係數表。
const MCBAND = [12890594.86, 8362377.87, 5591021, 3481989.83, 1678043.12, 0];
const MC2LL = [
  [1.410526172116255e-8, 8.98305509648872e-6, -1.9939833816331, 200.9824383106796, -187.2403703815547, 91.6087516669843, -23.38765649603339, 2.57121317296198, -0.03801003308653, 1.73379812e7],
  [-7.435856389565537e-9, 8.983055097726239e-6, -0.78625201886289, 96.32687599759846, -1.85204757529826, -59.36935905485877, 47.40033549296737, -16.50741931063887, 2.28786674699375, 1.026014486e7],
  [-3.030883460898826e-8, 8.98305509983578e-6, 0.30071316287616, 59.74293618442277, 7.357984074871, -25.38371002664745, 13.45380521110908, -3.29883767235584, 0.32710905363475, 6.85681737e6],
  [-1.981981304930552e-8, 8.983055099779535e-6, 0.03278182852591, 40.31678527705744, 0.65659298677277, -4.44255534477492, 0.85341911805263, 0.12923347998204, -0.04625736007561, 4.48277706e6],
  [3.09191371068437e-9, 8.983055096812155e-6, 6.995724062e-5, 23.10934304144901, -0.00023663490511, -0.6321817810242, -0.00663494467273, 0.03430082397953, -0.00466043876332, 2.5551644e6],
  [2.890871144776878e-9, 8.983055095805407e-6, -3.068298e-8, 7.47137025468032, -3.53937994e-6, -0.02145144861037, -1.234426596e-5, 0.00010322952773, -3.23890364e-6, 8.260885e5],
];

function bd09mcToBd09(x, y) {
  const ax = Math.abs(x), ay = Math.abs(y);
  let f = null;
  for (let i = 0; i < MCBAND.length; i++) {
    if (ay >= MCBAND[i]) { f = MC2LL[i]; break; }
  }
  if (!f) return null;
  const c = ay / f[9];
  let lon = f[0] + f[1] * ax;
  let lat = f[2] + f[3] * c + f[4] * c ** 2 + f[5] * c ** 3 + f[6] * c ** 4 + f[7] * c ** 5 + f[8] * c ** 6;
  lon *= x < 0 ? -1 : 1;
  lat *= y < 0 ? -1 : 1;
  return { lat, lon };
}

// BD09 -> GCJ02（百度在 GCJ 之上再加了一層自有偏移）
const X_PI = (Math.PI * 3000) / 180;
function bd09ToGcj02(lat, lon) {
  const x = lon - 0.0065, y = lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
  const t = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
  return { lat: z * Math.sin(t), lon: z * Math.cos(t) };
}

// ---- 港澳台：Apple／Google 在這三地提供的是 WGS84 ----
//
// GCJ-02 的偏移只施加於中國大陸，但 gcjOutOfChina 是個粗略矩形，把港澳台整個圈在
// 裡面，於是對本來就是 WGS84 的座標白做一次反算，實測偏約 570~600 公尺。
//
// 關鍵在於：這不是一個純地理判斷，必須按來源區分。高德在香港的圖磚實測仍是
// GCJ-02（把衛星圖和高德圖放在同一座標上比對，差 596 公尺，與大陸同量級），百度的
// BD-09 建在 GCJ 之上同理。所以只有 apple/google 才在港澳台跳過換算。
//
// 實測基準（連結原始值即真值，與裝置 GPS 逐位相同）：
//   香港 ifc mall       22.284774, 114.159437
//   澳門 Galaxy Macau   22.148148, 113.555399
//   台北 101            25.033626, 121.564215

// 香港必須用多邊形而不是矩形：任何包住香港的矩形都會把深圳南山／福田一起圈進去，
// 而深圳正是本專案最常用的座標區域。北界沿深圳河與深圳灣，自西向東抬升。
// 這條線是概略的，口岸一帶（羅湖／落馬洲／沙頭角）兩側約 1 公里內可能判錯 ——
// 那些地方本身就騎在邊界上，無法用幾個折點分清。
const HK_POLY = [
  [113.8, 22.1],
  [113.8, 22.43],
  [113.9, 22.455],
  [113.98, 22.487],
  [114.05, 22.507],
  [114.11, 22.527],
  [114.17, 22.543],
  [114.24, 22.552],
  [114.32, 22.545],
  [114.5, 22.45],
  [114.5, 22.1],
];

// 射線法。poly 的點是 [經度, 緯度]。
function pointInPoly(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 澳門與珠海拱北只隔一道關閘（約 250 公尺），矩形分不開；北界取關閘緯度，誤判範圍
// 限於口岸那一小片。
function inMacau(lat, lon) {
  return lat >= 22.1 && lat <= 22.215 && lon >= 113.525 && lon <= 113.605;
}

// 台灣本島＋澎湖。金門／馬祖緊貼廈門與福州，用矩形圈會誤傷大陸，故不含。
function inTaiwan(lat, lon) {
  return lat >= 21.85 && lat <= 25.35 && lon >= 119.3 && lon <= 122.1;
}

// 該來源在該位置是否直接提供 WGS84（即不需要做 GCJ 反算）。
function usesWgs84Locally(lat, lon, src) {
  if (src !== "apple" && src !== "google") return false;
  return inMacau(lat, lon) || inTaiwan(lat, lon) || pointInPoly(lat, lon, HK_POLY);
}

// 按來源把座標統一換算到 WGS84。text 源（使用者直接輸入的裸座標）視為已是 WGS84。
//
// 注意換算與分派的分工：gcj02ToWgs84 回答「這兩個座標系在此處相差多少」，這個關係
// 在香港同樣成立（高德就在用），所以港澳台的例外不能塞進那個函式裡 —— 否則就沒法
// 讓 Apple 走一條路、高德走另一條路了。
function toWgs84(lat, lon, src) {
  if (src === "baidu") {
    const g = bd09ToGcj02(lat, lon);
    return gcj02ToWgs84(g.lat, g.lon);
  }
  if (src === "amap" || src === "apple" || src === "google") {
    if (usesWgs84Locally(lat, lon, src)) return { lat, lon };
    return gcj02ToWgs84(lat, lon);
  }
  return { lat, lon };
}

// 百度頁面內文裡的 "x":"12686385.66","y":"2560876.53" —— BD09MC 公尺制。
// 量級檢查用於把它和頁面裡其它同名字段（像素座標等）區分開。
function extractBaiduFromBody(body) {
  const m = String(body).match(/"x"\s*:\s*"?(-?\d+(?:\.\d+)?)"?\s*,\s*"y"\s*:\s*"?(-?\d+(?:\.\d+)?)"?/);
  if (!m) return null;
  const x = +m[1], y = +m[2];
  if (!(Math.abs(x) > 1e5 && Math.abs(y) > 1e5)) return null;
  const bd = bd09mcToBd09(x, y);
  if (!bd || Math.abs(bd.lat) > 90 || Math.abs(bd.lon) > 180) return null;
  const nm = String(body).match(/<title>[^<]*?【([^】]{1,40})】/);
  return { lat: bd.lat, lon: bd.lon, name: nm ? nm[1] : "", src: "baidu" };
}

const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;

function gcjOutOfChina(lng, la) {
  return lng < 72.004 || lng > 137.8347 || la < 0.8293 || la > 55.8271;
}

function gcjDeltaLat(x, y) {
  let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  r += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  r += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return r;
}

function gcjDeltaLon(x, y) {
  let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  r += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  r += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return r;
}

// WGS84 -> GCJ-02（正向偏移），與高德／Apple 中國所用偏移一致。
function wgs84ToGcj02(lat, lon) {
  if (gcjOutOfChina(lon, lat)) return { lat, lon };
  let dLat = gcjDeltaLat(lon - 105.0, lat - 35.0);
  let dLon = gcjDeltaLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * Math.PI);
  dLon = (dLon * 180.0) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lon: lon + dLon };
}

// GCJ-02 -> WGS84（迭代反算，亞公尺級）。
// 單程反算在偏移梯度大的地區會殘留 1~2 公尺，這裡用不動點迭代收斂到 <0.1 公尺，
// 與高德自身的 WGS84->GCJ 逆運算嚴格對齊，消除回看時的殘差。
function gcj02ToWgs84(lat, lon) {
  if (gcjOutOfChina(lon, lat)) return { lat, lon };
  let wgsLat = lat;
  let wgsLon = lon;
  for (let i = 0; i < 6; i++) {
    const g = wgs84ToGcj02(wgsLat, wgsLon);
    const errLat = g.lat - lat;
    const errLon = g.lon - lon;
    if (Math.abs(errLat) < 1e-9 && Math.abs(errLon) < 1e-9) break;
    wgsLat -= errLat;
    wgsLon -= errLon;
  }
  return { lat: wgsLat, lon: wgsLon };
}

/* ==== inlined from src/icons.js ==== */

// Auto-generated PWA app icons. Regenerate with scripts/gen_icons.py.
// Blue square + white location pin; apple-touch-icon (180) and web manifest (512).
const ICON_180_B64 = "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";
const ICON_512_B64 = "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAYAAAD0eNT6AAA0wklEQVR42u3debjdVXno8e9v733mk/mEgCCzoAyxiKVVsdUqDtVWRQq2Vzton9v2aeu99rm99yoUB5QgUofrUJBarRW1VkUDhJAECKgEZA4QIAlzmDKek+TMe7h/vPvH3hkIGc609+/7eR7upeFBzv6d9dvrXe9a77uS+ZdXKkiSpEzJ+QgkSTIAkCRJBgCSJMkAQJIkNYUCHgGUJMkMgCRJykAGwASAJElmACRJkgGAJEkyAJAkSQYAkiTJAECSJBkASJIkAwBJkoSdACVJkhkASZJkACBJkgwAJEmSAYAkSTIAkCRJBgCSJAmvA5YkSWYAJEmSjYAkSTIDIEmSDAAkSZIBgCRJMgCQJEkGAJIkyQBAkiQZAEiSJAMASZJkACBJkrAToCRJMgMgSZK8DVCSJJkBkCRJBgCSJMkAQJIkGQBIkiQDAEmSDAAkSZIBgCRJwk6AkiTJDIAkSTIAkCRJBgCSJMkAQJIkGQBIkiS8DVCSJJkBkCRJBgCSJAkbAUmSJDMAkiTJAECSJBkASJIkAwBJkmQAIEmSAYAkSTIAkCRJBgCSJMkAQJIkYSdASZLkbYCSJAm3ACRJkgGAJEkyAJAkSQYAkiTJAECSJBkASJIkAwBJkmQAIEmSsBOgJEkyAyBJkgwAJEkyAJAkSQYAkiQJbwOUJElmACRJkgGAJEkyAJAkSdgISJIkmQGQJEkGAJIkyQBAkiQZAEiSJAMASZJkACBJkgwAJEmSAYAkSTIAkCRJ2AlQkiSvA5YkSbgFIEmSDAAkSZIBgCRJMgCQJEkGAJIkyQBAkiQxlfoASGoKSbJTVJ9AUvfPy3tZ85ur+5cqL/w/UE7/zNphyQBA0iRM9NXJPqmbpMsVKJagVIGRYvzzYnnHybo1z44Rwe5UYKS0Y1BRyMX/TmsB8gnkcxEk1P/3KxXsKSbZCVDSWE72uSQm4kolJvjhEoyWYoJPkpiU2wswox26W+HIWVAqwwkHwbTWWLm35GD+wVBIYqJOdp33SYBiBVY+B6PlyCRsG4FV62PSf3wLbB+BviHoL8bPUqlEgNCSjwAjX/ezlg0KJDMAkvY+jZ+r/v/l6mp8uBgTcj6BaW1wxEw4bDoc1xN/f+zs+PPDZ0BbIYKBA/GGw3f/50PF+Fme7INtw7B2MzzRC6s3wrqt8Ow26B2KwKAlFz9Laz4CmEolAhG3D6Qp9H1z/Jd9JaXJVL/Cr5/w2/IwrxtOPChW76+aC8fOgUOnQ8ceJvl0r3/ntHyS7N3PU/+NkNSfLdjDvz9YhKe3wtpN8OCGyCI8sB6e3x4Zi/qAoD5DIMkAQMrcpJ9LYrU8NBqTfiEPB3fHRP/aQ+OvE+ZGan93k/wLb251Pz7ZzcG/sVSp/j+VnQ4HJsnug4O+IVi1Ae54Ov56cAM8tz3OKrQVoL0lshplgwHJAEBq+vR+dcIbrE76HS1w3JxY4b/9WDj1UJjZvutkX67UHf4bx0n+QIKDSqWWdcjtJijoHYI7n4br1kaGYPWmeA5thXgO6bPxG0maoO+k4wwApHGVT2p76IPF2KM/bg686Sh427HwGwfHIbtdJvy68wCNqH7ff+eAoFSGe56DJWth+WMRDAwVY2sjPcNQ8ptJMgCQGnW1X6nEgblyJU7nv/koOPOEXSf9dLLLTcHV/VhmCdJUf343wcBPV8GNj0W1Qa564DExKyAZAEiNMvHnk1jNDozGobffOTIm/TOOiTK9+olvqqb0J3LLoD4Q2j4CSx+JYODmx+NQZGdLZAVKBgKSAYDEFD3UN1SMSezwGZHeP/MEOPVlO670k5c4UZ9Fac+A+szAnc9EILBkbZQedrdGIOChQWmsAoAvGQBIB1rCNzASk//LZ8J/ezV88NXQ01m3F16BXC57K/392iYo154rwMYB+N69cMW98FRvBAGdrZYSSgYA0iR16MvnIs0/VIw9/T89Bc44tjbxu9of26zAxgFYuha+e3ecGWgvxPZAqWzHQckAQJoA+Vz02986DCfPg78+Dd77qmiHm+7t169gNQbVBHVnBUZL8LMH4dJfw33Pw/S2uKegVPZZSQYA0jiV85UqMfEfNj1S/R85NU6rO/FPfCCwbRi+dWdsDazbGoFA+juSZAAgMRb7/OmE09ECH/wN+LvfgjmdtYm//iS7xl/9M980AF+7Db53TzQWSgMyzwdIBgDSfivkql37StGp7+O/C6+YU7fi92DfpB8YTAOBNZtgwU3RabAtH8Fa0W0ByQBA2tdVfwXoHYwb9/7pzfDu42uH+xq5Q19Tbg1QOyx49cNwwY1xU+HMjgjQzAZIBgDSXq36+0ciAPjwa+DvXwezO2qTiKf6mbJVA+nvZ/MgfHUF/NtdEQB0tZoNkAwApJfY6988GFfwfvot8MYjaqv+vBN/Q6j/Xf3iCfjk9XE18ewOzwZIBgASu5b2DRej9exHToX/dXp0nvNkPw1fMbB9BC75ZVQMtObj9kFLBiVIXvFFAwCR+ZR/3xD0dMGCt8HvH1dbKZrup+G3BdLf4aLV8PElsLEfZrS7JSBZvKTM9+/f2A+vOxwWfjAm/2K5dqe9muMwZ7Ecv9uFH4zf9cb+Xa8olgwAJLKR8h8tRW3/R18P//mBOO1fKkdGwHmBpmrbXMjF7/aImfG7/ujr43c/WrKHgwwAJLKU8t82HCfDL38fnPemWAmWK04GzR70pVsC570pfvddrTEWCv7eZQAgNf/k3zsEx8yG759dS/l7aU+Gbm+ktiXw/bNjLPQOGQTIAEBq6sl/0wC8/nBY+CE4aV5MBH7xZ3MsFMsxBhZ+KMbEpgHHggwAJJru6t4E1vfDR14LP/oAzGiLdLBf+NkOAsqVGAs/+kCMjfX9MVZMBskAQGr0yT+pNff5m9PgwjNqrWFN+Ss9+5EQY+NvTouxgq2eZQAgNXgJWCUawXz5XXDBW6tXxVr+pZ07QFavEb7grTFWto/E2HGcyABAorGuictVV/nbh+FL74I/nl9rEet3uniRbaJSJcbKl94VY6dcHUtUfEZqPgUHtpo1rZuu/M8+ycN+2jv5JMbK2SfFpP8/r4mW0OmYkswASI0y+Z/s5K/9qxA4++TadoBnRtScGQCJ5knjOvlrrIMAqGUCEncDZAZAmnqTf5LAwKiTv8YnEzAwGmPMRICaZowbzYomafP6/Hb44u/HF/ZoGVqc/DUGQcBoNQgYGIV/WATzur1JUGYApCnzJb2hH/7mt+DPX+PKX+OTCfjz18QY29Dv+JIBgDRlJv8PnwqfO6Na6udtfmKMSwRzMbY+d0aMNYMAGQBIkzz5bx2G04+Az7y11tHNyV/jcsaEGGOfeWuMua3eIigDAIlJqdfuH4WDu+Hb74f2Ql1XN2m8OgYSY+3b74+x1z8aY1GyEZA0Qf39R0vQkYfvnAWzOmpd/qTxDgJKlRhz3zkLzroixmI+F62DJTMA0jh/CW8bhgVvh5OrV/o6+YsJ7hZ48rwYg9uGzTzJAEAady052Fi91vfMEz3xLya1MuDME2Msbuy37FQGANK41vr3DcNvHgbn/x6UXPlrkjMBpXKMxd88LMZm3m9UGQBIjMu+f3cLfOXd0NFS7cpmAKBJHJNJEmPxK++OsTlackzKAEAa84HaPwIL3gHH9cTKy31XTYlDgeUYkwveEWPUL1UZAEiM3X7r5kH4wPzavr+pVjGFtqbS8wAfmB9j1XMpMgCQxmCFNViEw2fCP73Fa1k1ta+h/qe3xFgdLDpOZQAgcaD7rEOj8NkzYE5H1Fr7xaqpGABUKjFGP3tGjFnPAsgAQNoPFSK1unkgbmJ7x3HVU/+OWDF1twJK5RirZ58cYzefw15rYupeB+zo1BTtvT5ShDmd8I9vjNWVKyo1QsaqUokxu3QtDBejXNCvWZkBkPax5v+8N8PLZ0LZPv9qlLMAxJg97832BpABgLRfrX5PPwLOmR+915381Wj3BZwzP8awrYJlACDtg2IFzn1TrZzK70/RQNtXEGP33DfFWJYMACReOvXfOwTnnAynvdxb/tTAbYIrMYbPOTnGtFsBMgCQ9qBUhmlt8A+nu/JXc2QC/uH0GNOlss9EBgASL9bxr3cIzjoJjpxlu181R5vgI2fFmO4dskOgDACk3Tf8KcLLZ1j2p+YsC3z5jBjjjmsZAEjsuGe6bRg+fCr0dHnyX81VEdDTFWN727BnWmQAIO2wVzpUhKNmwwdPiRWTX5KMeWfFSiX+Kr3IX+k/99D62Ae3lUqM7aNmV7MAPhZNAQXfdk2Fk/+bh+CvToNZHXGzmnulBz7Zlysx0SRJNZtSnXXye/G/Ua4LBnLVe++dtPZ/G6BYjrH9/hPhkpthblf8mTS5AYA0yUarX45nn1ybcLRv0gk7nexfmPSrBovRlnZwFB7bvOszLldiddrRAm0F6CjsWoKx839D7NtlQcQY/9btMeZ9hDIAUOZP/m8agA+/Fo6ZY93/Pq30K7XrketX+IOj8PBGuOtpWNcHD2+AJ3tj/7lUho0Dux5Eq1SgpzOyMdPa4krb4+fCYTPgNYfC8T0RHKT/jfr/tofa9v4swDFz4P0nwb/dEfdcmAXQZEqOudjrgDS5ShVY9pH4cix7+G+vV/v1jWXWbIS7noHr18IDz8NTfTAwWguyWvO1ybol9+KZmHRiHynVJqfOljjBfuI8eMux8JqXwSt6duzdYFZg735vuQQe2QRv/ZaBrqbCbYA+AzF5h6P6huGMV8DRs53892rirz43EtjYD9c/AgsfhFuegO3DMRG3F6C1AO0ttUMB5fRwQDXgerHfB9W/2uu2AMqVCCjWbIIrH4DuNnj9EfCHr4K3HBMn3NP/3cQtnD1fFFSJsf6GI2HpGpjR9uK/D8ktANHMx/9LlWiVmiQ2/mEPh/rK5dqK/+GN8KOV8PNV8NiWWNF3tcKszh0zBPs6sVTq/qa0wx/sGFCUypFpWLwajpoF7zkBzp4f2wTpP8/l3ON+sSCukIsxv3h1NcgyANBkfQUf7RaAJmk1NDAKx/XA4r+IFDWeNGd3rZHTiX/1Rvjmr2MV3jsYK/H2Qkwq5crE//5y1eZN24dhZge870T476fF73Tnn111QVZ1i+Ud347faWfLxP/+JPsAaFIDgOFiTBpthVr6WLVDdqXqPv/2EfjCzfDOb8N37ox/3tMFLfnYp5+MyaNcif92S762BfCdO+Nn/MLN8TPnc7X+Aqr1vChVYsy/78R4B8x6yQBAmVIsw7T22EfGfeNdJtckiT35hQ/C738bFiyPfzans/b8psLEWqnUDgumP9uC5fEzL3wwPkOSuMLdOfiFGPvT2q0EEDYCEplq/NM3BG97RZSbefiPXVL+fUPwievgv1bG/vvcaslYsTSFg7rqzza3Ex7dDH/5Y/ij+XDh22FGu1sCOx8GPHwmnH44LFlTez6SGQBlYqI786Tal6Figs/non7/3d+BH94be+sdhcZaJRbL8TPP7IjP8O7vxGfK51ztslNJ4JknOfHLAEBkpy3qSAkOnganH1lXfka2D4aVqqfDf3gvvOe70a2vpzMmh0YMkMqV+Nl7OuOzvOe78dkK6bkALIGFeAcOnhbvhA2VZACgph9wAyPwusOjH3o549f+phfw5BO44Hr42NVR1tfZ2hyr5WI5PktLLj7bBdfXLsfJ8uHA9FzE3K54FwZG/DKWAYAycAy6Arzz+NpKMdOtfKt7wp9YDJf8Arpbo4a+mdLCaV+A7tb4jJ9YXN36IdtBQDr233l8NSNiBkAGAGrmVc9oKcrGsp7+r1Dr6veJxfAvt8Eh3c27Mk4/1yHd8Vk/sbiaCSC72wH12wA9XfFuuA0gAwA17WAbLMIJB8UXXlbT/xVqXQ/Tyf+grmov/ib/3KPl+KxpEJCrdoCsZHgboKcr3onBol/IMgBQk2cA3nlctk//l8pxGO5zN8DXV8C8jN0NXyzHZ/76ingGhVx2T8Kn1QDvPM4MgAwA1OQTX1cr/PYRtYAgq5P/j1bCV1fAQd3ZLI0rluOzf3VFPIusBgHpO/DbR8S7YUmg8DZANWPzk6FiND85ZnY2o89ytbXvvc/Cx66JWvky2Ux/V6pn3joK8SyOnwuvPiR7TaHSd+CY2XDYDHiyt3a/g2QnQDVND/ShUZh/MHS0VPvcJ9k68Q/R4e9vfwaUoZDP9oqvUoFCAiPleCbX/AVMa4s/z0p2KKneiNnREu/G6g3QkcdGCXILQM134Om3Xr7jhJi1vd7zlsCq56Mkznvg4xl0t8YzOW9JNs+GpO/Cb73cvhgyAFCT7n13tsBrD83e5T9pD/xrH4Yf3ANzqif+FUbL8Ux+cE88o3zGzgOk78JrD413xHMAMgBQc139W4IjZsGxPbUtgays7pIEtg/DhTdCW97rcV/sObXl4xltH45nlpXnlL4Lx/bEOzJc8nIsGQCoib7ghktwXE/sdWYpzZmm/i/7Ndz3XKS7PeC1++fU3RrP6LJfZ2srIN0e62iJd2S4ZFNAGQCoib7giiU4YV622v+WK9EC99HN8LVbYHaHqX9eYitgdkc8q0c3x7PL0liBeEeK9gOQAYBoptPeOThpXrbq/9NSt3+5FbYOxTPQnhVy8az+5dZ4dpWM9QM4aV48A7eJZAAgmqXpy4x2eOXc7Oz/p6n/RzbBT+6Lz1909b/XY+Un98Wzy8pWQPpOvHKuY0UGAGqm9H8FZnVG57esBADp6v9fb4deV//7nAXoHYpnl5UsQPpOHNQd70rRckAZAKjhB1gFRopwxMzsHACsVFf/WwZh8cPVmn9XdOxL2WR3azy7LYPxLJs9JV5/EPCImfHO5NwGkJ0A1ehLm2IJjp1dvfktA+OtVO1wd93D8MQW6Ok0pbuv2ZP2fDy76x6GD/xGrIgLSfN/7nwS78qNa+v+UDIDoEZudXrI9Ox0AExXrD9aCa3W/e93FqU1H8+wkpH7AdJxcsj0eGfcApABgBr+S60lB4dOz0YFQHr477HNcM+ztXsPxD5nUTpa4hk+tjkbhwHTd+PQ6fHOGDgKbwNUQ0+I1S+2w2Zkq/HPTY/C5gGY22X6/0AOA27oj2d59Jzs3BR42IzqmQB3AGQGQI28/18qw7R26OnKRgVAOkH96gnruRmj/hG/eiIb90ekH6+nK96ZUhlbAsoAQI37hVaqxBWv6RmAJAOn/3sH4ddPVaseHAYcSPaooyWeZW8GqgHSd+OQ6fHOlCrO/zIAUDMEAuVsTFgAazZG6toDgGNzEHBDfzzT+mdMk5dBOvHLAEANP7iGi3Dc3FjRNHsPgHSyf3A9DBW90W2stlSGivFMm72KJO0FMK0t3pnhol/QMgBQg9c2F3LZKGlKP+I9z7qCG+vnes+zZKaLZJJUz4/4qxc2AlKDRwDFUrYudHmmLxq6VDzGfeDDpxzP8pm+bF0kVSxVx07FMSQzAGrgL/BZHc3f1KxS3d7oH4Gneqv7//76xySD1JqPZ9o/Es+4mbcB0o82q6MaQEoGAGrki4BOnJeNLoBJ9TNuG6meWHcIjMmEmEvimVYycCo+fUdOnOeFQDIAEM3R1S0LExXA89thYCTS1hob+SSe6fPbs9Me3+6RMgBQUx2Oy0IA8OxW6BuCvE2AxmxFnM/FM312a3YCAONHGQBINF77Wsv/xqccsOC3lWQAIE31TIB8tpIBgCRJwtsAlakVWxbLmC3fHp/nmdUx5DiSGQA1fGkTGbkO2MN/4zOGyhXfGclOgGqoZUwWDm+lH/Go2dDTCdtHvA6YMeolMVqKZ3rU7OysWgo5UwAyA6Am+ALfMpCd0qbuNif+8VgNF3LxbLNS/rdlwCZAMgBQo39xJ/DA8xno457Urq+dNw2KXuk6ZhNisRzP9IXrlZPmv0/igefj3TGQlAGAGr6GOwsTVQVoL8C87rjMxQBgjAKAUjzT9kI848R3RjIAUGMcA8jnsnMAEOCYOdUMgF/iY3OfRDmeaf0zbnZ5rwOWAYAaffJvycNzW2GoWL3JLQOfe/4h2fmsEzGGkiSeaVY+61Ax3pkWb5SUAYAa+QutkIPntsFwsZq6rTR/2vaVB0FXK5S9zvWAlcvxLF95UAZS49XbDoeL8c4UzALIAEANP8hy2bjdLJ2bjp4Dh82A4ZLbAAea/h8uxbM8ek52KklKlXhnJAMANXQVQGse1m+HRzZWV3RNPmGVytDZAq8/EgZHvRaYA7wGeHA0nmVnSzzbZg6o0nfjkY3xzrxQ9SAZAKhRb28pleOLPEsX1rzhiPg/KjZy2e8HmT67NxyRrcuABkfjnfEGJGEnQDV6hDlShPuehd85uvnruNMV/xuPhkOmwbZhKLiSY3+yKSPFeIZvPHrHZ9vU7X+TeFdGipBrq2YFHDsyA6BGNjCanYmrXIGDuuF1R8bn9iXbvy+mgdF4hgd1xzPNynmKrLwrMgAQ2WjjmnYDzEKDk3TB9ienZPc2u7G6/a/+GWal+c8Dz9tOWngdsGiKg02FHDzVG+VNrQWavp1brtrC9Q1HwQkHw5oN0NGSrdvsDvT5DYzGs3vDUfEsmz5wrGY4hovxrhRy8e44ZGQGQI3dDKgAz/TFDXlJBr7UEqKUq70AZ51c3QawGmCfA4CzTo5nWKo0f/lfGhNvH4l3paXg5C8DADXJFsCWAXg0A6WA1B0GrAAfOhWOnFXrhKiXPkMxVIxn9qFTq62kk2xkyiDekS0DbgHIAEDNVM9dhFXr6047Z+EwYBlmd8KHT4OtQ/YE2NuxsnUontnszniGWQic0ndi1fp4VxwrMgBQU02I9z2XnW5u9WcB/vRUeEVP1HebBdjzGBkcjWf1p6dmZO9/py6S9z3nGJEBgGiuW/JacvDQ+vj7zHypV0sCZ3fCuW+F/hFXdi+1+u8fiWc1uzNbpX+56lh5aH28Kx4YFTYCEk1ywKm9AGvWR4vTg6fF6i4LX+756j0I7zsJfng3XL8GZnXEFbeq+yKqnhN523HxrEqV7Fwjnb4Lz2+Ld6S9YAdJmQFQE33BteRgQz/c+0x2DgLWp3dzCXzybdHTvljOzjbI3j6fYvUOhU++LZ5VkrFSWYh3Y0N/vCsVJ38ZAKjZLsq57YnsHASsT++WynDSwfCPb4bNA9lZ3bKXWZLNA/FsTjo4nlWWyibTd+G2J5r/wiMZAIhsngNozcPt6+Lvs7YXns/Fl/tH3wh/eCJsGYy0N6b+2TIYz+Sjb4xnlLXgKF/d/799Xbwj7v/LAEDNdw6gBVavh+e3xyona2nOdGX3lffGHff9I9nOBORz8QwOmxHPpP4ZZWn1nyTxTqxeH++I878MANS05wDuy+A5gPqywJ4u+N6fRHvgkWI2uwTmqrf9dbTEs+jpylbZHzvt/9/n/r8MAJSFsrglq7N713l6HmD+y+CSP4iWt1mb+NJAaGA0nsH8l2Vv33/nm6OWrM5W2aMMAJQxpUqs+G5+NBq+5DO62snn4tT7++fDN86EbcPZ+fJPg8Btw/HZ3z8/nkUWt0Iq1VLHwdF4Jzpa4h2R8DZANeMXXmsBnuyNhienHBop0HxGD78Vy/CBU2IR+Lc/hWlttQmymVf+24bh62fGZy+Ws3sYMh37D62Pd6Kt4AFAmQFQBrq9LXowe+WALxYE/PEpMSH2DcFoqTlXw/lcfLa+ofisf5zxyb9+7C960C6RshOgsrDqKUNHHpathv/9ZijkLYNLg4DpbfCxhbC5H2Z0xITZDFry0DcIs7vgm2fBu05w8q8PipatjneiXLb7n8wAqMn7AXS0wqrn4f7nouNb1vc90yDgXSfAj/8Mju2Bjdvjzxv5XECSxGfYuD0+04//zMmfuvMwCfEOrHo+3gnT/zIAUDauBx51G2B3QcD8Q+C6v4JzTomysFKDTpaFauOjDf3xWa77q/hsTv67pv8HR03/ywBAGVr9dLXClffB9pGYEAwC4jmUKzCjHb75R9Ecp70AmwZigmiEMrlcEj/rpoH42b/y3vgsM9rjszn5x1gv5GLsX3lfvAue/pcBgDLzBdhegEc3Rf/zCtlrCvRSJ+XLFfjwabDkr+N8wNbhqJsv5KZmIJCrpvsHRuNn/eNT4mf/8GnxWbLY5Ic9nP6vEGP/0U11t/9JBgDKUiBwxV2xF+rcwA5752nDoKNnw6VnwX/9KZwwL1bWA9UeClMhbZxP4mcZGI2f7YR58bNeelb87GmDHxvc7Hj7YUKMfSd+MalVANIkHQbsboMb1sCajfCKnvgzV4k7nhJPD4b93ivgjUfDT1bCpSvi6thcEunjtKHSRB0iSyf0UjlW++UKvPpl8Nevi8Y+LXUX2njr4a7jPpfEmL9hTbwDHv6TGQBlrgNqSx429sMP7659OWrXyTZXbQ7Uko/mOUv/Cn7wQTjjuPjzzdWsQHqOID/G1QNJdZWf7t8PjMZ/s1yJn+EHH4yf6QOn1Cb/XIOcWZiMAABizG/sj+flsNdkSV7+GZNQmrxU90gRDp0BN/9dtELFfuh7DJrKO7XNfXgDXPUALLwfHt8CvYPxz9sK8VcuiXRzpW7bpbKn1HRS+/tKdcIaLsZfpTLM7IAjZ8EfngR/cCIcP7f275fKkMu5nbPHk//VCpjf+Ro83RedMf0GlgGAyGpJ4JZB+Ndz4Kz52bwPfn8Dgfq99VIZ1m6Cmx6BXz8RWwTremGoWCu9S88WtO1m0kmSmOTTA3vpv9NegMNmRor/tCPgd4+BY+fUfkfp1oMT/0tLx/aPV8Jf/ifM6vD0vyY7APi0AYCY1BR3/wiceHDUirfms3kvPAeQUk4vlak3OAoPr49V5kPr4++3DMYk/8jGXdPz5Qoc0xPBwawOOP4geOVBkZ05/qBqdmanySwxzb/Pdf8jJXj7ZfDAc3F+w20v4SFAZXkCm9YGd62DxQ/Be06qrj6dWPY6gCKJrEC6Gk+SmLB/49D4610n7Pjv9A5Wyw3rUv/lSqT399S7IS3lS88EaN96XxRyMcbvWgc9XTHOJW8DVObrovN5+P5dEQC4qmT/SsvqVuRpQJDu+ad/niQvPtFX6laq5UrtfzOpNvcxx3+AgRoxxvP5Wi8AySoAZX5vdHpbXIqy4vFaiZkOLCDI1Z3eT0/lJ/WBwU5/JXVVB2k1Qfrv6MDGd5LE2F62Osa641sGAFLdIbRyBb58c3XCcdYZ12e9u780ftFYQoztslUuMgCQdl0lzWiHpavhmlWRcnaVpKY4+Z/EmF66Osa441oGANJOKtX08+dviNPSSWKNtBr75H+SxFj+/A3Vg5eu/mUAIO2qXI6KgHueicY2aQc8qZHb/i68P8b0tLYY45IBgMTuy6U6W+CzS+vK1QwC1ICr/1wSY/izS2NM2/RHTLk+AA5KTbEvzo4CrN0Al98K//hm+wKocev+L781xvLcbuv+ZQZA2qsvz1md8JWb4r70Qs7UqWioraxCLsbuV26KsezqXwYA0l5mAfK5aBF87qJqu1sfixrproZKjN3+kdp1zZIBgLSX5VMzO+Cq++HKlfElagpVU12xeuHPlStj7M7ssOxPBgDSfm0FTGuHTy+Ju9OtChANcOp/Y3+M2Wntpv5lACCxv1sB7QV4bBOcf60VAWqMk//nXxtjtr3geJUBgMSBpFTndMEVd1Y7BOZMqYqp2fEvF2P0ijtjzLplJbwNUOKAU6vtLfB/r4bTj4rUasWe6ppiHf96B2OMtrd4cFVmAKQxCwA6WuGxzXDJcs8CaGru/V9+a5T+dbQ6PmUAII2ZYilOVH/rVnhkE+TsDaApUvOfy8WY/HJa81/yuQg7AUpjKZ+D7SNw/iK44kNQdgtATIELrIgxuX3Ysj+ZAZAYr4NW09th0Sq4+RGvDNbUuOr35kdiTHrVrwwApPGURCbgvEVxytorgzWZB/+K5RiL+VyMTckAQGL89ly72+CedXDFHR4I1OQe/LvijhiL3V71KwMAiYm5MrgNFlwPfYNmATQ5DX/6hmIMdrbZ8U8GANKEdgh8us+yQE3O6j9J4JIb4Jk+O/7JAECa8CzAjHa4fAXc96xlgZr4sr9v3RqHUl39ywBAmoQrgwdH4TPXxfmrioewNAFlfwlR9jcw6lW/MgCQJvXK4GUPw9WrLAvUBJb9PVhd/TveZAAgTcZyrHYg66JlMFLyQKAmqOwvqY1BCTsBSkzKnuy0alngZbfA37+xtlKTxvLgXz4H/3E73PMUzK6/7c/vUJkBkJi0A4HdbfD1X8D67bFSsypA41L2tww6LPuT1wFLU+cLuq0AT/XGVsAX31vdmzULoDFc/V9yA6zrgzmddat/yQyANLmK1QOBP7gLVloWqHEo+/vXFdV+/66aZAAgMeVuC+wfhgsWV8sCfSTCsj/JAEBkoiywE5Y+DNesii9ry7Q0FmV/1zxg2Z8MAKSp3yAoD59ZDFuHLAvUGJT9XeNtfzIAkGiEA1vT2uDeZ6JVay5xz1b7f9vf9+6Au7ztTwYAEg1zIHBWJ3ztF/D45kjjWhaofb3sZ/12WLAUuiz7EzYCkmiU9G1rHp7tgy8vhy+fWV29mcLVPtwzcdFSWNcLPd1QLPlcZAZAaowsQAnmdMH3bodbn/BAoPat7G/lM1FSOrPDyV8GAFLDSRIYLcMXlpnC1b6V/V2wOEpK835DygBAomFvC1z8IPxspVkA7V3Z39UPRCnpzE7HiwwAJBr5QFdHK1xyvWWBeumyv5FS7P3ncjaSkgGA1PABQHcb3P20ZYF66bK/y34VY2WaZX8yAJBonrLAm+GJLbEVYFmgdlf29/VfRMBokCi8DVCiKdK7LXl4dhtcuAQuO6caACQ+G9XK/hYshSd7oafL2/5kBkBqqizAnK4o7VrxuAcCtYeyP1dFMgCQmnOl9+lr47CXBwKVlv19pr7szzEh7AQoNd89Aa2wfG2UBZ59Sq30S2Sz7C9XLft7KFb/JZv+yAyA1KRf+pW41vWCxbBlME5+mwXIdtnfAsv+ZAAgZeOLv70AazfC5bfEJGBFAJkt+7v0V3D3Osv+ZAAgZSYLMKsTvnQjPLapWhbol382y/5utuxPBgBSprIAhRxsG4aLllX/zMeSqd9/LonU/1O9kRFyG0gGABLZKQuc2QHfv8OywMyW/d1ZLfvz9y4DACljEijk4VPXxiRgWWBGy/4kAwApe6vBaW1w81r43u2RFvZAINm47e8hb/uTDACU+QOB09pjP7jPskDL/iQDACkjE0M5DoGt64Uv3GBZIFm47e+patmfTX+Ucckh57rekSrVVeKvPgZH90RgkDM8bp6yP+CJzfDmr8LgCOTzZnokbwOUiMNgfYNw3jXwgz+Dsu2Bm6vsLwdfWg7PboW506Do6l9yC0CCOAw2vR2ueQBuWhuHxTwg1jz9/m99HL57e9wI6eQvGQBI7FwWmE/g3KstC2y2IODzy2LiT8zsSAYAErspC+xug7vWwX9YFtg0q/8rV8LiVdXb/szqSAYA0ouVBXa1woIlcSbALAANXfa3dQi+cD10tBrMSQYA0l7cFriuNyYOswCNG8jlEvjXFXHbX3ebv0fJAEDai8ljRgdcdgusfDpOkHtbIA1V9pdP4PFN8NWb4+ZH+/1LBgDSXmUB8rmoF//04qghr3h4rOHS/19aDs/2Qas1/9JuFeyHKe0mC1CKQ2NLH4Kr74d3n1Q7VKYGKfv7NczptOxPMgMg7Ud3wFwCFy6JHvIeCLTsTzIAkMjObYF3r4NLf+mBwIYq+3vAsj/JAEA6wAOB3W3wtZth/TYvC6IRyv6WWfYnGQBIY1QW+NSW6jWybgNM7bK/Wyz7kwwApDFSLEc6+ft3wMpnLAvEsj8JbwOUsvKi5KBvAD51Lfz0I+D8wpS77e+Ly+GZPpjbbQAgmQGQxjALMKsTljwIVz8Qh808YMbUKvu7rXrbn78XyQBAGuuVZiEPn1oUh80sC2RK3OBYrsBFy2C0bNmfZAAgMT57zdNa4d6n4fJb4tBZyQBgclf/Cfz4nij7m2XZn7Rv8fO8j7uGkfb6hUlikulsheUfhSNm1xoGiQnNxgD0DsLpX4LntkJrwYyMZAZAGseJpzUfPea/eKPbAExiNiZJ4Ju/grUboKPF34NkACAx/gcC53TFobNbH/dA4GR0aMzn4LFN8MUb4nCmWzGSAYDERG0FjJbhoiU2nGES7mgAWLAEtg1Hiaarf8kAQGKiDqDN6oBrV8FP7zELMNFlfysegyvuiAZNlv1JBgASE70P3dkKFy+zLHAi+/2PFOGTi2Llj4cvJQMAaTICgO7qbYGWBU7M884l8LOVsHxN3NRoS2bJAEBiMjsEfnU5PLE50tOeCRindr8JbBmAT18L09oNtiQDAGkKlAU+tw0+d11kpN0GmICyP2v+JQMAaUqUBXbCFbfH4TQPBI5T2d/GatmfHf8kxuY2QKNoaUxK0/I5OP8auOav486A9NCaxqjsb2kctpztdb+SGQBpqihV4lDa8jVw5crYr/YswNiW/X3vdsv+JAMAaaoGAe3w6UVxWC1nWeCYlf2df00EApb9SQYA0pScsDoKsGYDXParmLzMAnDAZX9XVsv+plv2JxkASFM5CzC7Mw6rPbqxWhbopHVgZX+LLPuTDACkBpi4Crk4rHbR0h0PsWnfy/4u+1VkVCz7kwwAJBqiOVBHHFqzLHD/yv5yucigfPGGyKi4+pcMAKTGkNTKAkeK3hPAPpb9JUQGZduQt/1JBgBSg61ip1fLAn9mWSD7WvZ30xrL/qTxVnCDUhq/yWxaG3zqGnjbq2B6u82B9qbsr1iGjy+EQoKHKCQzAFLjlgWu3QgXLzULwF6W/f3HbXDXk972JxkASA2sWIkDgZdXL7HJWRa4x7K/3kH43GLobPPgn2QAIDX4ibZ8DvpH4LyrqrcFugXwomV/Fy+FdX2W/UkGABLNcRZgRjtcfX8cbssnlgXuruzvkQ2RKZlh0x/JAEBqmtvskkhxf3xhHHKzLLDu+SSRGfnEVZEpyec8KyExIdcB+wykCckCdLfBHU/Cd2+DD7+uWvKW+FzyuSiXvOr+qJRIy/78bpLMAEhNc09Adxt8dnEcdsv6bYE7l/3lE7ztTzIAkJpzwmsvxCG3i5d6W2Ba9vfd2+DOpyz7kwwAJJr7noAZ7XDZL7NdFlhf9vfZxdDd4sE/CTsBSk3+0uWgdwTOXQj/+REoJ9lc/edzcPESWLcFerps+SuZAZBo/oNvMzvg5/fBwvuyVxaYlv2t3RDX/c7oiIZJkgwAJLJQGtiSi653I6VslQWmZX/nLoSBkciImImUDACkzKyCp7XBXU/BN27Ozj0BaeljWvY3oz1b2Q/JAEASpUoEAV9dDuu3NX9VwA5lfz+37E8yAJDIdlngk1tiK6DZ+wLsUPbnbX+SAYBExssCZ3XAFbfDvU83b1lguvrvHYTPXhsNkSz7kwwApEzL52D7MHzq6ua9LTBd/V+8FNb1RuajmbMdkgGAJPbmYNysTrjuQbiqCcsC07K/lU/Dpb+IEkhX/5IBgKRKrTPeZ69tvrLAtOzv/Kuj7C+fg0rZX7vEpN8GaCQuTYkswLS26In/LzfB//i95rgtML3tb+FKuG5VrP6LJbzuTzIDIKm+LHB6O1y8DB7b1Pi9AdKDfyOlyGzkc875kgGApN1OmG15eG4r/POyxt8GSA/+feMmuGudZX+SAYAk9lQW2NMF/34rrHgsVs2NeCCwXF39r98G/295TP4e/JMMACTtQZLAaBkWLG7cSbP+UOOTWyz7kwwAJLFXZYEdsOgB+OndjZcFqC/7u+L2+Cxe9SsZAEjayxR6ZytctAS2DjXWeYAXyv6uigZHeb9lJAMASXsfAHRXbwv85i8jnd4I2wFp6eLCldHYaFZnczU1kgwAJDERBwJnd8JXboyywPwULwu07E9qLAXfUGnqTqiteXimN8oCv3ZOtYwumbpZi3yuWvb3FMztqmv6I8kMgKR9yAKUoizwOyvg1ilcFrhD2d+Nlv1JBgCSGIuywHIFzv05jBSn5oHAHcr+Nlv2JxkASGIsDtbNaIcb18CV90y9FsEvlP2tgyt+HQf/LPuTDAAkjeE9AZ+8GrYMTK0sQP1tf5b9STTQbYA+A4lGOBDYXoDVG+DSX8DH3z41bgusv+1v8SqY6epfMgMgaWwVK1EWeMkyeHRjTLyTeblOWvY3WoILLPuTDAAkjdeMC4VcdAb83OIX/ojJvu3va9WyP2/7kwwAJI1nc6AO+I/b4JZHJ68sMJ38LfuTDAAkTVwigEIezrtq8soC0/T/BYss+5OwE6CkiVp9T2+FGx+KssBzXjuxBwLTg38rHoV/uwXmdNrxTzIDIGlCywLPvwr6Bic+C1Auw4WLY+JPEn8fkgGAJCYqBd/RAms3wILrJq45ULr6//HdsOh+b/uTDAAkMRllgbM64bKbIxDIjXNZYLrvv3UQLroOOlun9u2EkgwApKY9DZjPwcAIfPxn0Y2vkozvtkMugct+CXc/Cd1tBgCSAYAkJu2egA64aiUsXx0HAccjJV+uxP/2YxvhKzfArC47/kkGAJImVxKZgP9zZUzK43EgME3/X7IMnumFVsv+JAMASUz6bXzT2uDOJ+HfV4z9gcD6sr9/XwE93Zb9SQYAkpgqZYHdrdGTv28wgoDKGAcBFy6Ovv+W/Uk0yW2ApvEkmqEssK0F1m2GBYvhoveNTXOgdPX/ozvhmvtgrqt/yQyApKmlWILpHXDpGJUFpvv+fYMRVHS2eOpfMgCQNCUV0rLAKw+8LDAt+/vmL+CeJ6G73QBAMgCQxFQtC5zZCT+7Fxau3P+ywPqyvy/fADMt+5MMACQx5W8LbMnDBdfASGn/ygJfKPtbatmfZAAgiUYrC/z68n0vC6wv+/uOZX+SAYAkGqoscFp7dO1bvy1W8/saBFx4rWV/kgGAJBqtLLC9AE9uhgsW7X1fgGJ19f+Tu+Fqb/uTDAAkNZ5iOSbw790G96576bLASvXU/7ahKPvr8rY/yQBAUmPK52D7EJy/8KXLAsvVAOCrN8I9TxkASM2ugC+41LRKpcgCLH4AFt4Lf/jq2iG/nQ8O5nPw6Ea4ZAnM7qyW/fn9IJkBkETDlgXmkz2XBab/5+cWwdahaCjk5C8ZAEiiwcsC26Ms8BvLdy0LTDMCtzwC3721bvUvyQBAEg1fFji9HS6+Lrr7pUFA2vBnpATn/by68rfsTzIAkNQkWYDqbYHP9kV3v3QbIO33/9O74MaHI0hw9S9lQzLrYxV3+qSsRPxJXBa07GPw+qMjMOgbhNMWwHNbbfkrmQGQ1JwRfxLd/S5cFCv9XALfuAnWroeOFid/yQBAEs16W+CsTrjmPlh0P2zuh88vhllddvyTyFwfAElk8TzAPy+Fn9wFQ6Mwo8UAQMIzAJKysBUwUoxtADv+SXYClER2LgtqzUNbfs/3A0hyC0BSEwYBxv8SHgKUJEkGAJIkyQBAkiQZAEiSJAMASZJkACBJkgwAJEnSVFOwD6AkSWYAJEmSAYAkSTIAkCRJBgCSJMkAQJIkGQBIkiQDAEmSZAAgSZIMACRJ0gQqYCdASZLMAEiSJAMASZJkACBJkmiK2wB9BpIkmQGQJEkGAJIkyQBAkiQZAEiSJAMASZKEnQAlSZIZAEmSZAAgSZIMACRJkgGAJEkyAJAkSQYAkiTJAECSJOFtgJIkyUZAkiQJtwAkSTIAkCRJBgCSJMkAQJIkGQBIkiQDAEmSZAAgSZIMACRJkgGAJEnCToCSJMkMgCRJMgCQJEl4G6AkSTIDIEmSDAAkSZIBgCRJMgCQJEkGAJIkGQD4CCRJwk6AkiTJDIAkSTIAkCRJBgCSJMkAQJIkGQBIkiQDAEmSZAAgSZLwOmBJkmQjIEmShFsAkiTJAECSJBkASJIkAwBJkmQAIEmSDAAkSTIA8BFIkmQAIEmSDAAkSRJ2ApQkSWYAJEmSAYAkScLbACVJkhkASZJkACBJkgwAJEmSAYAkSTIAkCRJBgCSJAk7AUqSJDMAkiTJAECSJBkASJJkAOAjkCTJAECSJBkASJIkvA1QkiSZAZAkSTYCkiRJZgAkSZIBgCRJMgCQJEkGAJIkaeL8f91cYtReFH5RAAAAAElFTkSuQmCC";

// Inline vector icon (favicon + manifest 'any' purpose).
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2E9BFF"/><stop offset="1" stop-color="#0A66FF"/></linearGradient></defs><rect width="512" height="512" rx="112" fill="url(#g)"/><path fill="#fff" d="M256 120a96 96 0 0 0-96 96c0 66 96 176 96 176s96-110 96-176a96 96 0 0 0-96-96z"/><circle cx="256" cy="216" r="40" fill="#0A66FF"/></svg>`;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ==== inlined from src/modules.js ==== */

// Auto-generated: the on-device module scripts, base64 (UTF-8 bytes). DO NOT EDIT BY HAND.
// Regenerate with: node scripts/gen-modules.mjs
// The worker serves these at /location-spoofer.js, /location-settings.js and
// /location-spoofer-qx.js so the whole stateless setup runs from the worker (no GitHub dep).
const LOCATION_SPOOFER_B64 = "LyoKICog5ZCI5oiQIEFwcGxlIC9jbGxzL3dsb2Mg5LuL6Z2i55qE5Zue5oeJ77yM6KejIEFSUEMg5bCB5YyF77yM5pS5IFdpRmkg54ax6bue5ZKM5Z+65Zyw5Y+w5bqn5qiZ77yMCiAqIOWGjeS+nSBBcHBsZSDnmoTmoLzlvI/pgIHlm57ljrvntabns7vntbHjgIIKICoKICog5Li76KaB5rWB56iL77yaCiAqICAgQVJQQyDlsIHljIUg4oaSIHByb3RvYnVmIOino+eivOWtl+S4siDihpIg5pu/5o+bIExvY2F0aW9uIOWtkOioiuaBr+eahOW6p+aome+8j+eyvuW6pu+8j+mBi+WLleeLgOaFiwogKiAgIOKGkiBwcm90b2J1ZiDph43mlrDmiZPljIUg4oaSIOS+neWOn+agvOW8j++8iEFSUEMgLyBtYXJrZXIgLyBzeW50aGV0aWPvvInlsIHoo50KICovCihmdW5jdGlvbiAoKSB7CiAgInVzZSBzdHJpY3QiOwoKICB2YXIgREVGQVVMVF9DT05GSUcgPSB7CiAgICBlbmFibGVkOiBmYWxzZSwKICAgIG1vZGU6ICJyZXNwb25zZSIsCiAgICBsYXRpdHVkZTogMzcuMzM0OSwKICAgIGxvbmdpdHVkZTogLTEyMi4wMDkwMiwKICAgIGhvcml6b250YWxBY2N1cmFjeTogMzksCiAgICB2ZXJ0aWNhbEFjY3VyYWN5OiAxMDAwLAogICAgcmFuZG9tUmFkaXVzOiAwLAogICAgYWx0aXR1ZGU6IDUzMCwKICAgIHVua25vd25WYWx1ZTQ6IDMsCiAgICBtb3Rpb25BY3Rpdml0eVR5cGU6IDYzLAogICAgbW90aW9uQWN0aXZpdHlDb25maWRlbmNlOiA0NjcsCiAgICBmYWlsT3BlbjogdHJ1ZSwKICAgIGRlYnVnOiBmYWxzZSwKICAgIGR1bXBSYXc6IGZhbHNlLAogICAgZHVtcEhlYWRlcnM6IGZhbHNlLAogICAgcHJlcGFyZUhlYWRlcnM6IGZhbHNlLAogICAgcmF3TGltaXQ6IDAKICB9OwoKICB2YXIgQVBQTEVfV0xPQ19QUkVGSVggPSBieXRlc0Zyb21BcnJheShbMHgwMCwgMHgwMSwgMHgwMCwgMHgwMCwgMHgwMCwgMHgwMSwgMHgwMCwgMHgwMF0pOwogIHZhciBBUFBMRV9XTE9DX01BUktFUiA9IGJ5dGVzRnJvbUFycmF5KFsweDAwLCAweDAwLCAweDAwLCAweDAxLCAweDAwLCAweDAwXSk7CiAgdmFyIFJPT1RfRFJPUF9GSUVMRFMgPSB7IDM6IHRydWUsIDQ6IHRydWUsIDMzOiB0cnVlIH07CiAgdmFyIENFTExfUkVTUE9OU0VfRklFTERTID0geyAyMjogdHJ1ZSwgMjQ6IHRydWUgfTsKICB2YXIgTE9DQVRJT05fUkVQTEFDRURfRklFTERTID0gewogICAgMTogdHJ1ZSwgMjogdHJ1ZSwgMzogdHJ1ZSwgNDogdHJ1ZSwgNTogdHJ1ZSwgNjogdHJ1ZSwgMTE6IHRydWUsIDEyOiB0cnVlCiAgfTsKCiAgZnVuY3Rpb24gYnl0ZXNGcm9tQXJyYXkodmFsdWVzKSB7IHJldHVybiBuZXcgVWludDhBcnJheSh2YWx1ZXMpOyB9CgogIGZ1bmN0aW9uIGNvbmNhdEJ5dGVzKHBhcnRzKSB7CiAgICB2YXIgdG90YWwgPSAwOwogICAgdmFyIGk7CiAgICBmb3IgKGkgPSAwOyBpIDwgcGFydHMubGVuZ3RoOyBpICs9IDEpIHsgdG90YWwgKz0gcGFydHNbaV0ubGVuZ3RoOyB9CiAgICB2YXIgb3V0ID0gbmV3IFVpbnQ4QXJyYXkodG90YWwpOwogICAgdmFyIG9mZnNldCA9IDA7CiAgICBmb3IgKGkgPSAwOyBpIDwgcGFydHMubGVuZ3RoOyBpICs9IDEpIHsgb3V0LnNldChwYXJ0c1tpXSwgb2Zmc2V0KTsgb2Zmc2V0ICs9IHBhcnRzW2ldLmxlbmd0aDsgfQogICAgcmV0dXJuIG91dDsKICB9CgogIGZ1bmN0aW9uIGJ5dGVzRXF1YWxQcmVmaXgoYnl0ZXMsIHByZWZpeCkgewogICAgaWYgKCFieXRlcyB8fCBieXRlcy5sZW5ndGggPCBwcmVmaXgubGVuZ3RoKSB7IHJldHVybiBmYWxzZTsgfQogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBwcmVmaXgubGVuZ3RoOyBpICs9IDEpIHsKICAgICAgaWYgKGJ5dGVzW2ldICE9PSBwcmVmaXhbaV0pIHsgcmV0dXJuIGZhbHNlOyB9CiAgICB9CiAgICByZXR1cm4gdHJ1ZTsKICB9CgogIGZ1bmN0aW9uIGZpbmRCeXRlcyhieXRlcywgbWFya2VyKSB7CiAgICBpZiAoIWJ5dGVzIHx8ICFtYXJrZXIgfHwgbWFya2VyLmxlbmd0aCA9PT0gMCkgeyByZXR1cm4gLTE7IH0KICAgIGZvciAodmFyIGkgPSAwOyBpIDw9IGJ5dGVzLmxlbmd0aCAtIG1hcmtlci5sZW5ndGg7IGkgKz0gMSkgewogICAgICB2YXIgb2sgPSB0cnVlOwogICAgICBmb3IgKHZhciBqID0gMDsgaiA8IG1hcmtlci5sZW5ndGg7IGogKz0gMSkgewogICAgICAgIGlmIChieXRlc1tpICsgal0gIT09IG1hcmtlcltqXSkgeyBvayA9IGZhbHNlOyBicmVhazsgfQogICAgICB9CiAgICAgIGlmIChvaykgeyByZXR1cm4gaTsgfQogICAgfQogICAgcmV0dXJuIC0xOwogIH0KCiAgZnVuY3Rpb24gdHJ5UGFyc2VGaWVsZHMoYnl0ZXMpIHsKICAgIHRyeSB7CiAgICAgIGlmICghYnl0ZXMgfHwgYnl0ZXMubGVuZ3RoID09PSAwKSB7IHJldHVybiBudWxsOyB9CiAgICAgIHZhciBmaWVsZHMgPSBwYXJzZUZpZWxkcyhieXRlcyk7CiAgICAgIHJldHVybiBmaWVsZHMubGVuZ3RoID4gMCA/IGZpZWxkcyA6IG51bGw7CiAgICB9IGNhdGNoIChlKSB7IHJldHVybiBudWxsOyB9CiAgfQoKICBmdW5jdGlvbiBiaW5hcnlTdHJpbmdUb0J5dGVzKHZhbHVlKSB7CiAgICB2YXIgb3V0ID0gbmV3IFVpbnQ4QXJyYXkodmFsdWUubGVuZ3RoKTsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgdmFsdWUubGVuZ3RoOyBpICs9IDEpIHsgb3V0W2ldID0gdmFsdWUuY2hhckNvZGVBdChpKSAmIDB4ZmY7IH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICBmdW5jdGlvbiBieXRlc1RvQmluYXJ5U3RyaW5nKGJ5dGVzKSB7CiAgICB2YXIgY2h1bmtTaXplID0gMHg4MDAwOwogICAgdmFyIGNodW5rcyA9IFtdOwogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBieXRlcy5sZW5ndGg7IGkgKz0gY2h1bmtTaXplKSB7CiAgICAgIHZhciBjaHVuayA9IGJ5dGVzLnN1YmFycmF5KGksIGkgKyBjaHVua1NpemUpOwogICAgICBjaHVua3MucHVzaChTdHJpbmcuZnJvbUNoYXJDb2RlLmFwcGx5KG51bGwsIEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGNodW5rKSkpOwogICAgfQogICAgcmV0dXJuIGNodW5rcy5qb2luKCIiKTsKICB9CgogIGZ1bmN0aW9uIGJ5dGVzVG9CYXNlNjQoYnl0ZXMpIHsKICAgIHZhciBhbHBoYWJldCA9ICJBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWmFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6MDEyMzQ1Njc4OSsvIjsKICAgIHZhciBvdXQgPSAiIjsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgYnl0ZXMubGVuZ3RoOyBpICs9IDMpIHsKICAgICAgdmFyIGIwID0gYnl0ZXNbaV07CiAgICAgIHZhciBiMSA9IGkgKyAxIDwgYnl0ZXMubGVuZ3RoID8gYnl0ZXNbaSArIDFdIDogMDsKICAgICAgdmFyIGIyID0gaSArIDIgPCBieXRlcy5sZW5ndGggPyBieXRlc1tpICsgMl0gOiAwOwogICAgICB2YXIgdHJpcGxlID0gKGIwIDw8IDE2KSB8IChiMSA8PCA4KSB8IGIyOwogICAgICBvdXQgKz0gYWxwaGFiZXRbKHRyaXBsZSA+PiAxOCkgJiAweDNmXTsKICAgICAgb3V0ICs9IGFscGhhYmV0Wyh0cmlwbGUgPj4gMTIpICYgMHgzZl07CiAgICAgIG91dCArPSBpICsgMSA8IGJ5dGVzLmxlbmd0aCA/IGFscGhhYmV0Wyh0cmlwbGUgPj4gNikgJiAweDNmXSA6ICI9IjsKICAgICAgb3V0ICs9IGkgKyAyIDwgYnl0ZXMubGVuZ3RoID8gYWxwaGFiZXRbdHJpcGxlICYgMHgzZl0gOiAiPSI7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgZnVuY3Rpb24gaGV4UHJldmlldyhieXRlcywgbGltaXQpIHsKICAgIGlmICghYnl0ZXMpIHsgcmV0dXJuICI8bm9uZT4iOyB9CiAgICB2YXIgb3V0ID0gW107CiAgICB2YXIgbWF4ID0gTWF0aC5taW4oYnl0ZXMubGVuZ3RoLCBsaW1pdCB8fCAxNik7CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IG1heDsgaSArPSAxKSB7CiAgICAgIG91dC5wdXNoKCgiMCIgKyBieXRlc1tpXS50b1N0cmluZygxNikpLnNsaWNlKC0yKSk7CiAgICB9CiAgICByZXR1cm4gb3V0LmpvaW4oIiIpOwogIH0KCiAgZnVuY3Rpb24gYm9keVRvQnl0ZXMoYm9keSkgewogICAgaWYgKGJvZHkgPT0gbnVsbCkgeyByZXR1cm4gbnVsbDsgfQogICAgaWYgKGJvZHkgaW5zdGFuY2VvZiBVaW50OEFycmF5KSB7IHJldHVybiBib2R5OyB9CiAgICBpZiAodHlwZW9mIEFycmF5QnVmZmVyICE9PSAidW5kZWZpbmVkIiAmJiBib2R5IGluc3RhbmNlb2YgQXJyYXlCdWZmZXIpIHsgcmV0dXJuIG5ldyBVaW50OEFycmF5KGJvZHkpOyB9CiAgICBpZiAodHlwZW9mIGJvZHkgPT09ICJzdHJpbmciKSB7IHJldHVybiBiaW5hcnlTdHJpbmdUb0J5dGVzKGJvZHkpOyB9CiAgICBpZiAodHlwZW9mIGJvZHkgPT09ICJvYmplY3QiICYmIHR5cGVvZiBib2R5Lmxlbmd0aCA9PT0gIm51bWJlciIpIHsgcmV0dXJuIG5ldyBVaW50OEFycmF5KGJvZHkpOyB9CiAgICBpZiAodHlwZW9mIGJvZHkgPT09ICJvYmplY3QiICYmIGJvZHkuYnl0ZXMgJiYgdHlwZW9mIGJvZHkuYnl0ZXMubGVuZ3RoID09PSAibnVtYmVyIikgeyByZXR1cm4gbmV3IFVpbnQ4QXJyYXkoYm9keS5ieXRlcyk7IH0KICAgIGlmICh0eXBlb2YgYm9keSA9PT0gIm9iamVjdCIgJiYgYm9keS5kYXRhICYmIHR5cGVvZiBib2R5LmRhdGEubGVuZ3RoID09PSAibnVtYmVyIikgeyByZXR1cm4gbmV3IFVpbnQ4QXJyYXkoYm9keS5kYXRhKTsgfQogICAgcmV0dXJuIG51bGw7CiAgfQoKICBmdW5jdGlvbiBtZXNzYWdlQm9keVRvQnl0ZXMobWVzc2FnZSkgewogICAgaWYgKCFtZXNzYWdlKSB7IHJldHVybiBudWxsOyB9CiAgICByZXR1cm4gKGJvZHlUb0J5dGVzKG1lc3NhZ2UuYm9keUJ5dGVzKSB8fCBib2R5VG9CeXRlcyhtZXNzYWdlLmJvZHkpIHx8IGJvZHlUb0J5dGVzKG1lc3NhZ2UucmF3Qm9keSkgfHwgYm9keVRvQnl0ZXMobWVzc2FnZS5iaW5hcnlCb2R5KSk7CiAgfQoKICBmdW5jdGlvbiByZWFkVUludDE2QkUoYnl0ZXMsIG9mZnNldCkgewogICAgaWYgKG9mZnNldCArIDIgPiBieXRlcy5sZW5ndGgpIHsgdGhyb3cgbmV3IEVycm9yKCJ1aW50MTYgb3V0IG9mIHJhbmdlIik7IH0KICAgIHJldHVybiAoYnl0ZXNbb2Zmc2V0XSA8PCA4KSB8IGJ5dGVzW29mZnNldCArIDFdOwogIH0KCiAgZnVuY3Rpb24gcmVhZFVJbnQzMkJFKGJ5dGVzLCBvZmZzZXQpIHsKICAgIGlmIChvZmZzZXQgKyA0ID4gYnl0ZXMubGVuZ3RoKSB7IHRocm93IG5ldyBFcnJvcigidWludDMyIG91dCBvZiByYW5nZSIpOyB9CiAgICByZXR1cm4gKChieXRlc1tvZmZzZXRdICogMHgxMDAwMDAwKSArICgoYnl0ZXNbb2Zmc2V0ICsgMV0gPDwgMTYpIHwgKGJ5dGVzW29mZnNldCArIDJdIDw8IDgpIHwgYnl0ZXNbb2Zmc2V0ICsgM10pKSA+Pj4gMDsKICB9CgogIGZ1bmN0aW9uIHdyaXRlVUludDE2QkUodmFsdWUpIHsKICAgIGlmICh2YWx1ZSA8IDAgfHwgdmFsdWUgPiAweGZmZmYpIHsgdGhyb3cgbmV3IEVycm9yKCJ1aW50MTYgdmFsdWUgb3V0IG9mIHJhbmdlOiAiICsgdmFsdWUpOyB9CiAgICByZXR1cm4gYnl0ZXNGcm9tQXJyYXkoWyh2YWx1ZSA+PiA4KSAmIDB4ZmYsIHZhbHVlICYgMHhmZl0pOwogIH0KCiAgZnVuY3Rpb24gd3JpdGVVSW50MzJCRSh2YWx1ZSkgewogICAgcmV0dXJuIGJ5dGVzRnJvbUFycmF5KFsodmFsdWUgPj4+IDI0KSAmIDB4ZmYsICh2YWx1ZSA+Pj4gMTYpICYgMHhmZiwgKHZhbHVlID4+PiA4KSAmIDB4ZmYsIHZhbHVlICYgMHhmZl0pOwogIH0KCiAgZnVuY3Rpb24gYXNjaWlCeXRlcyh2YWx1ZSkgewogICAgdmFyIG91dCA9IG5ldyBVaW50OEFycmF5KHZhbHVlLmxlbmd0aCk7CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHZhbHVlLmxlbmd0aDsgaSArPSAxKSB7IG91dFtpXSA9IHZhbHVlLmNoYXJDb2RlQXQoaSkgJiAweDdmOyB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgZnVuY3Rpb24gZW5jb2RlVmFyaW50VW5zaWduZWQodmFsdWUpIHsKICAgIHZhciB2ID0gdHlwZW9mIHZhbHVlID09PSAiYmlnaW50IiA/IHZhbHVlIDogQmlnSW50KHZhbHVlKTsKICAgIGlmICh2IDwgMG4pIHsgdGhyb3cgbmV3IEVycm9yKCJuZWdhdGl2ZSB1bnNpZ25lZCB2YXJpbnQiKTsgfQogICAgdmFyIG91dCA9IFtdOwogICAgd2hpbGUgKHYgPj0gMHg4MG4pIHsgb3V0LnB1c2goTnVtYmVyKCh2ICYgMHg3Zm4pIHwgMHg4MG4pKTsgdiA+Pj0gN247IH0KICAgIG91dC5wdXNoKE51bWJlcih2KSk7CiAgICByZXR1cm4gYnl0ZXNGcm9tQXJyYXkob3V0KTsKICB9CgogIGZ1bmN0aW9uIGVuY29kZVZhcmludFNpZ25lZEludDY0KHZhbHVlKSB7CiAgICB2YXIgdiA9IHR5cGVvZiB2YWx1ZSA9PT0gImJpZ2ludCIgPyB2YWx1ZSA6IEJpZ0ludChNYXRoLnRydW5jKHZhbHVlKSk7CiAgICBpZiAodiA8IDBuKSB7IHYgPSBCaWdJbnQuYXNVaW50Tig2NCwgdik7IH0KICAgIHJldHVybiBlbmNvZGVWYXJpbnRVbnNpZ25lZCh2KTsKICB9CgogIGZ1bmN0aW9uIGRlY29kZVZhcmludChieXRlcywgb2Zmc2V0KSB7CiAgICB2YXIgcmVzdWx0ID0gMG47CiAgICB2YXIgc2hpZnQgPSAwbjsKICAgIHZhciBjdXJyZW50ID0gb2Zmc2V0OwogICAgd2hpbGUgKGN1cnJlbnQgPCBieXRlcy5sZW5ndGgpIHsKICAgICAgdmFyIGIgPSBieXRlc1tjdXJyZW50XTsKICAgICAgY3VycmVudCArPSAxOwogICAgICByZXN1bHQgfD0gQmlnSW50KGIgJiAweDdmKSA8PCBzaGlmdDsKICAgICAgaWYgKChiICYgMHg4MCkgPT09IDApIHsgcmV0dXJuIHsgdmFsdWU6IHJlc3VsdCwgb2Zmc2V0OiBjdXJyZW50IH07IH0KICAgICAgc2hpZnQgKz0gN247CiAgICAgIGlmIChzaGlmdCA+IDcwbikgeyB0aHJvdyBuZXcgRXJyb3IoInZhcmludCB0b28gbG9uZyIpOyB9CiAgICB9CiAgICB0aHJvdyBuZXcgRXJyb3IoInVudGVybWluYXRlZCB2YXJpbnQiKTsKICB9CgogIGZ1bmN0aW9uIG1ha2VLZXkoZmllbGROdW1iZXIsIHdpcmVUeXBlKSB7CiAgICByZXR1cm4gZW5jb2RlVmFyaW50VW5zaWduZWQoKEJpZ0ludChmaWVsZE51bWJlcikgPDwgM24pIHwgQmlnSW50KHdpcmVUeXBlKSk7CiAgfQoKICBmdW5jdGlvbiBtYWtlVmFyaW50RmllbGQoZmllbGROdW1iZXIsIHZhbHVlKSB7CiAgICByZXR1cm4gY29uY2F0Qnl0ZXMoW21ha2VLZXkoZmllbGROdW1iZXIsIDApLCBlbmNvZGVWYXJpbnRTaWduZWRJbnQ2NCh2YWx1ZSldKTsKICB9CgogIGZ1bmN0aW9uIG1ha2VMZW5ndGhEZWxpbWl0ZWRGaWVsZChmaWVsZE51bWJlciwgcGF5bG9hZCkgewogICAgcmV0dXJuIGNvbmNhdEJ5dGVzKFttYWtlS2V5KGZpZWxkTnVtYmVyLCAyKSwgZW5jb2RlVmFyaW50VW5zaWduZWQocGF5bG9hZC5sZW5ndGgpLCBwYXlsb2FkXSk7CiAgfQoKICBmdW5jdGlvbiBwYXJzZUZpZWxkcyhieXRlcykgewogICAgdmFyIGZpZWxkcyA9IFtdOwogICAgdmFyIG9mZnNldCA9IDA7CiAgICB3aGlsZSAob2Zmc2V0IDwgYnl0ZXMubGVuZ3RoKSB7CiAgICAgIHZhciBrZXlTdGFydCA9IG9mZnNldDsKICAgICAgdmFyIGtleSA9IGRlY29kZVZhcmludChieXRlcywgb2Zmc2V0KTsKICAgICAgb2Zmc2V0ID0ga2V5Lm9mZnNldDsKICAgICAgdmFyIGZpZWxkTnVtYmVyID0gTnVtYmVyKGtleS52YWx1ZSA+PiAzbik7CiAgICAgIHZhciB3aXJlVHlwZSA9IE51bWJlcihrZXkudmFsdWUgJiAweDduKTsKICAgICAgaWYgKGZpZWxkTnVtYmVyID09PSAwKSB7IHRocm93IG5ldyBFcnJvcigicHJvdG9idWYgZmllbGQgbnVtYmVyIDAiKTsgfQogICAgICB2YXIgdmFsdWVTdGFydCA9IG9mZnNldDsKICAgICAgdmFyIHZhbHVlRW5kOwogICAgICBpZiAod2lyZVR5cGUgPT09IDApIHsgdmFsdWVFbmQgPSBkZWNvZGVWYXJpbnQoYnl0ZXMsIG9mZnNldCkub2Zmc2V0OyB9CiAgICAgIGVsc2UgaWYgKHdpcmVUeXBlID09PSAxKSB7IHZhbHVlRW5kID0gb2Zmc2V0ICsgODsgfQogICAgICBlbHNlIGlmICh3aXJlVHlwZSA9PT0gMikgewogICAgICAgIHZhciBsZW5ndGhJbmZvID0gZGVjb2RlVmFyaW50KGJ5dGVzLCBvZmZzZXQpOwogICAgICAgIHZhciBsZW5ndGggPSBOdW1iZXIobGVuZ3RoSW5mby52YWx1ZSk7CiAgICAgICAgdmFsdWVTdGFydCA9IGxlbmd0aEluZm8ub2Zmc2V0OwogICAgICAgIHZhbHVlRW5kID0gdmFsdWVTdGFydCArIGxlbmd0aDsKICAgICAgfQogICAgICBlbHNlIGlmICh3aXJlVHlwZSA9PT0gNSkgeyB2YWx1ZUVuZCA9IG9mZnNldCArIDQ7IH0KICAgICAgZWxzZSB7IHRocm93IG5ldyBFcnJvcigidW5zdXBwb3J0ZWQgcHJvdG9idWYgd2lyZSB0eXBlOiAiICsgd2lyZVR5cGUpOyB9CiAgICAgIGlmICh2YWx1ZUVuZCA+IGJ5dGVzLmxlbmd0aCkgeyB0aHJvdyBuZXcgRXJyb3IoInByb3RvYnVmIGZpZWxkIGV4Y2VlZHMgYnVmZmVyIik7IH0KICAgICAgZmllbGRzLnB1c2goewogICAgICAgIGZpZWxkTnVtYmVyOiBmaWVsZE51bWJlciwgd2lyZVR5cGU6IHdpcmVUeXBlLCBrZXlTdGFydDoga2V5U3RhcnQsIHZhbHVlU3RhcnQ6IHZhbHVlU3RhcnQsCiAgICAgICAgdmFsdWVFbmQ6IHZhbHVlRW5kLCBlbmQ6IHZhbHVlRW5kLCByYXc6IGJ5dGVzLnNsaWNlKGtleVN0YXJ0LCB2YWx1ZUVuZCksCiAgICAgICAgdmFsdWVCeXRlczogYnl0ZXMuc2xpY2UodmFsdWVTdGFydCwgdmFsdWVFbmQpCiAgICAgIH0pOwogICAgICBvZmZzZXQgPSB2YWx1ZUVuZDsKICAgIH0KICAgIHJldHVybiBmaWVsZHM7CiAgfQoKICBmdW5jdGlvbiBmaXJzdEZpZWxkQnlOdW1iZXIoZmllbGRzLCBmaWVsZE51bWJlcikgewogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBmaWVsZHMubGVuZ3RoOyBpICs9IDEpIHsKICAgICAgaWYgKGZpZWxkc1tpXS5maWVsZE51bWJlciA9PT0gZmllbGROdW1iZXIpIHsgcmV0dXJuIGZpZWxkc1tpXTsgfQogICAgfQogICAgcmV0dXJuIG51bGw7CiAgfQoKICBmdW5jdGlvbiBzaWduZWRWYXJpbnRGaWVsZFZhbHVlKGZpZWxkKSB7CiAgICBpZiAoIWZpZWxkIHx8IGZpZWxkLndpcmVUeXBlICE9PSAwKSB7IHJldHVybiBudWxsOyB9CiAgICByZXR1cm4gQmlnSW50LmFzSW50Tig2NCwgZGVjb2RlVmFyaW50KGZpZWxkLnZhbHVlQnl0ZXMsIDApLnZhbHVlKTsKICB9CgogIGZ1bmN0aW9uIGxvY2F0aW9uU3VtbWFyeShsb2NhdGlvblBheWxvYWQpIHsKICAgIHRyeSB7CiAgICAgIHZhciBmaWVsZHMgPSBwYXJzZUZpZWxkcyhsb2NhdGlvblBheWxvYWQpOwogICAgICB2YXIgbGF0ID0gc2lnbmVkVmFyaW50RmllbGRWYWx1ZShmaXJzdEZpZWxkQnlOdW1iZXIoZmllbGRzLCAxKSk7CiAgICAgIHZhciBsb24gPSBzaWduZWRWYXJpbnRGaWVsZFZhbHVlKGZpcnN0RmllbGRCeU51bWJlcihmaWVsZHMsIDIpKTsKICAgICAgaWYgKGxhdCA9PSBudWxsIHx8IGxvbiA9PSBudWxsKSB7IHJldHVybiAiPG1pc3Npbmc+IjsgfQogICAgICByZXR1cm4gKE51bWJlcihsYXQpIC8gMTAwMDAwMDAwKS50b0ZpeGVkKDgpICsgIiwiICsgKE51bWJlcihsb24pIC8gMTAwMDAwMDAwKS50b0ZpeGVkKDgpOwogICAgfSBjYXRjaCAoZXJyKSB7IHJldHVybiAiPHBhcnNlLWZhaWxlZDoiICsgZXJyLm1lc3NhZ2UgKyAiPiI7IH0KICB9CgogIGZ1bmN0aW9uIHBhdGNoZWRQYXlsb2FkU3VtbWFyeShwYXlsb2FkKSB7CiAgICB0cnkgewogICAgICB2YXIgcm9vdEZpZWxkcyA9IHBhcnNlRmllbGRzKHBheWxvYWQpOwogICAgICB2YXIgcGFydHMgPSBbXTsKICAgICAgdmFyIHdpZmkgPSBmaXJzdEZpZWxkQnlOdW1iZXIocm9vdEZpZWxkcywgMik7CiAgICAgIGlmICh3aWZpICYmIHdpZmkud2lyZVR5cGUgPT09IDIpIHsKICAgICAgICB2YXIgd2lmaUxvY2F0aW9uID0gZmlyc3RGaWVsZEJ5TnVtYmVyKHBhcnNlRmllbGRzKHdpZmkudmFsdWVCeXRlcyksIDIpOwogICAgICAgIHBhcnRzLnB1c2goImZpcnN0V2lmaT0iICsgKHdpZmlMb2NhdGlvbiA/IGxvY2F0aW9uU3VtbWFyeSh3aWZpTG9jYXRpb24udmFsdWVCeXRlcykgOiAiPG1pc3Npbmc+IikpOwogICAgICB9CiAgICAgIHZhciBjZWxsID0gZmlyc3RDZWxsUmVzcG9uc2VGaWVsZChyb290RmllbGRzKTsKICAgICAgaWYgKGNlbGwgJiYgY2VsbC53aXJlVHlwZSA9PT0gMikgewogICAgICAgIHZhciBjZWxsTG9jYXRpb24gPSBmaXJzdEZpZWxkQnlOdW1iZXIocGFyc2VGaWVsZHMoY2VsbC52YWx1ZUJ5dGVzKSwgNSk7CiAgICAgICAgcGFydHMucHVzaCgiZmlyc3RDZWxsPSIgKyAoY2VsbExvY2F0aW9uID8gbG9jYXRpb25TdW1tYXJ5KGNlbGxMb2NhdGlvbi52YWx1ZUJ5dGVzKSA6ICI8bWlzc2luZz4iKSk7CiAgICAgIH0KICAgICAgcmV0dXJuIHBhcnRzLmxlbmd0aCA/IHBhcnRzLmpvaW4oIiwgIikgOiAibm8gd2lmaS9jZWxsIGxvY2F0aW9uIGZpZWxkcyI7CiAgICB9IGNhdGNoIChlcnIpIHsgcmV0dXJuICJzdW1tYXJ5IGZhaWxlZDogIiArIGVyci5tZXNzYWdlOyB9CiAgfQoKICBmdW5jdGlvbiBpc0NlbGxSZXNwb25zZUZpZWxkKGZpZWxkTnVtYmVyKSB7IHJldHVybiBDRUxMX1JFU1BPTlNFX0ZJRUxEU1tmaWVsZE51bWJlcl0gPT09IHRydWU7IH0KCiAgZnVuY3Rpb24gZmlyc3RDZWxsUmVzcG9uc2VGaWVsZChmaWVsZHMpIHsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZmllbGRzLmxlbmd0aDsgaSArPSAxKSB7CiAgICAgIGlmIChpc0NlbGxSZXNwb25zZUZpZWxkKGZpZWxkc1tpXS5maWVsZE51bWJlcikpIHsgcmV0dXJuIGZpZWxkc1tpXTsgfQogICAgfQogICAgcmV0dXJuIG51bGw7CiAgfQoKICBmdW5jdGlvbiBjb29yZFRvSW50KHZhbHVlKSB7IHJldHVybiBNYXRoLnRydW5jKE51bWJlcih2YWx1ZSkgKiAxMDAwMDAwMDApOyB9CgogIGZ1bmN0aW9uIHBhcnNlQm9vbGVhbih2YWx1ZSwgZGVmYXVsdFZhbHVlKSB7CiAgICBpZiAodmFsdWUgPT09IHRydWUgfHwgdmFsdWUgPT09IGZhbHNlKSB7IHJldHVybiB2YWx1ZTsgfQogICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gInN0cmluZyIpIHsKICAgICAgdmFyIG5vcm1hbGl6ZWQgPSB2YWx1ZS50cmltKCkudG9Mb3dlckNhc2UoKTsKICAgICAgaWYgKG5vcm1hbGl6ZWQgPT09ICJ0cnVlIiB8fCBub3JtYWxpemVkID09PSAiMSIgfHwgbm9ybWFsaXplZCA9PT0gInllcyIgfHwgbm9ybWFsaXplZCA9PT0gIm9uIikgeyByZXR1cm4gdHJ1ZTsgfQogICAgICBpZiAobm9ybWFsaXplZCA9PT0gImZhbHNlIiB8fCBub3JtYWxpemVkID09PSAiMCIgfHwgbm9ybWFsaXplZCA9PT0gIm5vIiB8fCBub3JtYWxpemVkID09PSAib2ZmIikgeyByZXR1cm4gZmFsc2U7IH0KICAgIH0KICAgIHJldHVybiBkZWZhdWx0VmFsdWU7CiAgfQoKICBmdW5jdGlvbiBub3JtYWxpemVDb25maWcoaW5wdXQpIHsKICAgIHZhciBjZmcgPSB7fTsKICAgIHZhciBrZXk7CiAgICBmb3IgKGtleSBpbiBERUZBVUxUX0NPTkZJRykgewogICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKERFRkFVTFRfQ09ORklHLCBrZXkpKSB7IGNmZ1trZXldID0gREVGQVVMVF9DT05GSUdba2V5XTsgfQogICAgfQogICAgaW5wdXQgPSBpbnB1dCB8fCB7fTsKICAgIGZvciAoa2V5IGluIGlucHV0KSB7CiAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoaW5wdXQsIGtleSkpIHsgY2ZnW2tleV0gPSBpbnB1dFtrZXldOyB9CiAgICB9CiAgICBjZmcuZW5hYmxlZCA9IHBhcnNlQm9vbGVhbihjZmcuZW5hYmxlZCwgdHJ1ZSk7CiAgICBjZmcuZmFpbE9wZW4gPSBwYXJzZUJvb2xlYW4oY2ZnLmZhaWxPcGVuLCB0cnVlKTsKICAgIHZhciBtb2RlID0gU3RyaW5nKGNmZy5tb2RlIHx8ICJyZXNwb25zZSIpLnRvTG93ZXJDYXNlKCk7CiAgICBjZmcubW9kZSA9IG1vZGUgPT09ICJyZXF1ZXN0IiB8fCBtb2RlID09PSAicHJlcGFyZSIgfHwgbW9kZSA9PT0gInByb2JlIiB8fCBtb2RlID09PSAiaW5zcGVjdCIgPyBtb2RlIDogInJlc3BvbnNlIjsKICAgIGNmZy5sYXRpdHVkZSA9IE51bWJlcihjZmcubGF0aXR1ZGUpOwogICAgY2ZnLmxvbmdpdHVkZSA9IE51bWJlcihjZmcubG9uZ2l0dWRlKTsKICAgIGNmZy5ob3Jpem9udGFsQWNjdXJhY3kgPSBNYXRoLnRydW5jKE51bWJlcihjZmcuaG9yaXpvbnRhbEFjY3VyYWN5KSk7CiAgICBjZmcudmVydGljYWxBY2N1cmFjeSA9IE1hdGgudHJ1bmMoTnVtYmVyKGNmZy52ZXJ0aWNhbEFjY3VyYWN5KSk7CiAgICBjZmcuYWx0aXR1ZGUgPSBNYXRoLnRydW5jKE51bWJlcihjZmcuYWx0aXR1ZGUpKTsKICAgIGNmZy51bmtub3duVmFsdWU0ID0gTWF0aC50cnVuYyhOdW1iZXIoY2ZnLnVua25vd25WYWx1ZTQpKTsKICAgIGNmZy5tb3Rpb25BY3Rpdml0eVR5cGUgPSBNYXRoLnRydW5jKE51bWJlcihjZmcubW90aW9uQWN0aXZpdHlUeXBlKSk7CiAgICBjZmcubW90aW9uQWN0aXZpdHlDb25maWRlbmNlID0gTWF0aC50cnVuYyhOdW1iZXIoY2ZnLm1vdGlvbkFjdGl2aXR5Q29uZmlkZW5jZSkpOwogICAgY2ZnLmR1bXBSYXcgPSBjZmcuZHVtcFJhdyA9PT0gdHJ1ZSB8fCBTdHJpbmcoY2ZnLmR1bXBSYXcpLnRvTG93ZXJDYXNlKCkgPT09ICJ0cnVlIjsKICAgIGNmZy5kdW1wSGVhZGVycyA9IGNmZy5kdW1wSGVhZGVycyA9PT0gdHJ1ZSB8fCBTdHJpbmcoY2ZnLmR1bXBIZWFkZXJzKS50b0xvd2VyQ2FzZSgpID09PSAidHJ1ZSI7CiAgICBjZmcucHJlcGFyZUhlYWRlcnMgPSBjZmcucHJlcGFyZUhlYWRlcnMgPT09IHRydWUgfHwgU3RyaW5nKGNmZy5wcmVwYXJlSGVhZGVycykudG9Mb3dlckNhc2UoKSA9PT0gInRydWUiOwogICAgY2ZnLnJhd0xpbWl0ID0gTWF0aC50cnVuYyhOdW1iZXIoY2ZnLnJhd0xpbWl0IHx8IDApKTsKICAgIGlmICghTnVtYmVyLmlzRmluaXRlKGNmZy5yYXdMaW1pdCkgfHwgY2ZnLnJhd0xpbWl0IDwgMCkgeyBjZmcucmF3TGltaXQgPSAwOyB9CiAgICBjZmcucmFuZG9tUmFkaXVzID0gTnVtYmVyKGNmZy5yYW5kb21SYWRpdXMpOwogICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoY2ZnLnJhbmRvbVJhZGl1cykgfHwgY2ZnLnJhbmRvbVJhZGl1cyA8IDApIHsgY2ZnLnJhbmRvbVJhZGl1cyA9IDA7IH0KICAgIGlmICghTnVtYmVyLmlzRmluaXRlKGNmZy5sYXRpdHVkZSkgfHwgY2ZnLmxhdGl0dWRlIDwgLTkwIHx8IGNmZy5sYXRpdHVkZSA+IDkwKSB7IHRocm93IG5ldyBFcnJvcigiaW52YWxpZCBsYXRpdHVkZSIpOyB9CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShjZmcubG9uZ2l0dWRlKSB8fCBjZmcubG9uZ2l0dWRlIDwgLTE4MCB8fCBjZmcubG9uZ2l0dWRlID4gMTgwKSB7IHRocm93IG5ldyBFcnJvcigiaW52YWxpZCBsb25naXR1ZGUiKTsgfQogICAgaWYgKGNmZy5yYW5kb21SYWRpdXMgPiAwKSB7CiAgICAgIHZhciBqaXR0ZXJlZCA9IGFwcGx5UmFuZG9tUmFkaXVzKGNmZy5sYXRpdHVkZSwgY2ZnLmxvbmdpdHVkZSwgY2ZnLnJhbmRvbVJhZGl1cyk7CiAgICAgIGNmZy5sYXRpdHVkZSA9IGppdHRlcmVkLmxhdGl0dWRlOwogICAgICBjZmcubG9uZ2l0dWRlID0gaml0dGVyZWQubG9uZ2l0dWRlOwogICAgICBjZmcucmFuZG9tRGlzdGFuY2UgPSBqaXR0ZXJlZC5kaXN0YW5jZTsKICAgIH0KICAgIHJldHVybiBjZmc7CiAgfQoKICBmdW5jdGlvbiBhcHBseVJhbmRvbVJhZGl1cyhsYXQsIGxvbiwgcmFkaXVzTWV0ZXJzKSB7CiAgICB2YXIgciA9IE51bWJlcihyYWRpdXNNZXRlcnMpOwogICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUocikgfHwgciA8PSAwKSB7IHJldHVybiB7IGxhdGl0dWRlOiBsYXQsIGxvbmdpdHVkZTogbG9uLCBkaXN0YW5jZTogMCB9OyB9CiAgICB2YXIgZGlzdGFuY2UgPSBNYXRoLnNxcnQoTWF0aC5yYW5kb20oKSkgKiByOwogICAgdmFyIGJlYXJpbmcgPSAyICogTWF0aC5yYW5kb20oKSAqIE1hdGguUEk7CiAgICB2YXIgYW5ndWxhciA9IGRpc3RhbmNlIC8gNjM3ODEzNzsKICAgIHZhciBsYXRSYWQgPSAobGF0ICogTWF0aC5QSSkgLyAxODA7CiAgICB2YXIgbG9uUmFkID0gKGxvbiAqIE1hdGguUEkpIC8gMTgwOwogICAgdmFyIG5ld0xhdCA9IE1hdGguYXNpbihNYXRoLnNpbihsYXRSYWQpICogTWF0aC5jb3MoYW5ndWxhcikgKyBNYXRoLmNvcyhsYXRSYWQpICogTWF0aC5zaW4oYW5ndWxhcikgKiBNYXRoLmNvcyhiZWFyaW5nKSk7CiAgICB2YXIgbmV3TG9uID0gKChsb25SYWQgKyBNYXRoLmF0YW4yKE1hdGguc2luKGJlYXJpbmcpICogTWF0aC5zaW4oYW5ndWxhcikgKiBNYXRoLmNvcyhsYXRSYWQpLCBNYXRoLmNvcyhhbmd1bGFyKSAtIE1hdGguc2luKGxhdFJhZCkgKiBNYXRoLnNpbihuZXdMYXQpKSArIDMgKiBNYXRoLlBJKSAlICgyICogTWF0aC5QSSkpIC0gTWF0aC5QSTsKICAgIHJldHVybiB7CiAgICAgIGxhdGl0dWRlOiBOdW1iZXIoKChuZXdMYXQgKiAxODApIC8gTWF0aC5QSSkudG9GaXhlZCg4KSksCiAgICAgIGxvbmdpdHVkZTogTnVtYmVyKCgobmV3TG9uICogMTgwKSAvIE1hdGguUEkpLnRvRml4ZWQoOCkpLAogICAgICBkaXN0YW5jZTogZGlzdGFuY2UKICAgIH07CiAgfQoKICBmdW5jdGlvbiBwYXRjaExvY2F0aW9uKGxvY2F0aW9uUGF5bG9hZCwgY29uZmlnKSB7CiAgICB2YXIgcGFydHMgPSBbXTsKICAgIHZhciBmaWVsZHMgPSBsb2NhdGlvblBheWxvYWQubGVuZ3RoID8gcGFyc2VGaWVsZHMobG9jYXRpb25QYXlsb2FkKSA6IFtdOwogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBmaWVsZHMubGVuZ3RoOyBpICs9IDEpIHsKICAgICAgaWYgKCFMT0NBVElPTl9SRVBMQUNFRF9GSUVMRFNbZmllbGRzW2ldLmZpZWxkTnVtYmVyXSkgeyBwYXJ0cy5wdXNoKGZpZWxkc1tpXS5yYXcpOyB9CiAgICB9CiAgICBwYXJ0cy5wdXNoKG1ha2VWYXJpbnRGaWVsZCgxLCBjb29yZFRvSW50KGNvbmZpZy5sYXRpdHVkZSkpKTsKICAgIHBhcnRzLnB1c2gobWFrZVZhcmludEZpZWxkKDIsIGNvb3JkVG9JbnQoY29uZmlnLmxvbmdpdHVkZSkpKTsKICAgIHBhcnRzLnB1c2gobWFrZVZhcmludEZpZWxkKDMsIGNvbmZpZy5ob3Jpem9udGFsQWNjdXJhY3kpKTsKICAgIHBhcnRzLnB1c2gobWFrZVZhcmludEZpZWxkKDQsIGNvbmZpZy51bmtub3duVmFsdWU0KSk7CiAgICBwYXJ0cy5wdXNoKG1ha2VWYXJpbnRGaWVsZCg1LCBjb25maWcuYWx0aXR1ZGUpKTsKICAgIHBhcnRzLnB1c2gobWFrZVZhcmludEZpZWxkKDYsIGNvbmZpZy52ZXJ0aWNhbEFjY3VyYWN5KSk7CiAgICBwYXJ0cy5wdXNoKG1ha2VWYXJpbnRGaWVsZCgxMSwgY29uZmlnLm1vdGlvbkFjdGl2aXR5VHlwZSkpOwogICAgcGFydHMucHVzaChtYWtlVmFyaW50RmllbGQoMTIsIGNvbmZpZy5tb3Rpb25BY3Rpdml0eUNvbmZpZGVuY2UpKTsKICAgIHJldHVybiBjb25jYXRCeXRlcyhwYXJ0cyk7CiAgfQoKICBmdW5jdGlvbiBwYXRjaFdpZmlEZXZpY2Uod2lmaVBheWxvYWQsIGNvbmZpZykgewogICAgdmFyIGZpZWxkcyA9IHBhcnNlRmllbGRzKHdpZmlQYXlsb2FkKTsKICAgIHZhciBwYXJ0cyA9IFtdOwogICAgdmFyIHBhdGNoZWRMb2NhdGlvbiA9IGZhbHNlOwogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBmaWVsZHMubGVuZ3RoOyBpICs9IDEpIHsKICAgICAgdmFyIGZpZWxkID0gZmllbGRzW2ldOwogICAgICBpZiAoZmllbGQuZmllbGROdW1iZXIgPT09IDIgJiYgZmllbGQud2lyZVR5cGUgPT09IDIpIHsKICAgICAgICBwYXJ0cy5wdXNoKG1ha2VMZW5ndGhEZWxpbWl0ZWRGaWVsZCgyLCBwYXRjaExvY2F0aW9uKGZpZWxkLnZhbHVlQnl0ZXMsIGNvbmZpZykpKTsKICAgICAgICBwYXRjaGVkTG9jYXRpb24gPSB0cnVlOwogICAgICB9IGVsc2UgeyBwYXJ0cy5wdXNoKGZpZWxkLnJhdyk7IH0KICAgIH0KICAgIGlmICghcGF0Y2hlZExvY2F0aW9uKSB7IHBhcnRzLnB1c2gobWFrZUxlbmd0aERlbGltaXRlZEZpZWxkKDIsIHBhdGNoTG9jYXRpb24oYnl0ZXNGcm9tQXJyYXkoW10pLCBjb25maWcpKSk7IH0KICAgIHJldHVybiBjb25jYXRCeXRlcyhwYXJ0cyk7CiAgfQoKICBmdW5jdGlvbiBwYXRjaENlbGxUb3dlcihjZWxsUGF5bG9hZCwgY29uZmlnKSB7CiAgICB2YXIgZmllbGRzID0gcGFyc2VGaWVsZHMoY2VsbFBheWxvYWQpOwogICAgdmFyIHBhcnRzID0gW107CiAgICB2YXIgcGF0Y2hlZExvY2F0aW9uID0gZmFsc2U7CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGZpZWxkcy5sZW5ndGg7IGkgKz0gMSkgewogICAgICB2YXIgZmllbGQgPSBmaWVsZHNbaV07CiAgICAgIGlmIChmaWVsZC5maWVsZE51bWJlciA9PT0gNSAmJiBmaWVsZC53aXJlVHlwZSA9PT0gMikgewogICAgICAgIHBhcnRzLnB1c2gobWFrZUxlbmd0aERlbGltaXRlZEZpZWxkKDUsIHBhdGNoTG9jYXRpb24oZmllbGQudmFsdWVCeXRlcywgY29uZmlnKSkpOwogICAgICAgIHBhdGNoZWRMb2NhdGlvbiA9IHRydWU7CiAgICAgIH0gZWxzZSB7IHBhcnRzLnB1c2goZmllbGQucmF3KTsgfQogICAgfQogICAgaWYgKCFwYXRjaGVkTG9jYXRpb24pIHsgcGFydHMucHVzaChtYWtlTGVuZ3RoRGVsaW1pdGVkRmllbGQoNSwgcGF0Y2hMb2NhdGlvbihieXRlc0Zyb21BcnJheShbXSksIGNvbmZpZykpKTsgfQogICAgcmV0dXJuIGNvbmNhdEJ5dGVzKHBhcnRzKTsKICB9CgogIGZ1bmN0aW9uIHBhdGNoQXBwbGVXTG9jUGF5bG9hZChwYXlsb2FkLCBjb25maWcpIHsKICAgIHZhciBmaWVsZHMgPSBwYXJzZUZpZWxkcyhwYXlsb2FkKTsKICAgIHZhciBwYXJ0cyA9IFtdOwogICAgdmFyIHdpZmlDb3VudCA9IDA7CiAgICB2YXIgY2VsbENvdW50ID0gMDsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZmllbGRzLmxlbmd0aDsgaSArPSAxKSB7CiAgICAgIHZhciBmaWVsZCA9IGZpZWxkc1tpXTsKICAgICAgaWYgKGZpZWxkLmZpZWxkTnVtYmVyID09PSAyICYmIGZpZWxkLndpcmVUeXBlID09PSAyKSB7CiAgICAgICAgcGFydHMucHVzaChtYWtlTGVuZ3RoRGVsaW1pdGVkRmllbGQoMiwgcGF0Y2hXaWZpRGV2aWNlKGZpZWxkLnZhbHVlQnl0ZXMsIGNvbmZpZykpKTsKICAgICAgICB3aWZpQ291bnQgKz0gMTsKICAgICAgfSBlbHNlIGlmIChpc0NlbGxSZXNwb25zZUZpZWxkKGZpZWxkLmZpZWxkTnVtYmVyKSAmJiBmaWVsZC53aXJlVHlwZSA9PT0gMikgewogICAgICAgIHBhcnRzLnB1c2gobWFrZUxlbmd0aERlbGltaXRlZEZpZWxkKGZpZWxkLmZpZWxkTnVtYmVyLCBwYXRjaENlbGxUb3dlcihmaWVsZC52YWx1ZUJ5dGVzLCBjb25maWcpKSk7CiAgICAgICAgY2VsbENvdW50ICs9IDE7CiAgICAgIH0gZWxzZSBpZiAoIVJPT1RfRFJPUF9GSUVMRFNbZmllbGQuZmllbGROdW1iZXJdKSB7IHBhcnRzLnB1c2goZmllbGQucmF3KTsgfQogICAgfQogICAgcmV0dXJuIHsgcGF5bG9hZDogY29uY2F0Qnl0ZXMocGFydHMpLCB3aWZpQ291bnQ6IHdpZmlDb3VudCwgY2VsbENvdW50OiBjZWxsQ291bnQgfTsKICB9CgogIGZ1bmN0aW9uIHJlYWRQYXNjYWxTdHJpbmcoYnl0ZXMsIHN0YXRlKSB7CiAgICB2YXIgbGVuZ3RoID0gcmVhZFVJbnQxNkJFKGJ5dGVzLCBzdGF0ZS5vZmZzZXQpOwogICAgc3RhdGUub2Zmc2V0ICs9IDI7CiAgICBpZiAoc3RhdGUub2Zmc2V0ICsgbGVuZ3RoID4gYnl0ZXMubGVuZ3RoKSB7IHRocm93IG5ldyBFcnJvcigiQVJQQyBwYXNjYWwgc3RyaW5nIGV4Y2VlZHMgYnVmZmVyIik7IH0KICAgIHZhciBjaGFycyA9IFtdOwogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW5ndGg7IGkgKz0gMSkgeyBjaGFycy5wdXNoKFN0cmluZy5mcm9tQ2hhckNvZGUoYnl0ZXNbc3RhdGUub2Zmc2V0ICsgaV0pKTsgfQogICAgc3RhdGUub2Zmc2V0ICs9IGxlbmd0aDsKICAgIHJldHVybiBjaGFycy5qb2luKCIiKTsKICB9CgogIGZ1bmN0aW9uIHdyaXRlUGFzY2FsU3RyaW5nKHZhbHVlKSB7CiAgICB2YXIgYnl0ZXMgPSBhc2NpaUJ5dGVzKHZhbHVlKTsKICAgIHJldHVybiBjb25jYXRCeXRlcyhbd3JpdGVVSW50MTZCRShieXRlcy5sZW5ndGgpLCBieXRlc10pOwogIH0KCiAgZnVuY3Rpb24gcGFyc2VBcnBjKGJ5dGVzKSB7CiAgICB2YXIgc3RhdGUgPSB7IG9mZnNldDogMCB9OwogICAgdmFyIHZlcnNpb24gPSByZWFkVUludDE2QkUoYnl0ZXMsIHN0YXRlLm9mZnNldCk7CiAgICBzdGF0ZS5vZmZzZXQgKz0gMjsKICAgIHZhciBsb2NhbGUgPSByZWFkUGFzY2FsU3RyaW5nKGJ5dGVzLCBzdGF0ZSk7CiAgICB2YXIgYXBwSWRlbnRpZmllciA9IHJlYWRQYXNjYWxTdHJpbmcoYnl0ZXMsIHN0YXRlKTsKICAgIHZhciBvc1ZlcnNpb24gPSByZWFkUGFzY2FsU3RyaW5nKGJ5dGVzLCBzdGF0ZSk7CiAgICB2YXIgZnVuY3Rpb25JZCA9IHJlYWRVSW50MzJCRShieXRlcywgc3RhdGUub2Zmc2V0KTsKICAgIHN0YXRlLm9mZnNldCArPSA0OwogICAgdmFyIHBheWxvYWRMZW5ndGggPSByZWFkVUludDMyQkUoYnl0ZXMsIHN0YXRlLm9mZnNldCk7CiAgICBzdGF0ZS5vZmZzZXQgKz0gNDsKICAgIGlmIChzdGF0ZS5vZmZzZXQgKyBwYXlsb2FkTGVuZ3RoID4gYnl0ZXMubGVuZ3RoKSB7IHRocm93IG5ldyBFcnJvcigiQVJQQyBwYXlsb2FkIGV4Y2VlZHMgYnVmZmVyIik7IH0KICAgIHJldHVybiB7CiAgICAgIHZlcnNpb246IHZlcnNpb24sIGxvY2FsZTogbG9jYWxlLCBhcHBJZGVudGlmaWVyOiBhcHBJZGVudGlmaWVyLAogICAgICBvc1ZlcnNpb246IG9zVmVyc2lvbiwgZnVuY3Rpb25JZDogZnVuY3Rpb25JZCwKICAgICAgcGF5bG9hZDogYnl0ZXMuc2xpY2Uoc3RhdGUub2Zmc2V0LCBzdGF0ZS5vZmZzZXQgKyBwYXlsb2FkTGVuZ3RoKQogICAgfTsKICB9CgogIGZ1bmN0aW9uIHNlcmlhbGl6ZUFycGMoYXJwYykgewogICAgcmV0dXJuIGNvbmNhdEJ5dGVzKFsKICAgICAgd3JpdGVVSW50MTZCRShhcnBjLnZlcnNpb24pLCB3cml0ZVBhc2NhbFN0cmluZyhhcnBjLmxvY2FsZSksCiAgICAgIHdyaXRlUGFzY2FsU3RyaW5nKGFycGMuYXBwSWRlbnRpZmllciksIHdyaXRlUGFzY2FsU3RyaW5nKGFycGMub3NWZXJzaW9uKSwKICAgICAgd3JpdGVVSW50MzJCRShhcnBjLmZ1bmN0aW9uSWQpLCB3cml0ZVVJbnQzMkJFKGFycGMucGF5bG9hZC5sZW5ndGgpLCBhcnBjLnBheWxvYWQKICAgIF0pOwogIH0KCiAgZnVuY3Rpb24gYnVpbGRBcHBsZVdMb2NSZXNwb25zZShwYXlsb2FkLCBwcmVmaXgpIHsKICAgIHJldHVybiBjb25jYXRCeXRlcyhbcHJlZml4IHx8IEFQUExFX1dMT0NfUFJFRklYLCB3cml0ZVVJbnQxNkJFKHBheWxvYWQubGVuZ3RoKSwgcGF5bG9hZF0pOwogIH0KCiAgZnVuY3Rpb24gZXh0cmFjdFByZWZpeGVkQXBwbGVXTG9jUGF5bG9hZChyZXNwb25zZUJ5dGVzKSB7CiAgICBpZiAoIXJlc3BvbnNlQnl0ZXMgfHwgcmVzcG9uc2VCeXRlcy5sZW5ndGggPCAxMCkgeyByZXR1cm4gbnVsbDsgfQogICAgaWYgKHJlc3BvbnNlQnl0ZXNbMF0gIT09IDB4MDAgfHwgcmVzcG9uc2VCeXRlc1sxXSAhPT0gMHgwMSkgeyByZXR1cm4gbnVsbDsgfQogICAgaWYgKHJlc3BvbnNlQnl0ZXNbNl0gIT09IDB4MDAgfHwgcmVzcG9uc2VCeXRlc1s3XSAhPT0gMHgwMCkgeyByZXR1cm4gbnVsbDsgfQogICAgdmFyIHBheWxvYWRMZW5ndGggPSByZWFkVUludDE2QkUocmVzcG9uc2VCeXRlcywgOCk7CiAgICB2YXIgcGF5bG9hZE9mZnNldCA9IDEwOwogICAgaWYgKHBheWxvYWRMZW5ndGggPD0gMCB8fCBwYXlsb2FkT2Zmc2V0ICsgcGF5bG9hZExlbmd0aCA+IHJlc3BvbnNlQnl0ZXMubGVuZ3RoKSB7IHJldHVybiBudWxsOyB9CiAgICB2YXIgcGF5bG9hZCA9IHJlc3BvbnNlQnl0ZXMuc2xpY2UocGF5bG9hZE9mZnNldCwgcGF5bG9hZE9mZnNldCArIHBheWxvYWRMZW5ndGgpOwogICAgaWYgKHRyeVBhcnNlRmllbGRzKHBheWxvYWQpID09PSBudWxsKSB7IHJldHVybiBudWxsOyB9CiAgICByZXR1cm4gewogICAgICBraW5kOiAic3ludGhldGljIiwgcGF5bG9hZDogcGF5bG9hZCwKICAgICAgcHJlZml4OiByZXNwb25zZUJ5dGVzLnNsaWNlKDAsIDgpLAogICAgICBzdWZmaXg6IHJlc3BvbnNlQnl0ZXMuc2xpY2UocGF5bG9hZE9mZnNldCArIHBheWxvYWRMZW5ndGgpCiAgICB9OwogIH0KCiAgZnVuY3Rpb24gZXh0cmFjdEFwcGxlV0xvY1BheWxvYWQocmVzcG9uc2VCeXRlcykgewogICAgaWYgKCFyZXNwb25zZUJ5dGVzIHx8IHJlc3BvbnNlQnl0ZXMubGVuZ3RoIDwgMikgeyB0aHJvdyBuZXcgRXJyb3IoIkFwcGxlIFdMb2MgcmVzcG9uc2UgdG9vIHNob3J0Iik7IH0KICAgIHZhciBwcmVmaXhlZCA9IGV4dHJhY3RQcmVmaXhlZEFwcGxlV0xvY1BheWxvYWQocmVzcG9uc2VCeXRlcyk7CiAgICBpZiAocHJlZml4ZWQpIHsgcmV0dXJuIHByZWZpeGVkOyB9CiAgICB0cnkgewogICAgICB2YXIgYXJwYyA9IHBhcnNlQXJwYyhyZXNwb25zZUJ5dGVzKTsKICAgICAgaWYgKGFycGMucGF5bG9hZC5sZW5ndGggPiAwICYmIHRyeVBhcnNlRmllbGRzKGFycGMucGF5bG9hZCkgIT09IG51bGwpIHsKICAgICAgICByZXR1cm4geyBraW5kOiAiYXJwYyIsIHBheWxvYWQ6IGFycGMucGF5bG9hZCwgYXJwYzogYXJwYyB9OwogICAgICB9CiAgICB9IGNhdGNoIChlKSB7fQogICAgdmFyIG1hcmtlcklkeCA9IGZpbmRCeXRlcyhyZXNwb25zZUJ5dGVzLCBBUFBMRV9XTE9DX01BUktFUik7CiAgICBpZiAobWFya2VySWR4ID49IDApIHsKICAgICAgdmFyIGxlbk9mZnNldCA9IG1hcmtlcklkeCArIEFQUExFX1dMT0NfTUFSS0VSLmxlbmd0aDsKICAgICAgaWYgKGxlbk9mZnNldCArIDIgPD0gcmVzcG9uc2VCeXRlcy5sZW5ndGgpIHsKICAgICAgICB2YXIgcmVhbExlbiA9IHJlYWRVSW50MTZCRShyZXNwb25zZUJ5dGVzLCBsZW5PZmZzZXQpOwogICAgICAgIHZhciByZWFsUGF5bG9hZE9mZnNldCA9IGxlbk9mZnNldCArIDI7CiAgICAgICAgaWYgKHJlYWxMZW4gPiAwICYmIHJlYWxQYXlsb2FkT2Zmc2V0ICsgcmVhbExlbiA8PSByZXNwb25zZUJ5dGVzLmxlbmd0aCkgewogICAgICAgICAgdmFyIGNhbmRpZGF0ZVBheWxvYWQgPSByZXNwb25zZUJ5dGVzLnNsaWNlKHJlYWxQYXlsb2FkT2Zmc2V0LCByZWFsUGF5bG9hZE9mZnNldCArIHJlYWxMZW4pOwogICAgICAgICAgaWYgKHRyeVBhcnNlRmllbGRzKGNhbmRpZGF0ZVBheWxvYWQpICE9PSBudWxsKSB7CiAgICAgICAgICAgIHJldHVybiB7CiAgICAgICAgICAgICAga2luZDogIm1hcmtlciIsIHBheWxvYWQ6IGNhbmRpZGF0ZVBheWxvYWQsCiAgICAgICAgICAgICAgcHJlZml4OiByZXNwb25zZUJ5dGVzLnNsaWNlKDAsIG1hcmtlcklkeCksCiAgICAgICAgICAgICAgbWFya2VyQW5kTGVuOiByZXNwb25zZUJ5dGVzLnNsaWNlKG1hcmtlcklkeCwgcmVhbFBheWxvYWRPZmZzZXQpLAogICAgICAgICAgICAgIHN1ZmZpeDogcmVzcG9uc2VCeXRlcy5zbGljZShyZWFsUGF5bG9hZE9mZnNldCArIHJlYWxMZW4pCiAgICAgICAgICAgIH07CiAgICAgICAgICB9CiAgICAgICAgfQogICAgICB9CiAgICB9CiAgICBpZiAobG9va3NMaWtlQXBwbGVXTG9jUGF5bG9hZChyZXNwb25zZUJ5dGVzKSkgeyByZXR1cm4geyBraW5kOiAiYmFyZSIsIHBheWxvYWQ6IHJlc3BvbnNlQnl0ZXMgfTsgfQogICAgdGhyb3cgbmV3IEVycm9yKCJtaXNzaW5nIEFwcGxlIFdMb2MgcmVzcG9uc2UgcHJlZml4Iik7CiAgfQoKICBmdW5jdGlvbiBsb29rc0xpa2VBcHBsZVdMb2NQYXlsb2FkKGJ5dGVzKSB7CiAgICBpZiAoIWJ5dGVzIHx8IGJ5dGVzLmxlbmd0aCA9PT0gMCkgeyByZXR1cm4gZmFsc2U7IH0KICAgIHZhciB0YWcgPSBieXRlc1swXTsKICAgIHZhciBmaWVsZE51bWJlciA9IHRhZyA+PiAzOwogICAgdmFyIHdpcmVUeXBlID0gdGFnICYgMHg3OwogICAgcmV0dXJuIGZpZWxkTnVtYmVyID4gMCAmJiAod2lyZVR5cGUgPT09IDAgfHwgd2lyZVR5cGUgPT09IDIpOwogIH0KCiAgZnVuY3Rpb24gc3Bvb2ZBcnBjUmVxdWVzdChyZXF1ZXN0Qnl0ZXMsIGNvbmZpZ0lucHV0KSB7CiAgICB2YXIgY29uZmlnID0gbm9ybWFsaXplQ29uZmlnKGNvbmZpZ0lucHV0KTsKICAgIHZhciBhcnBjID0gcGFyc2VBcnBjKHJlcXVlc3RCeXRlcyk7CiAgICB2YXIgcGF0Y2hlZCA9IHBhdGNoQXBwbGVXTG9jUGF5bG9hZChhcnBjLnBheWxvYWQsIGNvbmZpZyk7CiAgICByZXR1cm4gewogICAgICByZXNwb25zZTogYnVpbGRBcHBsZVdMb2NSZXNwb25zZShwYXRjaGVkLnBheWxvYWQpLAogICAgICBwYXlsb2FkOiBwYXRjaGVkLnBheWxvYWQsIHdpZmlDb3VudDogcGF0Y2hlZC53aWZpQ291bnQsCiAgICAgIGNlbGxDb3VudDogcGF0Y2hlZC5jZWxsQ291bnQsIGFycGM6IGFycGMKICAgIH07CiAgfQoKICBmdW5jdGlvbiBzcG9vZkFwcGxlUmVzcG9uc2UocmVzcG9uc2VCeXRlcywgY29uZmlnSW5wdXQpIHsKICAgIHZhciBjb25maWcgPSBub3JtYWxpemVDb25maWcoY29uZmlnSW5wdXQpOwogICAgdmFyIGV4dHJhY3Rpb24gPSBleHRyYWN0QXBwbGVXTG9jUGF5bG9hZChyZXNwb25zZUJ5dGVzKTsKICAgIHZhciBwYXRjaGVkID0gcGF0Y2hBcHBsZVdMb2NQYXlsb2FkKGV4dHJhY3Rpb24ucGF5bG9hZCwgY29uZmlnKTsKICAgIHZhciByZXNwb25zZTsKICAgIGlmIChleHRyYWN0aW9uLmtpbmQgPT09ICJhcnBjIikgewogICAgICB2YXIgYXJwY091dCA9IHsKICAgICAgICB2ZXJzaW9uOiBleHRyYWN0aW9uLmFycGMudmVyc2lvbiwgbG9jYWxlOiBleHRyYWN0aW9uLmFycGMubG9jYWxlLAogICAgICAgIGFwcElkZW50aWZpZXI6IGV4dHJhY3Rpb24uYXJwYy5hcHBJZGVudGlmaWVyLCBvc1ZlcnNpb246IGV4dHJhY3Rpb24uYXJwYy5vc1ZlcnNpb24sCiAgICAgICAgZnVuY3Rpb25JZDogZXh0cmFjdGlvbi5hcnBjLmZ1bmN0aW9uSWQsIHBheWxvYWQ6IHBhdGNoZWQucGF5bG9hZAogICAgICB9OwogICAgICByZXNwb25zZSA9IHNlcmlhbGl6ZUFycGMoYXJwY091dCk7CiAgICB9IGVsc2UgaWYgKGV4dHJhY3Rpb24ua2luZCA9PT0gIm1hcmtlciIpIHsKICAgICAgdmFyIG5ld0xlbkJ5dGVzID0gd3JpdGVVSW50MTZCRShwYXRjaGVkLnBheWxvYWQubGVuZ3RoKTsKICAgICAgcmVzcG9uc2UgPSBjb25jYXRCeXRlcyhbCiAgICAgICAgZXh0cmFjdGlvbi5wcmVmaXgsIGV4dHJhY3Rpb24ubWFya2VyQW5kTGVuLnNsaWNlKDAsIEFQUExFX1dMT0NfTUFSS0VSLmxlbmd0aCksCiAgICAgICAgbmV3TGVuQnl0ZXMsIHBhdGNoZWQucGF5bG9hZCwgZXh0cmFjdGlvbi5zdWZmaXgKICAgICAgXSk7CiAgICB9IGVsc2UgewogICAgICByZXNwb25zZSA9IGJ1aWxkQXBwbGVXTG9jUmVzcG9uc2UocGF0Y2hlZC5wYXlsb2FkLCBleHRyYWN0aW9uLnByZWZpeCk7CiAgICB9CiAgICByZXR1cm4gewogICAgICByZXNwb25zZTogcmVzcG9uc2UsIHBheWxvYWQ6IHBhdGNoZWQucGF5bG9hZCwgd2lmaUNvdW50OiBwYXRjaGVkLndpZmlDb3VudCwKICAgICAgY2VsbENvdW50OiBwYXRjaGVkLmNlbGxDb3VudCwga2luZDogZXh0cmFjdGlvbi5raW5kLAogICAgICBwcmVmaXg6IGV4dHJhY3Rpb24ucHJlZml4ID8gaGV4UHJldmlldyhleHRyYWN0aW9uLnByZWZpeCwgOCkgOiAiIgogICAgfTsKICB9CgogIGZ1bmN0aW9uIHBhcnNlQXJndW1lbnRTdHJpbmcoYXJndW1lbnQpIHsKICAgIHZhciByZXN1bHQgPSB7fTsKICAgIGlmICghYXJndW1lbnQgfHwgdHlwZW9mIGFyZ3VtZW50ICE9PSAic3RyaW5nIikgeyByZXR1cm4gcmVzdWx0OyB9CiAgICB2YXIgdGFpbEtleXMgPSBbCiAgICAgICJkZWJ1ZyIsIm1vZGUiLCJlbmFibGVkIiwibGF0aXR1ZGUiLCJsb25naXR1ZGUiLCJhbHRpdHVkZSIsImFkZHJlc3MiLAogICAgICAiY29uZmlnSG9zdCIsImNvbmZpZ1Rva2VuIiwiaG9yaXpvbnRhbEFjY3VyYWN5IiwidmVydGljYWxBY2N1cmFjeSIsInJhbmRvbVJhZGl1cyIsCiAgICAgICJ1bmtub3duVmFsdWU0IiwibW90aW9uQWN0aXZpdHlUeXBlIiwibW90aW9uQWN0aXZpdHlDb25maWRlbmNlIiwiZmFpbE9wZW4iLAogICAgICAiZHVtcFJhdyIsImR1bXBIZWFkZXJzIiwicHJlcGFyZUhlYWRlcnMiLCJyYXdMaW1pdCIKICAgIF07CiAgICB2YXIgY29uZmlnVXJsS2V5ID0gImNvbmZpZ1VybD0iOwogICAgdmFyIGNvbmZpZ1VybElkeCA9IGFyZ3VtZW50LmluZGV4T2YoY29uZmlnVXJsS2V5KTsKICAgIGlmIChjb25maWdVcmxJZHggPj0gMCkgewogICAgICB2YXIgdmFsdWVTdGFydCA9IGNvbmZpZ1VybElkeCArIGNvbmZpZ1VybEtleS5sZW5ndGg7CiAgICAgIHZhciB0YWlsID0gYXJndW1lbnQuc2xpY2UodmFsdWVTdGFydCk7CiAgICAgIHZhciBlbmQgPSAtMTsKICAgICAgdmFyIGk7CiAgICAgIGZvciAoaSA9IDA7IGkgPCB0YWlsS2V5cy5sZW5ndGg7IGkgKz0gMSkgewogICAgICAgIHZhciBtYXJrZXIgPSAiJiIgKyB0YWlsS2V5c1tpXSArICI9IjsKICAgICAgICB2YXIgcG9zID0gdGFpbC5pbmRleE9mKG1hcmtlcik7CiAgICAgICAgaWYgKHBvcyA+PSAwICYmIChlbmQgPCAwIHx8IHBvcyA8IGVuZCkpIHsgZW5kID0gcG9zOyB9CiAgICAgIH0KICAgICAgdmFyIGNvbmZpZ1VybFZhbHVlID0gZW5kID49IDAgPyB0YWlsLnNsaWNlKDAsIGVuZCkgOiB0YWlsOwogICAgICB0cnkgeyByZXN1bHQuY29uZmlnVXJsID0gZGVjb2RlVVJJQ29tcG9uZW50KGNvbmZpZ1VybFZhbHVlKTsgfQogICAgICBjYXRjaCAoZXJyKSB7IHJlc3VsdC5jb25maWdVcmwgPSBjb25maWdVcmxWYWx1ZTsgfQogICAgICBhcmd1bWVudCA9IGFyZ3VtZW50LnNsaWNlKDAsIGNvbmZpZ1VybElkeCkgKyAoZW5kID49IDAgPyB0YWlsLnNsaWNlKGVuZCArIDEpIDogIiIpOwogICAgfQogICAgdmFyIHBhaXJzID0gYXJndW1lbnQuc3BsaXQoL1smO10vKTsKICAgIGZvciAodmFyIGogPSAwOyBqIDwgcGFpcnMubGVuZ3RoOyBqICs9IDEpIHsKICAgICAgdmFyIHBhcnQgPSBwYWlyc1tqXTsKICAgICAgaWYgKCFwYXJ0KSB7IGNvbnRpbnVlOyB9CiAgICAgIHZhciBlcSA9IHBhcnQuaW5kZXhPZigiPSIpOwogICAgICB2YXIga2V5ID0gZXEgPj0gMCA/IHBhcnQuc2xpY2UoMCwgZXEpIDogcGFydDsKICAgICAgdmFyIHZhbHVlID0gZXEgPj0gMCA/IHBhcnQuc2xpY2UoZXEgKyAxKSA6ICJ0cnVlIjsKICAgICAgdHJ5IHsgcmVzdWx0W2RlY29kZVVSSUNvbXBvbmVudChrZXkpXSA9IGRlY29kZVVSSUNvbXBvbmVudCh2YWx1ZSk7IH0KICAgICAgY2F0Y2ggKGVycjIpIHsgcmVzdWx0W2tleV0gPSB2YWx1ZTsgfQogICAgfQogICAgcmV0dXJuIHJlc3VsdDsKICB9CgogIGZ1bmN0aW9uIHJlc29sdmVDb25maWdVcmwoYXJncykgewogICAgYXJncyA9IGFyZ3MgfHwge307CiAgICB2YXIgZGlyZWN0ID0gU3RyaW5nKGFyZ3MuY29uZmlnVXJsIHx8IGFyZ3MuY2ZnIHx8IGFyZ3MudXJsIHx8ICIiKS50cmltKCk7CiAgICBpZiAoZGlyZWN0KSB7IHJldHVybiBkaXJlY3Q7IH0KICAgIHZhciBob3N0ID0gU3RyaW5nKGFyZ3MuY29uZmlnSG9zdCB8fCAiIikudHJpbSgpLnJlcGxhY2UoL1wvKyQvLCAiIik7CiAgICB2YXIgdG9rZW4gPSBTdHJpbmcoYXJncy5jb25maWdUb2tlbiB8fCAiIikudHJpbSgpOwogICAgaWYgKGhvc3QgJiYgdG9rZW4pIHsgcmV0dXJuIGhvc3QgKyAiL2xvYy5qc29uP3Rva2VuPSIgKyBlbmNvZGVVUklDb21wb25lbnQodG9rZW4pOyB9CiAgICByZXR1cm4gIiI7CiAgfQoKICBmdW5jdGlvbiBpc1BsYWNlaG9sZGVyVmFsdWUodmFsdWUpIHsKICAgIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICJzdHJpbmciICYmIC9eXHtbXn1dK1x9JC8udGVzdCh2YWx1ZS50cmltKCkpOwogIH0KCiAgZnVuY3Rpb24gcmVhZFBsdWdpblN0b3JlQXJnKG5hbWUpIHsKICAgIGlmICh0eXBlb2YgJHBlcnNpc3RlbnRTdG9yZSA9PT0gInVuZGVmaW5lZCIgfHwgISRwZXJzaXN0ZW50U3RvcmUucmVhZCkgeyByZXR1cm4gbnVsbDsgfQogICAgdHJ5IHsKICAgICAgdmFyIHZhbHVlID0gJHBlcnNpc3RlbnRTdG9yZS5yZWFkKG5hbWUpOwogICAgICBpZiAodmFsdWUgPT0gbnVsbCB8fCB2YWx1ZSA9PT0gIiIpIHsgcmV0dXJuIG51bGw7IH0KICAgICAgcmV0dXJuIFN0cmluZyh2YWx1ZSk7CiAgICB9IGNhdGNoIChlcnIpIHsgcmV0dXJuIG51bGw7IH0KICB9CgogIGZ1bmN0aW9uIGVucmljaEFyZ3NGcm9tUGx1Z2luU3RvcmUoYXJncykgewogICAgdmFyIGtleXMgPSBbImVuYWJsZWQiLCJsYXRpdHVkZSIsImxvbmdpdHVkZSIsImFsdGl0dWRlIiwiaG9yaXpvbnRhbEFjY3VyYWN5IiwKICAgICAgInZlcnRpY2FsQWNjdXJhY3kiLCJyYW5kb21SYWRpdXMiLCJhZGRyZXNzIiwiY29uZmlnSG9zdCIsImNvbmZpZ1Rva2VuIiwiY29uZmlnVXJsIiwiZGVidWciXTsKICAgIHZhciBpOwogICAgYXJncyA9IGFyZ3MgfHwge307CiAgICBmb3IgKGkgPSAwOyBpIDwga2V5cy5sZW5ndGg7IGkgKz0gMSkgewogICAgICB2YXIga2V5ID0ga2V5c1tpXTsKICAgICAgdmFyIGN1cnJlbnQgPSBhcmdzW2tleV07CiAgICAgIGlmIChjdXJyZW50ID09IG51bGwgfHwgY3VycmVudCA9PT0gIiIgfHwgaXNQbGFjZWhvbGRlclZhbHVlKGN1cnJlbnQpKSB7CiAgICAgICAgdmFyIHN0b3JlZCA9IHJlYWRQbHVnaW5TdG9yZUFyZyhrZXkpOwogICAgICAgIGlmIChzdG9yZWQgIT0gbnVsbCAmJiAhaXNQbGFjZWhvbGRlclZhbHVlKHN0b3JlZCkpIHsgYXJnc1trZXldID0gc3RvcmVkOyB9CiAgICAgIH0KICAgIH0KICAgIHJldHVybiBhcmdzOwogIH0KCiAgZnVuY3Rpb24gcmVhZFNjcmlwdEFyZ3VtZW50cygpIHsKICAgIHZhciBvdXQgPSB7fTsKICAgIGlmICh0eXBlb2YgJGFyZ3VtZW50ICE9PSAidW5kZWZpbmVkIiAmJiAkYXJndW1lbnQgIT0gbnVsbCkgewogICAgICBpZiAodHlwZW9mICRhcmd1bWVudCA9PT0gInN0cmluZyIpIHsgb3V0ID0gcGFyc2VBcmd1bWVudFN0cmluZygkYXJndW1lbnQpOyB9CiAgICAgIGVsc2UgaWYgKHR5cGVvZiAkYXJndW1lbnQgPT09ICJvYmplY3QiKSB7CiAgICAgICAgdmFyIGtleTsKICAgICAgICBmb3IgKGtleSBpbiAkYXJndW1lbnQpIHsKICAgICAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoJGFyZ3VtZW50LCBrZXkpKSB7CiAgICAgICAgICAgIHZhciB2YWx1ZSA9ICRhcmd1bWVudFtrZXldOwogICAgICAgICAgICBvdXRba2V5XSA9IHZhbHVlID09IG51bGwgPyAiIiA6IFN0cmluZyh2YWx1ZSk7CiAgICAgICAgICB9CiAgICAgICAgfQogICAgICB9IGVsc2UgeyBvdXQgPSBwYXJzZUFyZ3VtZW50U3RyaW5nKFN0cmluZygkYXJndW1lbnQpKTsgfQogICAgfQogICAgcmV0dXJuIGVucmljaEFyZ3NGcm9tUGx1Z2luU3RvcmUob3V0KTsKICB9CgogIGZ1bmN0aW9uIGxvZ1NjcmlwdEFyZ3VtZW50cyhkZWJ1ZykgewogICAgaWYgKCFkZWJ1ZykgeyByZXR1cm47IH0KICAgIHZhciBhcmdzID0gcmVhZFNjcmlwdEFyZ3VtZW50cygpOwogICAgdmFyIHJhdyA9IHR5cGVvZiAkYXJndW1lbnQgPT09ICJ1bmRlZmluZWQiIHx8ICRhcmd1bWVudCA9PSBudWxsID8gIjxub25lPiIKICAgICAgOiB0eXBlb2YgJGFyZ3VtZW50ID09PSAib2JqZWN0IiA/IEpTT04uc3RyaW5naWZ5KCRhcmd1bWVudCkgOiBTdHJpbmcoJGFyZ3VtZW50KTsKICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyICRhcmd1bWVudCByYXc6ICIgKyByYXcpOwogICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgYXJncyBwYXJzZWQ6IGxhdD0iICsgYXJncy5sYXRpdHVkZSArICIsIGxuZz0iICsgYXJncy5sb25naXR1ZGUgKyAiLCBjb25maWdVcmw9IiArIChyZXNvbHZlQ29uZmlnVXJsKGFyZ3MpIHx8ICI8bm9uZT4iKSk7CiAgfQoKICBmdW5jdGlvbiBkZXRlY3RSdW50aW1lKCkgewogICAgaWYgKHR5cGVvZiAkZW52aXJvbm1lbnQgIT09ICJ1bmRlZmluZWQiICYmICRlbnZpcm9ubWVudCAmJiAkZW52aXJvbm1lbnQucHJvZHVjdCkgeyByZXR1cm4gU3RyaW5nKCRlbnZpcm9ubWVudC5wcm9kdWN0KTsgfQogICAgaWYgKHR5cGVvZiAkbG9vbiAhPT0gInVuZGVmaW5lZCIpIHsgcmV0dXJuICJMb29uIjsgfQogICAgcmV0dXJuICJVbmtub3duIjsKICB9CgogIGZ1bmN0aW9uIGlzTG9vblJ1bnRpbWUoKSB7IHJldHVybiBkZXRlY3RSdW50aW1lKCkgPT09ICJMb29uIjsgfQoKICBmdW5jdGlvbiBpc0d6aXBCeXRlcyhieXRlcykgewogICAgcmV0dXJuIGJ5dGVzICYmIGJ5dGVzLmxlbmd0aCA+PSAyICYmIGJ5dGVzWzBdID09PSAweDFmICYmIGJ5dGVzWzFdID09PSAweDhiOwogIH0KCiAgZnVuY3Rpb24gcmVhZEdlb2NvZGVDYWNoZSgpIHsKICAgIGlmICh0eXBlb2YgJHBlcnNpc3RlbnRTdG9yZSA9PT0gInVuZGVmaW5lZCIgfHwgISRwZXJzaXN0ZW50U3RvcmUucmVhZCkgeyByZXR1cm4gbnVsbDsgfQogICAgdHJ5IHsKICAgICAgdmFyIHJhdyA9ICRwZXJzaXN0ZW50U3RvcmUucmVhZCgibG9jYXRpb25fc3Bvb2Zlcl9nZW9jb2RlIik7CiAgICAgIHJldHVybiByYXcgPyBKU09OLnBhcnNlKHJhdykgOiBudWxsOwogICAgfSBjYXRjaCAoZXJyKSB7IHJldHVybiBudWxsOyB9CiAgfQoKICBmdW5jdGlvbiB3cml0ZUdlb2NvZGVDYWNoZShlbnRyeSkgewogICAgaWYgKHR5cGVvZiAkcGVyc2lzdGVudFN0b3JlID09PSAidW5kZWZpbmVkIiB8fCAhJHBlcnNpc3RlbnRTdG9yZS53cml0ZSkgeyByZXR1cm47IH0KICAgIHRyeSB7ICRwZXJzaXN0ZW50U3RvcmUud3JpdGUoImxvY2F0aW9uX3Nwb29mZXJfZ2VvY29kZSIsIEpTT04uc3RyaW5naWZ5KGVudHJ5KSk7IH0KICAgIGNhdGNoIChlcnIpIHt9CiAgfQoKICBmdW5jdGlvbiBmZXRjaEVsZXZhdGlvbihsYXQsIGxuZywgY2FsbGJhY2spIHsKICAgIGlmICh0eXBlb2YgJGh0dHBDbGllbnQgPT09ICJ1bmRlZmluZWQiIHx8ICEkaHR0cENsaWVudC5nZXQpIHsgY2FsbGJhY2sobnVsbCk7IHJldHVybjsgfQogICAgdmFyIHVybCA9ICJodHRwczovL2FwaS5vcGVuLW1ldGVvLmNvbS92MS9lbGV2YXRpb24/bGF0aXR1ZGU9IiArIGVuY29kZVVSSUNvbXBvbmVudChTdHJpbmcobGF0KSkgKyAiJmxvbmdpdHVkZT0iICsgZW5jb2RlVVJJQ29tcG9uZW50KFN0cmluZyhsbmcpKTsKICAgICRodHRwQ2xpZW50LmdldCh7IHVybDogdXJsLCB0aW1lb3V0OiA0MDAwIH0sIGZ1bmN0aW9uIChlcnJvciwgcmVzcG9uc2UsIGJvZHkpIHsKICAgICAgaWYgKGVycm9yIHx8ICFib2R5KSB7IGNhbGxiYWNrKG51bGwpOyByZXR1cm47IH0KICAgICAgdHJ5IHsKICAgICAgICB2YXIgZGF0YSA9IEpTT04ucGFyc2UoYm9keSk7CiAgICAgICAgaWYgKGRhdGEgJiYgZGF0YS5lbGV2YXRpb24gJiYgZGF0YS5lbGV2YXRpb24ubGVuZ3RoKSB7IGNhbGxiYWNrKE1hdGgucm91bmQoTnVtYmVyKGRhdGEuZWxldmF0aW9uWzBdKSkpOyByZXR1cm47IH0KICAgICAgfSBjYXRjaCAoZXJyKSB7fQogICAgICBjYWxsYmFjayhudWxsKTsKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gZ2VvY29kZUFkZHJlc3MoYWRkcmVzcywgZGVidWcsIGNhbGxiYWNrKSB7CiAgICB2YXIgcXVlcnkgPSBTdHJpbmcoYWRkcmVzcyB8fCAiIikudHJpbSgpOwogICAgaWYgKCFxdWVyeSkgeyBjYWxsYmFjayhudWxsKTsgcmV0dXJuOyB9CiAgICB2YXIgY2FjaGVkID0gcmVhZEdlb2NvZGVDYWNoZSgpOwogICAgaWYgKGNhY2hlZCAmJiBjYWNoZWQuYWRkcmVzcyA9PT0gcXVlcnkgJiYgTnVtYmVyLmlzRmluaXRlKE51bWJlcihjYWNoZWQubGF0aXR1ZGUpKSAmJiBOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKGNhY2hlZC5sb25naXR1ZGUpKSkgewogICAgICBpZiAoZGVidWcpIHsgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgZ2VvY29kZSBjYWNoZSBoaXQ6ICIgKyBxdWVyeSArICIgLT4gIiArIGNhY2hlZC5sYXRpdHVkZSArICIsIiArIGNhY2hlZC5sb25naXR1ZGUpOyB9CiAgICAgIGNhbGxiYWNrKGNhY2hlZCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGlmICh0eXBlb2YgJGh0dHBDbGllbnQgPT09ICJ1bmRlZmluZWQiIHx8ICEkaHR0cENsaWVudC5nZXQpIHsKICAgICAgaWYgKGRlYnVnKSB7IGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIGdlb2NvZGUgc2tpcHBlZDogJGh0dHBDbGllbnQgdW5hdmFpbGFibGUiKTsgfQogICAgICBjYWxsYmFjayhudWxsKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgdmFyIHVybCA9ICJodHRwczovL25vbWluYXRpbS5vcGVuc3RyZWV0bWFwLm9yZy9zZWFyY2g/Zm9ybWF0PWpzb24mbGltaXQ9MSZhZGRyZXNzZGV0YWlscz0wJnE9IiArIGVuY29kZVVSSUNvbXBvbmVudChxdWVyeSk7CiAgICAkaHR0cENsaWVudC5nZXQoeyB1cmw6IHVybCwgdGltZW91dDogODAwMCwgaGVhZGVyczogeyAiVXNlci1BZ2VudCI6ICJpb3MtbG9jYXRpb24tc3Bvb2Zlci8xLjAgKExvb24gcGx1Z2luKSIgfSB9LCBmdW5jdGlvbiAoZXJyb3IsIHJlc3BvbnNlLCBib2R5KSB7CiAgICAgIGlmIChlcnJvciB8fCAhYm9keSkgewogICAgICAgIGlmIChkZWJ1ZykgeyBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBnZW9jb2RlIGZhaWxlZDogIiArIChlcnJvciB8fCAiZW1wdHkgYm9keSIpKTsgfQogICAgICAgIGNhbGxiYWNrKG51bGwpOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICB0cnkgewogICAgICAgIHZhciByZXN1bHRzID0gSlNPTi5wYXJzZShib2R5KTsKICAgICAgICBpZiAoIXJlc3VsdHMgfHwgIXJlc3VsdHMubGVuZ3RoKSB7CiAgICAgICAgICBpZiAoZGVidWcpIHsgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgZ2VvY29kZSBubyByZXN1bHQgZm9yOiAiICsgcXVlcnkpOyB9CiAgICAgICAgICBjYWxsYmFjayhudWxsKTsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgICAgdmFyIGhpdCA9IHJlc3VsdHNbMF07CiAgICAgICAgdmFyIGxhdCA9IE51bWJlcihoaXQubGF0KTsKICAgICAgICB2YXIgbG5nID0gTnVtYmVyKGhpdC5sb24pOwogICAgICAgIGlmICghTnVtYmVyLmlzRmluaXRlKGxhdCkgfHwgIU51bWJlci5pc0Zpbml0ZShsbmcpKSB7IGNhbGxiYWNrKG51bGwpOyByZXR1cm47IH0KICAgICAgICB2YXIgZW50cnkgPSB7IGFkZHJlc3M6IHF1ZXJ5LCBsYXRpdHVkZTogbGF0LCBsb25naXR1ZGU6IGxuZywgZGlzcGxheU5hbWU6IGhpdC5kaXNwbGF5X25hbWUgfHwgcXVlcnkgfTsKICAgICAgICBmZXRjaEVsZXZhdGlvbihsYXQsIGxuZywgZnVuY3Rpb24gKGFsdGl0dWRlKSB7CiAgICAgICAgICBpZiAoYWx0aXR1ZGUgIT0gbnVsbCkgeyBlbnRyeS5hbHRpdHVkZSA9IGFsdGl0dWRlOyB9CiAgICAgICAgICB3cml0ZUdlb2NvZGVDYWNoZShlbnRyeSk7CiAgICAgICAgICBpZiAoZGVidWcpIHsgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgZ2VvY29kZSByZXNvbHZlZDogIiArIHF1ZXJ5ICsgIiAtPiAiICsgbGF0ICsgIiwiICsgbG5nICsgKGFsdGl0dWRlICE9IG51bGwgPyAiLCBhbHQ9IiArIGFsdGl0dWRlIDogIiIpKTsgfQogICAgICAgICAgY2FsbGJhY2soZW50cnkpOwogICAgICAgIH0pOwogICAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgICBpZiAoZGVidWcpIHsgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgZ2VvY29kZSBwYXJzZSBmYWlsZWQ6ICIgKyBlcnIubWVzc2FnZSk7IH0KICAgICAgICBjYWxsYmFjayhudWxsKTsKICAgICAgfQogICAgfSk7CiAgfQoKICBmdW5jdGlvbiBtZXJnZUNvbmZpZyhiYXNlLCBleHRyYSkgewogICAgdmFyIG91dCA9IHt9OwogICAgdmFyIGtleTsKICAgIGZvciAoa2V5IGluIGJhc2UpIHsKICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChiYXNlLCBrZXkpKSB7IG91dFtrZXldID0gYmFzZVtrZXldOyB9CiAgICB9CiAgICBleHRyYSA9IGV4dHJhIHx8IHt9OwogICAgZm9yIChrZXkgaW4gZXh0cmEpIHsKICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChleHRyYSwga2V5KSkgeyBvdXRba2V5XSA9IGV4dHJhW2tleV07IH0KICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICBmdW5jdGlvbiBkZWNvZGVCYXNlNjQodmFsdWUpIHsKICAgIGlmICh0eXBlb2YgYXRvYiA9PT0gImZ1bmN0aW9uIikgeyByZXR1cm4gYXRvYih2YWx1ZSk7IH0KICAgIGlmICh0eXBlb2YgQnVmZmVyICE9PSAidW5kZWZpbmVkIikgeyByZXR1cm4gQnVmZmVyLmZyb20odmFsdWUsICJiYXNlNjQiKS50b1N0cmluZygidXRmOCIpOyB9CiAgICB0aHJvdyBuZXcgRXJyb3IoImJhc2U2NCBkZWNvZGVyIHVuYXZhaWxhYmxlIik7CiAgfQoKICBmdW5jdGlvbiBjb25maWdGcm9tQXJncyhhcmdzKSB7CiAgICB2YXIgY2ZnID0ge307CiAgICB2YXIgc2NhbGFyS2V5cyA9IFsiZW5hYmxlZCIsIm1vZGUiLCJsYXRpdHVkZSIsImxvbmdpdHVkZSIsImFkZHJlc3MiLCJob3Jpem9udGFsQWNjdXJhY3kiLAogICAgICAidmVydGljYWxBY2N1cmFjeSIsInJhbmRvbVJhZGl1cyIsImFsdGl0dWRlIiwidW5rbm93blZhbHVlNCIsIm1vdGlvbkFjdGl2aXR5VHlwZSIsCiAgICAgICJtb3Rpb25BY3Rpdml0eUNvbmZpZGVuY2UiLCJmYWlsT3BlbiIsImRlYnVnIiwiZHVtcFJhdyIsImR1bXBIZWFkZXJzIiwicHJlcGFyZUhlYWRlcnMiLCJyYXdMaW1pdCJdOwogICAgaWYgKGFyZ3MuY29uZmlnKSB7IGNmZyA9IG1lcmdlQ29uZmlnKGNmZywgSlNPTi5wYXJzZShhcmdzLmNvbmZpZykpOyB9CiAgICBpZiAoYXJncy5jb25maWdCYXNlNjQpIHsgY2ZnID0gbWVyZ2VDb25maWcoY2ZnLCBKU09OLnBhcnNlKGRlY29kZUJhc2U2NChhcmdzLmNvbmZpZ0Jhc2U2NCkpKTsgfQogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBzY2FsYXJLZXlzLmxlbmd0aDsgaSArPSAxKSB7CiAgICAgIHZhciBrZXkgPSBzY2FsYXJLZXlzW2ldOwogICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGFyZ3MsIGtleSkpIHsgY2ZnW2tleV0gPSBhcmdzW2tleV07IH0KICAgIH0KICAgIHJldHVybiBjZmc7CiAgfQoKICBmdW5jdGlvbiByZWFkUmVtb3RlQ29uZmlnQ2FjaGUodXJsKSB7CiAgICBpZiAoIXVybCB8fCB0eXBlb2YgJHBlcnNpc3RlbnRTdG9yZSA9PT0gInVuZGVmaW5lZCIgfHwgISRwZXJzaXN0ZW50U3RvcmUucmVhZCkgeyByZXR1cm4gbnVsbDsgfQogICAgdHJ5IHsKICAgICAgdmFyIHJhdyA9ICRwZXJzaXN0ZW50U3RvcmUucmVhZCgibG9jYXRpb25fc3Bvb2Zlcl9yZW1vdGVfY2ZnIik7CiAgICAgIGlmICghcmF3KSB7IHJldHVybiBudWxsOyB9CiAgICAgIHZhciBlbnRyeSA9IEpTT04ucGFyc2UocmF3KTsKICAgICAgaWYgKCFlbnRyeSB8fCBlbnRyeS51cmwgIT09IHVybCB8fCAhZW50cnkuZGF0YSkgeyByZXR1cm4gbnVsbDsgfQogICAgICBpZiAoRGF0ZS5ub3coKSAtIGVudHJ5LnRzID4gMzAwMDAwKSB7IHJldHVybiBudWxsOyB9CiAgICAgIHJldHVybiBlbnRyeS5kYXRhOwogICAgfSBjYXRjaCAoZXJyKSB7IHJldHVybiBudWxsOyB9CiAgfQoKICBmdW5jdGlvbiB3cml0ZVJlbW90ZUNvbmZpZ0NhY2hlKHVybCwgZGF0YSkgewogICAgaWYgKCF1cmwgfHwgdHlwZW9mICRwZXJzaXN0ZW50U3RvcmUgPT09ICJ1bmRlZmluZWQiIHx8ICEkcGVyc2lzdGVudFN0b3JlLndyaXRlKSB7IHJldHVybjsgfQogICAgdHJ5IHsgJHBlcnNpc3RlbnRTdG9yZS53cml0ZSgibG9jYXRpb25fc3Bvb2Zlcl9yZW1vdGVfY2ZnIiwgSlNPTi5zdHJpbmdpZnkoeyB1cmw6IHVybCwgZGF0YTogZGF0YSwgdHM6IERhdGUubm93KCkgfSkpOyB9CiAgICBjYXRjaCAoZXJyKSB7fQogIH0KCiAgZnVuY3Rpb24gZmV0Y2hSZW1vdGVDb25maWcodXJsLCB0aW1lb3V0LCBkZWJ1ZywgY2FsbGJhY2spIHsKICAgIGlmICghdXJsIHx8IHR5cGVvZiAkaHR0cENsaWVudCA9PT0gInVuZGVmaW5lZCIgfHwgISRodHRwQ2xpZW50LmdldCkgewogICAgICBjYWxsYmFjayhudWxsLCAiaHR0cCBjbGllbnQgdW5hdmFpbGFibGUiKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgJGh0dHBDbGllbnQuZ2V0KHsgdXJsOiB1cmwsIHRpbWVvdXQ6IHRpbWVvdXQgfHwgMzAwMCB9LCBmdW5jdGlvbiAoZXJyb3IsIHJlc3BvbnNlLCBib2R5KSB7CiAgICAgIGlmIChlcnJvciB8fCAhYm9keSkgeyBjYWxsYmFjayhudWxsLCBlcnJvciB8fCAiZW1wdHkgYm9keSIpOyByZXR1cm47IH0KICAgICAgdHJ5IHsgY2FsbGJhY2soSlNPTi5wYXJzZShib2R5KSwgbnVsbCk7IH0KICAgICAgY2F0Y2ggKGVycikgeyBjYWxsYmFjayhudWxsLCBlcnIubWVzc2FnZSk7IH0KICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gcmVmcmVzaFJlbW90ZUNvbmZpZ0NhY2hlKHVybCwgZGVidWcpIHsKICAgIGZldGNoUmVtb3RlQ29uZmlnKHVybCwgNTAwMCwgZGVidWcsIGZ1bmN0aW9uIChkYXRhLCBlcnIpIHsKICAgICAgaWYgKGRhdGEpIHsgd3JpdGVSZW1vdGVDb25maWdDYWNoZSh1cmwsIGRhdGEpOyByZXR1cm47IH0KICAgICAgaWYgKGRlYnVnKSB7IGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIHJlbW90ZSBjb25maWcgcmVmcmVzaCBmYWlsZWQ6ICIgKyBlcnIpOyB9CiAgICB9KTsKICB9CgogIGZ1bmN0aW9uIGFwcGx5QWRkcmVzc0Zyb21DYWNoZShjZmcsIGFkZHJlc3MsIGRlYnVnKSB7CiAgICBpZiAoIWFkZHJlc3MpIHsgcmV0dXJuOyB9CiAgICB2YXIgY2FjaGVkID0gcmVhZEdlb2NvZGVDYWNoZSgpOwogICAgaWYgKGNhY2hlZCAmJiBjYWNoZWQuYWRkcmVzcyA9PT0gYWRkcmVzcyAmJiBOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKGNhY2hlZC5sYXRpdHVkZSkpICYmIE51bWJlci5pc0Zpbml0ZShOdW1iZXIoY2FjaGVkLmxvbmdpdHVkZSkpKSB7CiAgICAgIGNmZy5sYXRpdHVkZSA9IGNhY2hlZC5sYXRpdHVkZTsKICAgICAgY2ZnLmxvbmdpdHVkZSA9IGNhY2hlZC5sb25naXR1ZGU7CiAgICAgIGlmIChjYWNoZWQuYWx0aXR1ZGUgIT0gbnVsbCkgeyBjZmcuYWx0aXR1ZGUgPSBjYWNoZWQuYWx0aXR1ZGU7IH0KICAgICAgaWYgKGRlYnVnKSB7IGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIGdlb2NvZGUgY2FjaGUgaGl0OiAiICsgYWRkcmVzcyk7IH0KICAgICAgcmV0dXJuOwogICAgfQogICAgaWYgKGRlYnVnKSB7IGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIGdlb2NvZGUgY2FjaGUgbWlzczogIiArIGFkZHJlc3MgKyAiICh1c2UgbWFudWFsIGxhdC9sbmcgdW50aWwgY3JvbiByZWZyZXNoZXMpIik7IH0KICB9CgogIGZ1bmN0aW9uIGxvYWRSdW50aW1lQ29uZmlnU3luYygpIHsKICAgIHZhciBhcmdzID0gcmVhZFNjcmlwdEFyZ3VtZW50cygpOwogICAgdmFyIGNmZyA9IG1lcmdlQ29uZmlnKERFRkFVTFRfQ09ORklHLCBjb25maWdGcm9tQXJncyhhcmdzKSk7CiAgICB2YXIgY29uZmlnVXJsID0gcmVzb2x2ZUNvbmZpZ1VybChhcmdzKTsKICAgIHZhciBkZWJ1ZyA9IHBhcnNlQm9vbGVhbihjZmcuZGVidWcsIGZhbHNlKTsKICAgIHZhciBhZGRyZXNzID0gU3RyaW5nKGFyZ3MuYWRkcmVzcyB8fCAiIikudHJpbSgpOwogICAgYXBwbHlBZGRyZXNzRnJvbUNhY2hlKGNmZywgYWRkcmVzcywgZGVidWcpOwogICAgaWYgKGNvbmZpZ1VybCkgewogICAgICB2YXIgcmVtb3RlQ2ZnID0gcmVhZFJlbW90ZUNvbmZpZ0NhY2hlKGNvbmZpZ1VybCk7CiAgICAgIGlmIChyZW1vdGVDZmcpIHsKICAgICAgICBjZmcgPSBtZXJnZUNvbmZpZyhjZmcsIHJlbW90ZUNmZyk7CiAgICAgICAgaWYgKGRlYnVnKSB7IGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIHJlbW90ZSBjb25maWcgY2FjaGUgaGl0IC0+ICIgKyByZW1vdGVDZmcubGF0aXR1ZGUgKyAiLCIgKyByZW1vdGVDZmcubG9uZ2l0dWRlKTsgfQogICAgICB9CiAgICB9CiAgICByZXR1cm4geyBjZmc6IGNmZywgY29uZmlnVXJsOiBjb25maWdVcmwsIGRlYnVnOiBkZWJ1ZyB9OwogIH0KCiAgZnVuY3Rpb24gbG9hZFJ1bnRpbWVDb25maWcoY2FsbGJhY2spIHsKICAgIHZhciBsb2FkZWQgPSBsb2FkUnVudGltZUNvbmZpZ1N5bmMoKTsKICAgIHZhciBjZmcgPSBsb2FkZWQuY2ZnOwogICAgdmFyIGNvbmZpZ1VybCA9IGxvYWRlZC5jb25maWdVcmw7CiAgICB2YXIgZGVidWcgPSBsb2FkZWQuZGVidWc7CiAgICBmdW5jdGlvbiBmaW5pc2goKSB7CiAgICAgIHRyeSB7IGNhbGxiYWNrKG5vcm1hbGl6ZUNvbmZpZyhjZmcpKTsgfQogICAgICBjYXRjaCAoZXJyKSB7CiAgICAgICAgaWYgKGRlYnVnKSB7IGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIGNvbmZpZyBpbnZhbGlkOiAiICsgZXJyLm1lc3NhZ2UgKyAiIHwgY2ZnIGxhdC9sbmc9IiArIGNmZy5sYXRpdHVkZSArICIsIiArIGNmZy5sb25naXR1ZGUpOyB9CiAgICAgICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKGNmZy5sYXRpdHVkZSkpIHx8ICFOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKGNmZy5sb25naXR1ZGUpKSkgewogICAgICAgICAgY2ZnLmxhdGl0dWRlID0gREVGQVVMVF9DT05GSUcubGF0aXR1ZGU7CiAgICAgICAgICBjZmcubG9uZ2l0dWRlID0gREVGQVVMVF9DT05GSUcubG9uZ2l0dWRlOwogICAgICAgIH0KICAgICAgICBjYWxsYmFjayhub3JtYWxpemVDb25maWcoY2ZnKSk7CiAgICAgIH0KICAgIH0KICAgIGxvZ1NjcmlwdEFyZ3VtZW50cyhkZWJ1Zyk7CiAgICBpZiAoIWNvbmZpZ1VybCkgeyBmaW5pc2goKTsgcmV0dXJuOyB9CiAgICBpZiAocmVhZFJlbW90ZUNvbmZpZ0NhY2hlKGNvbmZpZ1VybCkpIHsgcmVmcmVzaFJlbW90ZUNvbmZpZ0NhY2hlKGNvbmZpZ1VybCwgZGVidWcpOyBmaW5pc2goKTsgcmV0dXJuOyB9CiAgICBpZiAoZGVidWcpIHsgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcmVtb3RlIGNvbmZpZyBmZXRjaGluZzogIiArIGNvbmZpZ1VybCk7IH0KICAgIGZldGNoUmVtb3RlQ29uZmlnKGNvbmZpZ1VybCwgMzAwMCwgZGVidWcsIGZ1bmN0aW9uIChkYXRhLCBlcnIpIHsKICAgICAgaWYgKGRhdGEpIHsKICAgICAgICB3cml0ZVJlbW90ZUNvbmZpZ0NhY2hlKGNvbmZpZ1VybCwgZGF0YSk7CiAgICAgICAgY2ZnID0gbWVyZ2VDb25maWcoY2ZnLCBkYXRhKTsKICAgICAgICBpZiAoZGVidWcpIHsgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcmVtb3RlIGNvbmZpZyBsb2FkZWQgLT4gIiArIGRhdGEubGF0aXR1ZGUgKyAiLCIgKyBkYXRhLmxvbmdpdHVkZSk7IH0KICAgICAgfSBlbHNlIGlmIChkZWJ1ZykgeyBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciByZW1vdGUgY29uZmlnIGZldGNoIGZhaWxlZDogIiArIGVyciArICIgKHVzaW5nIG1hbnVhbCBsYXQvbG5nKSIpOyB9CiAgICAgIGZpbmlzaCgpOwogICAgfSk7CiAgfQoKICBmdW5jdGlvbiBydW5NYWludGVuYW5jZUNyb24oKSB7CiAgICB2YXIgYXJncyA9IHJlYWRTY3JpcHRBcmd1bWVudHMoKTsKICAgIHZhciBkZWJ1ZyA9IHBhcnNlQm9vbGVhbihhcmdzLmRlYnVnLCBmYWxzZSk7CiAgICB2YXIgcGVuZGluZyA9IDA7CiAgICBmdW5jdGlvbiBtYXliZURvbmUoKSB7IHBlbmRpbmcgLT0gMTsgaWYgKHBlbmRpbmcgPD0gMCkgeyAkZG9uZSh7fSk7IH0gfQogICAgdmFyIGNvbmZpZ1VybCA9IHJlc29sdmVDb25maWdVcmwoYXJncyk7CiAgICBpZiAoY29uZmlnVXJsKSB7CiAgICAgIHBlbmRpbmcgKz0gMTsKICAgICAgZmV0Y2hSZW1vdGVDb25maWcoY29uZmlnVXJsLCA4MDAwLCBkZWJ1ZywgZnVuY3Rpb24gKGRhdGEsIGVycikgewogICAgICAgIGlmIChkYXRhKSB7CiAgICAgICAgICB3cml0ZVJlbW90ZUNvbmZpZ0NhY2hlKGNvbmZpZ1VybCwgZGF0YSk7CiAgICAgICAgICBpZiAoZGVidWcpIHsgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgY29uZmlnIGNyb24gY2FjaGVkIC0+ICIgKyBkYXRhLmxhdGl0dWRlICsgIiwiICsgZGF0YS5sb25naXR1ZGUpOyB9CiAgICAgICAgfSBlbHNlIGlmIChkZWJ1ZykgeyBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBjb25maWcgY3JvbiBmYWlsZWQ6ICIgKyBlcnIpOyB9CiAgICAgICAgbWF5YmVEb25lKCk7CiAgICAgIH0pOwogICAgfQogICAgdmFyIGFkZHJlc3MgPSBTdHJpbmcoYXJncy5hZGRyZXNzIHx8ICIiKS50cmltKCk7CiAgICBpZiAoYWRkcmVzcykgewogICAgICBwZW5kaW5nICs9IDE7CiAgICAgIGdlb2NvZGVBZGRyZXNzKGFkZHJlc3MsIGRlYnVnLCBmdW5jdGlvbiAoKSB7IG1heWJlRG9uZSgpOyB9KTsKICAgIH0KICAgIGlmIChwZW5kaW5nID09PSAwKSB7ICRkb25lKHt9KTsgfQogIH0KCiAgZnVuY3Rpb24gcnVuR2VvY29kZUNyb24oKSB7IHJ1bk1haW50ZW5hbmNlQ3JvbigpOyB9CgogIGZ1bmN0aW9uIGhlYWRlcnNXaXRoQmluYXJ5Qm9keShzb3VyY2VIZWFkZXJzLCBsZW5ndGgpIHsKICAgIHZhciBoZWFkZXJzID0ge307CiAgICB2YXIga2V5OwogICAgc291cmNlSGVhZGVycyA9IHNvdXJjZUhlYWRlcnMgfHwge307CiAgICBmb3IgKGtleSBpbiBzb3VyY2VIZWFkZXJzKSB7CiAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoc291cmNlSGVhZGVycywga2V5KSkgewogICAgICAgIHZhciBsb3dlciA9IGtleS50b0xvd2VyQ2FzZSgpOwogICAgICAgIGlmIChsb3dlciAhPT0gImNvbnRlbnQtbGVuZ3RoIiAmJiBsb3dlciAhPT0gImNvbnRlbnQtZW5jb2RpbmciICYmIGxvd2VyICE9PSAidHJhbnNmZXItZW5jb2RpbmciKSB7CiAgICAgICAgICBoZWFkZXJzW2tleV0gPSBzb3VyY2VIZWFkZXJzW2tleV07CiAgICAgICAgfQogICAgICB9CiAgICB9CiAgICBoZWFkZXJzWyJDb250ZW50LVR5cGUiXSA9ICJhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW0iOwogICAgaGVhZGVyc1siQ29udGVudC1MZW5ndGgiXSA9IFN0cmluZyhsZW5ndGgpOwogICAgcmV0dXJuIGhlYWRlcnM7CiAgfQoKICBmdW5jdGlvbiBzZXRIZWFkZXIoaGVhZGVycywgbmFtZSwgdmFsdWUpIHsKICAgIGhlYWRlcnMgPSBoZWFkZXJzIHx8IHt9OwogICAgdmFyIGxvd2VyID0gbmFtZS50b0xvd2VyQ2FzZSgpOwogICAgdmFyIGV4aXN0aW5nS2V5ID0gbnVsbDsKICAgIGZvciAodmFyIGtleSBpbiBoZWFkZXJzKSB7CiAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoaGVhZGVycywga2V5KSAmJiBrZXkudG9Mb3dlckNhc2UoKSA9PT0gbG93ZXIpIHsgZXhpc3RpbmdLZXkgPSBrZXk7IGJyZWFrOyB9CiAgICB9CiAgICBoZWFkZXJzW2V4aXN0aW5nS2V5IHx8IG5hbWVdID0gdmFsdWU7CiAgICByZXR1cm4gaGVhZGVyczsKICB9CgogIGZ1bmN0aW9uIHByZXBhcmVSZXF1ZXN0SGVhZGVycyhoZWFkZXJzKSB7IHJldHVybiBzZXRIZWFkZXIoaGVhZGVycyB8fCB7fSwgIkFjY2VwdC1FbmNvZGluZyIsICJpZGVudGl0eSIpOyB9CgogIGZ1bmN0aW9uIGRvbmVQcmVwYXJlZFJlcXVlc3RQYXNzVGhyb3VnaCgpIHsKICAgIHZhciBoZWFkZXJzID0gcHJlcGFyZVJlcXVlc3RIZWFkZXJzKCh0eXBlb2YgJHJlcXVlc3QgIT09ICJ1bmRlZmluZWQiICYmICRyZXF1ZXN0LmhlYWRlcnMpIHx8IHt9KTsKICAgICRkb25lKHsgaGVhZGVyczogaGVhZGVycyB9KTsKICB9CgogIGZ1bmN0aW9uIGRlY29tcHJlc3NCb2R5KGJvZHksIGNvbnRlbnRFbmNvZGluZykgewogICAgaWYgKGJvZHkgPT0gbnVsbCkgeyByZXR1cm4gYm9keTsgfQogICAgdmFyIGVuYyA9IGNvbnRlbnRFbmNvZGluZyA/IFN0cmluZyhjb250ZW50RW5jb2RpbmcpLnRvTG93ZXJDYXNlKCkgOiAiIjsKICAgIGlmIChlbmMgPT09ICJpZGVudGl0eSIgfHwgZW5jID09PSAiIikgeyByZXR1cm4gYm9keTsgfQogICAgdHJ5IHsKICAgICAgaWYgKGVuYy5pbmRleE9mKCJnemlwIikgPj0gMCAmJiB0eXBlb2YgJHV0aWxzICE9PSAidW5kZWZpbmVkIiAmJiAkdXRpbHMudW5nemlwKSB7IHJldHVybiAkdXRpbHMudW5nemlwKGJvZHkpOyB9CiAgICAgIGlmIChlbmMuaW5kZXhPZigiZGVmbGF0ZSIpID49IDAgJiYgdHlwZW9mICR1dGlscyAhPT0gInVuZGVmaW5lZCIgJiYgJHV0aWxzLmluZmxhdGUpIHsgcmV0dXJuICR1dGlscy5pbmZsYXRlKGJvZHkpOyB9CiAgICAgIGlmIChlbmMuaW5kZXhPZigiYnIiKSA+PSAwICYmIHR5cGVvZiAkdXRpbHMgIT09ICJ1bmRlZmluZWQiICYmICR1dGlscy5icm90bGlEZWNvbXByZXNzKSB7IHJldHVybiAkdXRpbHMuYnJvdGxpRGVjb21wcmVzcyhib2R5KTsgfQogICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgIGlmICh0eXBlb2YgY29uc29sZSAhPT0gInVuZGVmaW5lZCIpIHsgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgZGVjb21wcmVzcyBmYWlsZWQgKCIgKyBlbmMgKyAiKTogIiArIGVyci5tZXNzYWdlKTsgfQogICAgfQogICAgcmV0dXJuIGJvZHk7CiAgfQoKICBmdW5jdGlvbiBwcmVwYXJlUmVzcG9uc2VCb2R5U3luYyhjb25maWcpIHsKICAgIHZhciByZXNwSGVhZGVycyA9ICgkcmVzcG9uc2UgJiYgJHJlc3BvbnNlLmhlYWRlcnMpIHx8IHt9OwogICAgdmFyIGNvbnRlbnRFbmNvZGluZyA9IGhlYWRlclZhbHVlKHJlc3BIZWFkZXJzLCAiQ29udGVudC1FbmNvZGluZyIpOwogICAgdmFyIHJhd1Jlc3BCb2R5ID0gJHJlc3BvbnNlICYmICgkcmVzcG9uc2UuYm9keSAhPSBudWxsID8gJHJlc3BvbnNlLmJvZHkgOiAkcmVzcG9uc2UuYm9keUJ5dGVzKTsKICAgIGxvZ0h0dHBEdW1wKCJyZXNwb25zZS13aXJlLW9yaWdpbmFsIiwgJHJlc3BvbnNlLCBjb25maWcpOwogICAgbG9nUmF3RHVtcCgicmVzcG9uc2Utd2lyZS1vcmlnaW5hbCIsIGJvZHlUb0J5dGVzKHJhd1Jlc3BCb2R5KSwgY29uZmlnKTsKICAgIHZhciBieXRlcyA9IGJvZHlUb0J5dGVzKHJhd1Jlc3BCb2R5KTsKICAgIGlmICghYnl0ZXMgfHwgYnl0ZXMubGVuZ3RoIDwgMikgeyByZXR1cm47IH0KICAgIGlmIChpc0d6aXBCeXRlcyhieXRlcykgfHwgKGNvbnRlbnRFbmNvZGluZyAmJiBTdHJpbmcoY29udGVudEVuY29kaW5nKS50b0xvd2VyQ2FzZSgpLmluZGV4T2YoImd6aXAiKSA+PSAwKSkgewogICAgICB2YXIgZGVjb2RlZCA9IGJvZHlUb0J5dGVzKGRlY29tcHJlc3NCb2R5KHJhd1Jlc3BCb2R5LCBjb250ZW50RW5jb2RpbmcgfHwgImd6aXAiKSk7CiAgICAgIGlmIChkZWNvZGVkICYmIGRlY29kZWQubGVuZ3RoID4gMiAmJiAhaXNHemlwQnl0ZXMoZGVjb2RlZCkpIHsKICAgICAgICAkcmVzcG9uc2UuYm9keSA9IGRlY29kZWQ7CiAgICAgICAgaWYgKGNvbmZpZy5kZWJ1ZykgeyBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBkZWNvbXByZXNzZWQgYm9keTogIiArIGJ5dGVzLmxlbmd0aCArICIgLT4gIiArIGRlY29kZWQubGVuZ3RoICsgIiBieXRlcyIpOyB9CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIGlmIChjb25maWcuZGVidWcpIHsgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgZ3ppcCBib2R5IHN0aWxsIGNvbXByZXNzZWQgKGxlbj0iICsgYnl0ZXMubGVuZ3RoICsgIik7IGVuc3VyZSBodHRwLXJlcXVlc3QgcHJlcGFyZSBzY3JpcHQgaXMgZW5hYmxlZCIpOyB9CiAgICAgIHJldHVybjsKICAgIH0KICAgIGlmIChjb250ZW50RW5jb2RpbmcpIHsKICAgICAgdmFyIHBsYWluID0gYm9keVRvQnl0ZXMoZGVjb21wcmVzc0JvZHkocmF3UmVzcEJvZHksIGNvbnRlbnRFbmNvZGluZykpOwogICAgICBpZiAocGxhaW4pIHsgJHJlc3BvbnNlLmJvZHkgPSBwbGFpbjsgfQogICAgfQogIH0KCiAgZnVuY3Rpb24gaGVhZGVyVmFsdWUoaGVhZGVycywgbmFtZSkgewogICAgaWYgKCFoZWFkZXJzKSB7IHJldHVybiB1bmRlZmluZWQ7IH0KICAgIHZhciBsb3dlciA9IG5hbWUudG9Mb3dlckNhc2UoKTsKICAgIGZvciAodmFyIGtleSBpbiBoZWFkZXJzKSB7CiAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoaGVhZGVycywga2V5KSAmJiBrZXkudG9Mb3dlckNhc2UoKSA9PT0gbG93ZXIpIHsgcmV0dXJuIGhlYWRlcnNba2V5XTsgfQogICAgfQogICAgcmV0dXJuIHVuZGVmaW5lZDsKICB9CgogIGZ1bmN0aW9uIGRvbmVQYXNzVGhyb3VnaCgpIHsgJGRvbmUoe30pOyB9CgogIGZ1bmN0aW9uIHZhbHVlVHlwZSh2YWx1ZSkgewogICAgaWYgKHZhbHVlID09IG51bGwpIHsgcmV0dXJuIFN0cmluZyh2YWx1ZSk7IH0KICAgIGlmICh2YWx1ZSBpbnN0YW5jZW9mIFVpbnQ4QXJyYXkpIHsgcmV0dXJuICJVaW50OEFycmF5IjsgfQogICAgaWYgKHR5cGVvZiBBcnJheUJ1ZmZlciAhPT0gInVuZGVmaW5lZCIgJiYgdmFsdWUgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikgeyByZXR1cm4gIkFycmF5QnVmZmVyIjsgfQogICAgcmV0dXJuIHR5cGVvZiB2YWx1ZTsKICB9CgogIGZ1bmN0aW9uIHZhbHVlTGVuZ3RoKHZhbHVlKSB7CiAgICBpZiAodmFsdWUgPT0gbnVsbCkgeyByZXR1cm4gMDsgfQogICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gInN0cmluZyIgfHwgdHlwZW9mIHZhbHVlLmxlbmd0aCA9PT0gIm51bWJlciIpIHsgcmV0dXJuIHZhbHVlLmxlbmd0aDsgfQogICAgaWYgKHR5cGVvZiBBcnJheUJ1ZmZlciAhPT0gInVuZGVmaW5lZCIgJiYgdmFsdWUgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikgeyByZXR1cm4gdmFsdWUuYnl0ZUxlbmd0aDsgfQogICAgcmV0dXJuIDA7CiAgfQoKICBmdW5jdGlvbiBvYmplY3RLZXlzKHZhbHVlKSB7CiAgICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gIm9iamVjdCIpIHsgcmV0dXJuICIiOyB9CiAgICB2YXIga2V5cyA9IFtdOwogICAgZm9yICh2YXIga2V5IGluIHZhbHVlKSB7CiAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwodmFsdWUsIGtleSkpIHsga2V5cy5wdXNoKGtleSk7IH0KICAgIH0KICAgIHJldHVybiBrZXlzLmpvaW4oIiwiKTsKICB9CgogIGZ1bmN0aW9uIGZpZWxkSGlzdG9ncmFtKGZpZWxkcykgewogICAgdmFyIGNvdW50cyA9IHt9OwogICAgdmFyIG9yZGVyID0gW107CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGZpZWxkcy5sZW5ndGg7IGkgKz0gMSkgewogICAgICB2YXIga2V5ID0gU3RyaW5nKGZpZWxkc1tpXS5maWVsZE51bWJlcikgKyAiLyIgKyBTdHJpbmcoZmllbGRzW2ldLndpcmVUeXBlKTsKICAgICAgaWYgKCFjb3VudHNba2V5XSkgeyBjb3VudHNba2V5XSA9IDA7IG9yZGVyLnB1c2goa2V5KTsgfQogICAgICBjb3VudHNba2V5XSArPSAxOwogICAgfQogICAgdmFyIHBhcnRzID0gW107CiAgICBmb3IgKHZhciBqID0gMDsgaiA8IG9yZGVyLmxlbmd0aDsgaiArPSAxKSB7IHBhcnRzLnB1c2gob3JkZXJbal0gKyAieCIgKyBjb3VudHNbb3JkZXJbal1dKTsgfQogICAgcmV0dXJuIHBhcnRzLmpvaW4oIiwiKTsKICB9CgogIGZ1bmN0aW9uIGNvdW50RmllbGRzKGZpZWxkcywgZmllbGROdW1iZXIpIHsKICAgIHZhciBjb3VudCA9IDA7CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGZpZWxkcy5sZW5ndGg7IGkgKz0gMSkgeyBpZiAoZmllbGRzW2ldLmZpZWxkTnVtYmVyID09PSBmaWVsZE51bWJlcikgeyBjb3VudCArPSAxOyB9IH0KICAgIHJldHVybiBjb3VudDsKICB9CgogIGZ1bmN0aW9uIGNvdW50Q2VsbFJlc3BvbnNlRmllbGRzKGZpZWxkcykgewogICAgdmFyIGNvdW50ID0gMDsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZmllbGRzLmxlbmd0aDsgaSArPSAxKSB7IGlmIChpc0NlbGxSZXNwb25zZUZpZWxkKGZpZWxkc1tpXS5maWVsZE51bWJlcikpIHsgY291bnQgKz0gMTsgfSB9CiAgICByZXR1cm4gY291bnQ7CiAgfQoKICBmdW5jdGlvbiBhcHBsZVdMb2NQYXlsb2FkSW5zcGVjdChwYXlsb2FkKSB7CiAgICB0cnkgewogICAgICB2YXIgZmllbGRzID0gcGFyc2VGaWVsZHMocGF5bG9hZCk7CiAgICAgIHZhciBwYXJ0cyA9IFsKICAgICAgICAicGF5bG9hZExlbj0iICsgcGF5bG9hZC5sZW5ndGgsICJmaWVsZHM9IiArIGZpZWxkSGlzdG9ncmFtKGZpZWxkcyksCiAgICAgICAgIndpZmk9IiArIGNvdW50RmllbGRzKGZpZWxkcywgMiksICJjZWxsUmVzcD0iICsgY291bnRDZWxsUmVzcG9uc2VGaWVsZHMoZmllbGRzKSwKICAgICAgICAiY2VsbFJlcT0iICsgY291bnRGaWVsZHMoZmllbGRzLCAyNSksCiAgICAgICAgImhhc0NvdW50cz0iICsgKGNvdW50RmllbGRzKGZpZWxkcywgMykgKyAiLyIgKyBjb3VudEZpZWxkcyhmaWVsZHMsIDQpKSwKICAgICAgICAiZGV2aWNlVHlwZT0iICsgY291bnRGaWVsZHMoZmllbGRzLCAzMyksIHBhdGNoZWRQYXlsb2FkU3VtbWFyeShwYXlsb2FkKQogICAgICBdOwogICAgICByZXR1cm4gcGFydHMuam9pbigiLCAiKTsKICAgIH0gY2F0Y2ggKGVycikgeyByZXR1cm4gInBheWxvYWQgcGFyc2UgZmFpbGVkOiAiICsgZXJyLm1lc3NhZ2U7IH0KICB9CgogIGZ1bmN0aW9uIGxvZ1Jhd0R1bXAobGFiZWwsIGJ5dGVzLCBjb25maWcpIHsKICAgIGlmICghY29uZmlnLmR1bXBSYXcgfHwgIWJ5dGVzKSB7IHJldHVybjsgfQogICAgdmFyIGxpbWl0ID0gY29uZmlnLnJhd0xpbWl0IHx8IDA7CiAgICB2YXIgZW1pdHRlZCA9IGxpbWl0ID4gMCAmJiBieXRlcy5sZW5ndGggPiBsaW1pdCA/IGJ5dGVzLnNsaWNlKDAsIGxpbWl0KSA6IGJ5dGVzOwogICAgdmFyIGVuY29kZWQgPSBieXRlc1RvQmFzZTY0KGVtaXR0ZWQpOwogICAgdmFyIGNodW5rU2l6ZSA9IDMwMDA7CiAgICB2YXIgY2h1bmtzID0gTWF0aC5tYXgoMSwgTWF0aC5jZWlsKGVuY29kZWQubGVuZ3RoIC8gY2h1bmtTaXplKSk7CiAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciByYXcgIiArIGxhYmVsICsgIiBiYXNlNjQgYmVnaW46IGxlbj0iICsgYnl0ZXMubGVuZ3RoICsgIiwgZW1pdHRlZD0iICsgZW1pdHRlZC5sZW5ndGggKyAiLCBjaHVua3M9IiArIGNodW5rcyArICIsIHRydW5jYXRlZD0iICsgKGVtaXR0ZWQubGVuZ3RoICE9PSBieXRlcy5sZW5ndGgpKTsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZW5jb2RlZC5sZW5ndGg7IGkgKz0gY2h1bmtTaXplKSB7CiAgICAgIHZhciBjaHVua0luZGV4ID0gTWF0aC5mbG9vcihpIC8gY2h1bmtTaXplKSArIDE7CiAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIHJhdyAiICsgbGFiZWwgKyAiIGJhc2U2NCBjaHVuayAiICsgY2h1bmtJbmRleCArICIvIiArIGNodW5rcyArICI6ICIgKyBlbmNvZGVkLnNsaWNlKGksIGkgKyBjaHVua1NpemUpKTsKICAgIH0KICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIHJhdyAiICsgbGFiZWwgKyAiIGJhc2U2NCBlbmQiKTsKICB9CgogIGZ1bmN0aW9uIGpzb25TdHJpbmcodmFsdWUpIHsKICAgIHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeSh2YWx1ZSB8fCB7fSk7IH0KICAgIGNhdGNoIChlcnIpIHsgcmV0dXJuICI8anNvbi1mYWlsZWQ6IiArIGVyci5tZXNzYWdlICsgIj4iOyB9CiAgfQoKICBmdW5jdGlvbiBsb2dIdHRwRHVtcChsYWJlbCwgbWVzc2FnZSwgY29uZmlnKSB7CiAgICBpZiAoIWNvbmZpZy5kdW1wSGVhZGVycyAmJiAhY29uZmlnLmR1bXBSYXcpIHsgcmV0dXJuOyB9CiAgICBtZXNzYWdlID0gbWVzc2FnZSB8fCB7fTsKICAgIHZhciByZXF1ZXN0ID0gdHlwZW9mICRyZXF1ZXN0ICE9PSAidW5kZWZpbmVkIiA/ICRyZXF1ZXN0IDoge307CiAgICB2YXIgbWV0aG9kID0gbWVzc2FnZS5tZXRob2QgfHwgcmVxdWVzdC5tZXRob2QgfHwgIjxub25lPiI7CiAgICB2YXIgdXJsID0gbWVzc2FnZS51cmwgfHwgcmVxdWVzdC51cmwgfHwgIjxub25lPiI7CiAgICB2YXIgc3RhdHVzID0gbWVzc2FnZS5zdGF0dXMgfHwgbWVzc2FnZS5zdGF0dXNDb2RlIHx8ICI8bm9uZT4iOwogICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcmF3ICIgKyBsYWJlbCArICIgbWV0YTogbWV0aG9kPSIgKyBtZXRob2QgKyAiLCB1cmw9IiArIHVybCArICIsIHN0YXR1cz0iICsgc3RhdHVzKTsKICAgIGlmIChjb25maWcuZHVtcEhlYWRlcnMpIHsgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcmF3ICIgKyBsYWJlbCArICIgaGVhZGVyczogIiArIGpzb25TdHJpbmcobWVzc2FnZS5oZWFkZXJzIHx8IHt9KSk7IH0KICB9CgogIGZ1bmN0aW9uIGluc3BlY3RSZXNwb25zZUJ5dGVzKGJ5dGVzLCBjb25maWcpIHsKICAgIGlmICghYnl0ZXMpIHsgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgaW5zcGVjdCByZXNwb25zZSBib2R5IHVuYXZhaWxhYmxlIik7IHJldHVybjsgfQogICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgaW5zcGVjdCByZXNwb25zZSBib2R5OiBsZW49IiArIGJ5dGVzLmxlbmd0aCArICIsIGhlYWQ9IiArIGhleFByZXZpZXcoYnl0ZXMsIDQ4KSk7CiAgICBsb2dSYXdEdW1wKCJyZXNwb25zZSIsIGJ5dGVzLCBjb25maWcpOwogICAgdHJ5IHsKICAgICAgdmFyIGV4dHJhY3Rpb24gPSBleHRyYWN0QXBwbGVXTG9jUGF5bG9hZChieXRlcyk7CiAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIGluc3BlY3QgcmVzcG9uc2UgZXh0cmFjdGlvbjoga2luZD0iICsgZXh0cmFjdGlvbi5raW5kICsgIiwgcHJlZml4PSIgKyAoZXh0cmFjdGlvbi5wcmVmaXggPyBoZXhQcmV2aWV3KGV4dHJhY3Rpb24ucHJlZml4LCA4KSA6ICI8bm9uZT4iKSArICIsIHBheWxvYWRMZW49IiArIGV4dHJhY3Rpb24ucGF5bG9hZC5sZW5ndGggKyAiLCBzdWZmaXhMZW49IiArIChleHRyYWN0aW9uLnN1ZmZpeCA/IGV4dHJhY3Rpb24uc3VmZml4Lmxlbmd0aCA6IDApKTsKICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgaW5zcGVjdCByZXNwb25zZSBwYXlsb2FkOiAiICsgYXBwbGVXTG9jUGF5bG9hZEluc3BlY3QoZXh0cmFjdGlvbi5wYXlsb2FkKSk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgaW5zcGVjdCByZXNwb25zZSBleHRyYWN0aW9uIGZhaWxlZDogIiArIGVyci5tZXNzYWdlKTsKICAgICAgdmFyIGRpcmVjdEZpZWxkcyA9IHRyeVBhcnNlRmllbGRzKGJ5dGVzKTsKICAgICAgaWYgKGRpcmVjdEZpZWxkcykgeyBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBpbnNwZWN0IHJlc3BvbnNlIGRpcmVjdCBmaWVsZHM6ICIgKyBmaWVsZEhpc3RvZ3JhbShkaXJlY3RGaWVsZHMpKTsgfQogICAgfQogIH0KCiAgZnVuY3Rpb24gaW5zcGVjdFJlcXVlc3RCeXRlcyhieXRlcywgY29uZmlnKSB7CiAgICBpZiAoIWJ5dGVzKSB7IGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIGluc3BlY3QgcmVxdWVzdCBib2R5IHVuYXZhaWxhYmxlIik7IHJldHVybjsgfQogICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgaW5zcGVjdCByZXF1ZXN0IGJvZHk6IGxlbj0iICsgYnl0ZXMubGVuZ3RoICsgIiwgaGVhZD0iICsgaGV4UHJldmlldyhieXRlcywgNDgpKTsKICAgIGxvZ1Jhd0R1bXAoInJlcXVlc3QiLCBieXRlcywgY29uZmlnKTsKICAgIHRyeSB7CiAgICAgIHZhciBhcnBjID0gcGFyc2VBcnBjKGJ5dGVzKTsKICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgaW5zcGVjdCByZXF1ZXN0IGFycGM6IHZlcnNpb249IiArIGFycGMudmVyc2lvbiArICIsIGZ1bmN0aW9uSWQ9IiArIGFycGMuZnVuY3Rpb25JZCArICIsIGxvY2FsZT0iICsgYXJwYy5sb2NhbGUgKyAiLCBhcHA9IiArIGFycGMuYXBwSWRlbnRpZmllciArICIsIG9zPSIgKyBhcnBjLm9zVmVyc2lvbiArICIsIHBheWxvYWRMZW49IiArIGFycGMucGF5bG9hZC5sZW5ndGgpOwogICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBpbnNwZWN0IHJlcXVlc3QgcGF5bG9hZDogIiArIGFwcGxlV0xvY1BheWxvYWRJbnNwZWN0KGFycGMucGF5bG9hZCkpOwogICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIGluc3BlY3QgcmVxdWVzdCBhcnBjIGZhaWxlZDogIiArIGVyci5tZXNzYWdlKTsKICAgICAgdmFyIGRpcmVjdEZpZWxkcyA9IHRyeVBhcnNlRmllbGRzKGJ5dGVzKTsKICAgICAgaWYgKGRpcmVjdEZpZWxkcykgeyBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBpbnNwZWN0IHJlcXVlc3QgZGlyZWN0IGZpZWxkczogIiArIGZpZWxkSGlzdG9ncmFtKGRpcmVjdEZpZWxkcykpOyB9CiAgICB9CiAgfQoKICBmdW5jdGlvbiBkb25lSW5zcGVjdChjb25maWcsIGhhc1Jlc3BvbnNlKSB7CiAgICBpZiAoaGFzUmVzcG9uc2UpIHsKICAgICAgbG9nSHR0cER1bXAoInJlc3BvbnNlIiwgJHJlc3BvbnNlLCBjb25maWcpOwogICAgICBpbnNwZWN0UmVzcG9uc2VCeXRlcyhtZXNzYWdlQm9keVRvQnl0ZXMoJHJlc3BvbnNlKSwgY29uZmlnKTsKICAgIH0gZWxzZSB7CiAgICAgIGxvZ0h0dHBEdW1wKCJyZXF1ZXN0IiwgJHJlcXVlc3QsIGNvbmZpZyk7CiAgICAgIGluc3BlY3RSZXF1ZXN0Qnl0ZXMobWVzc2FnZUJvZHlUb0J5dGVzKCRyZXF1ZXN0KSwgY29uZmlnKTsKICAgICAgaWYgKGNvbmZpZy5wcmVwYXJlSGVhZGVycykgeyBkb25lUHJlcGFyZWRSZXF1ZXN0UGFzc1Rocm91Z2goKTsgcmV0dXJuOyB9CiAgICB9CiAgICBkb25lUGFzc1Rocm91Z2goKTsKICB9CgogIGZ1bmN0aW9uIGRvbmVSZXNwb25zZVByb2JlKGNvbmZpZykgewogICAgdmFyIHJlc3BvbnNlID0gdHlwZW9mICRyZXNwb25zZSAhPT0gInVuZGVmaW5lZCIgPyAkcmVzcG9uc2UgOiB7fTsKICAgIHZhciBoZWFkZXJzID0gcmVzcG9uc2UuaGVhZGVycyB8fCB7fTsKICAgIGlmIChjb25maWcuZGVidWcpIHsKICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcHJvYmUgcmVzcG9uc2Uga2V5czogIiArIG9iamVjdEtleXMocmVzcG9uc2UpKTsKICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcHJvYmUgaGVhZGVyczogc3RhdHVzPSIgKyAocmVzcG9uc2Uuc3RhdHVzIHx8IHJlc3BvbnNlLnN0YXR1c0NvZGUgfHwgIjxub25lPiIpICsgIiwgY29udGVudC1sZW5ndGg9IiArIChoZWFkZXJWYWx1ZShoZWFkZXJzLCAiQ29udGVudC1MZW5ndGgiKSB8fCAiPG5vbmU+IikgKyAiLCBjb250ZW50LXR5cGU9IiArIChoZWFkZXJWYWx1ZShoZWFkZXJzLCAiQ29udGVudC1UeXBlIikgfHwgIjxub25lPiIpICsgIiwgY29udGVudC1lbmNvZGluZz0iICsgKGhlYWRlclZhbHVlKGhlYWRlcnMsICJDb250ZW50LUVuY29kaW5nIikgfHwgIm5vbmUiKSk7CiAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIHByb2JlIGJvZHkgc2xvdHM6IGJvZHk9IiArIHZhbHVlVHlwZShyZXNwb25zZS5ib2R5KSArICIvIiArIHZhbHVlTGVuZ3RoKHJlc3BvbnNlLmJvZHkpICsgIiwgYm9keUJ5dGVzPSIgKyB2YWx1ZVR5cGUocmVzcG9uc2UuYm9keUJ5dGVzKSArICIvIiArIHZhbHVlTGVuZ3RoKHJlc3BvbnNlLmJvZHlCeXRlcykgKyAiLCByYXdCb2R5PSIgKyB2YWx1ZVR5cGUocmVzcG9uc2UucmF3Qm9keSkgKyAiLyIgKyB2YWx1ZUxlbmd0aChyZXNwb25zZS5yYXdCb2R5KSArICIsIGJpbmFyeUJvZHk9IiArIHZhbHVlVHlwZShyZXNwb25zZS5iaW5hcnlCb2R5KSArICIvIiArIHZhbHVlTGVuZ3RoKHJlc3BvbnNlLmJpbmFyeUJvZHkpKTsKICAgICAgdmFyIGJ5dGVzID0gbWVzc2FnZUJvZHlUb0J5dGVzKHJlc3BvbnNlKTsKICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcHJvYmUgc2VsZWN0ZWQgYm9keTogIiArIChieXRlcyA/IGJ5dGVzLmxlbmd0aCA6IDApICsgIiBieXRlcywgaGVhZD0iICsgKGJ5dGVzID8gaGV4UHJldmlldyhieXRlcywgMzIpIDogIjxub25lPiIpKTsKICAgIH0KICAgIGRvbmVQYXNzVGhyb3VnaCgpOwogIH0KCiAgZnVuY3Rpb24gZG9uZVN5bnRoZXRpY1Jlc3BvbnNlKGJ5dGVzLCBpbmZvKSB7CiAgICB2YXIgaGVhZGVycyA9IGhlYWRlcnNXaXRoQmluYXJ5Qm9keSh7fSwgYnl0ZXMubGVuZ3RoKTsKICAgIGlmIChpbmZvICYmIGluZm8uZGVidWcpIHsKICAgICAgaGVhZGVyc1siWC1Mb2NhdGlvbi1TcG9vZmVyLVdpZmktQ291bnQiXSA9IFN0cmluZyhpbmZvLndpZmlDb3VudCk7CiAgICAgIGhlYWRlcnNbIlgtTG9jYXRpb24tU3Bvb2Zlci1DZWxsLUNvdW50Il0gPSBTdHJpbmcoaW5mby5jZWxsQ291bnQgfHwgMCk7CiAgICB9CiAgICBpZiAoaXNMb29uUnVudGltZSgpKSB7CiAgICAgICRkb25lKHsgc3RhdHVzOiAyMDAsIGhlYWRlcnM6IGhlYWRlcnMsIGJvZHk6IGJ5dGVzIH0pOwogICAgICByZXR1cm47CiAgICB9CiAgICAkZG9uZSh7IHJlc3BvbnNlOiB7IHN0YXR1czogMjAwLCBoZWFkZXJzOiBoZWFkZXJzLCBib2R5OiBieXRlcyB9IH0pOwogIH0KCiAgZnVuY3Rpb24gZG9uZVJld3JpdGVSZXNwb25zZShieXRlcywgaW5mbykgewogICAgdmFyIHNvdXJjZUhlYWRlcnMgPSB0eXBlb2YgJHJlc3BvbnNlICE9PSAidW5kZWZpbmVkIiA/ICRyZXNwb25zZS5oZWFkZXJzIDoge307CiAgICB2YXIgaGVhZGVycyA9IGhlYWRlcnNXaXRoQmluYXJ5Qm9keShzb3VyY2VIZWFkZXJzLCBieXRlcy5sZW5ndGgpOwogICAgaWYgKGluZm8gJiYgaW5mby5kZWJ1ZykgewogICAgICBoZWFkZXJzWyJYLUxvY2F0aW9uLVNwb29mZXItV2lmaS1Db3VudCJdID0gU3RyaW5nKGluZm8ud2lmaUNvdW50KTsKICAgICAgaGVhZGVyc1siWC1Mb2NhdGlvbi1TcG9vZmVyLUNlbGwtQ291bnQiXSA9IFN0cmluZyhpbmZvLmNlbGxDb3VudCB8fCAwKTsKICAgIH0KICAgIGlmIChpbmZvICYmIGluZm8udGFyZ2V0TGF0ICE9IG51bGwgJiYgaW5mby50YXJnZXRMbmcgIT0gbnVsbCkgewogICAgICBoZWFkZXJzWyJYLUxvY2F0aW9uLVNwb29mZXItVGFyZ2V0Il0gPSBTdHJpbmcoaW5mby50YXJnZXRMYXQpICsgIiwgIiArIFN0cmluZyhpbmZvLnRhcmdldExuZyk7CiAgICB9CiAgICBpZiAoaXNMb29uUnVudGltZSgpKSB7CiAgICAgICRkb25lKHsgc3RhdHVzOiAoJHJlc3BvbnNlICYmICRyZXNwb25zZS5zdGF0dXMpIHx8IDIwMCwgaGVhZGVyczogaGVhZGVycywgYm9keTogYnl0ZXMgfSk7CiAgICAgIHJldHVybjsKICAgIH0KICAgICRkb25lKHsgaGVhZGVyczogaGVhZGVycywgYm9keTogYnl0ZXMgfSk7CiAgfQoKICBmdW5jdGlvbiBjb250aW51ZVJlc3BvbnNlUmV3cml0ZShjb25maWcpIHsKICAgIHZhciByZXNwb25zZUJvZHkgPSBtZXNzYWdlQm9keVRvQnl0ZXMoJHJlc3BvbnNlKTsKICAgIGlmICghcmVzcG9uc2VCb2R5IHx8IHJlc3BvbnNlQm9keS5sZW5ndGggPCAyKSB7CiAgICAgIGlmIChjb25maWcuZGVidWcpIHsKICAgICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciByZXNwb25zZSBib2R5IHRvbyBzaG9ydDogIiArIChyZXNwb25zZUJvZHkgPyByZXNwb25zZUJvZHkubGVuZ3RoIDogMCkgKyAiIGJ5dGVzLCBoZWFkPSIgKyAocmVzcG9uc2VCb2R5ID8gaGV4UHJldmlldyhyZXNwb25zZUJvZHkpIDogIjxub25lPiIpKTsKICAgICAgfQogICAgICBkb25lUGFzc1Rocm91Z2goKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgaWYgKGNvbmZpZy5kZWJ1ZykgewogICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciByZXNwb25zZSBib2R5OiAiICsgcmVzcG9uc2VCb2R5Lmxlbmd0aCArICIgYnl0ZXMsIGhlYWQ9IiArIGhleFByZXZpZXcocmVzcG9uc2VCb2R5LCAzMikpOwogICAgICBpZiAoaXNMb29uUnVudGltZSgpKSB7IGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIHJ1bnRpbWU6IExvb24iKTsgfQogICAgfQogICAgbG9nSHR0cER1bXAoInJlc3BvbnNlLW9yaWdpbmFsIiwgJHJlc3BvbnNlLCBjb25maWcpOwogICAgbG9nUmF3RHVtcCgicmVzcG9uc2Utb3JpZ2luYWwiLCByZXNwb25zZUJvZHksIGNvbmZpZyk7CiAgICB2YXIgcmVzcG9uc2VSZXN1bHQgPSBzcG9vZkFwcGxlUmVzcG9uc2UocmVzcG9uc2VCb2R5LCBjb25maWcpOwogICAgaWYgKGNvbmZpZy5kZWJ1ZykgewogICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBwYXRjaGVkICIgKyByZXNwb25zZVJlc3VsdC53aWZpQ291bnQgKyAiIHdpZmkgZGV2aWNlcywgIiArIHJlc3BvbnNlUmVzdWx0LmNlbGxDb3VudCArICIgY2VsbCB0b3dlcnMsIGtpbmQ9IiArIHJlc3BvbnNlUmVzdWx0LmtpbmQgKyAiLCBwcmVmaXg9IiArIChyZXNwb25zZVJlc3VsdC5wcmVmaXggfHwgIjxub25lPiIpICsgIiwgcmVzcG9uc2U9IiArIHJlc3BvbnNlUmVzdWx0LnJlc3BvbnNlLmxlbmd0aCArICIgYnl0ZXMiKTsKICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcGF0Y2hlZCBsb2NhdGlvbnM6ICIgKyBwYXRjaGVkUGF5bG9hZFN1bW1hcnkocmVzcG9uc2VSZXN1bHQucGF5bG9hZCkpOwogICAgfQogICAgbG9nUmF3RHVtcCgicmVzcG9uc2UtcGF0Y2hlZCIsIHJlc3BvbnNlUmVzdWx0LnJlc3BvbnNlLCBjb25maWcpOwogICAgZG9uZVJld3JpdGVSZXNwb25zZShyZXNwb25zZVJlc3VsdC5yZXNwb25zZSwgewogICAgICB3aWZpQ291bnQ6IHJlc3BvbnNlUmVzdWx0LndpZmlDb3VudCwgY2VsbENvdW50OiByZXNwb25zZVJlc3VsdC5jZWxsQ291bnQsCiAgICAgIGRlYnVnOiBjb25maWcuZGVidWcsIHRhcmdldExhdDogY29uZmlnLmxhdGl0dWRlLCB0YXJnZXRMbmc6IGNvbmZpZy5sb25naXR1ZGUKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gcHJlcGFyZVJlc3BvbnNlQm9keShjb25maWcpIHsgcHJlcGFyZVJlc3BvbnNlQm9keVN5bmMoY29uZmlnKTsgfQoKICBmdW5jdGlvbiBydW5TaGFkb3dyb2NrZXQoKSB7CiAgICB2YXIgaGFzUmVxdWVzdCA9IHR5cGVvZiAkcmVxdWVzdCAhPT0gInVuZGVmaW5lZCIgJiYgJHJlcXVlc3QgIT0gbnVsbDsKICAgIHZhciBoYXNSZXNwb25zZSA9IHR5cGVvZiAkcmVzcG9uc2UgIT09ICJ1bmRlZmluZWQiICYmICRyZXNwb25zZSAhPSBudWxsOwogICAgaWYgKCFoYXNSZXF1ZXN0ICYmICFoYXNSZXNwb25zZSkgeyBydW5NYWludGVuYW5jZUNyb24oKTsgcmV0dXJuOyB9CiAgICBpZiAoaGFzUmVxdWVzdCAmJiAhaGFzUmVzcG9uc2UpIHsKICAgICAgdmFyIHByZXBBcmdzID0gcmVhZFNjcmlwdEFyZ3VtZW50cygpOwogICAgICBpZiAocGFyc2VCb29sZWFuKHByZXBBcmdzLmRlYnVnLCBmYWxzZSkpIHsgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcHJlcGFyZSAtPiBBY2NlcHQtRW5jb2Rpbmc6IGlkZW50aXR5Iik7IH0KICAgICAgZG9uZVByZXBhcmVkUmVxdWVzdFBhc3NUaHJvdWdoKCk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGxvYWRSdW50aW1lQ29uZmlnKGZ1bmN0aW9uIChjb25maWcpIHsKICAgICAgdHJ5IHsKICAgICAgICBpZiAoIWNvbmZpZy5lbmFibGVkKSB7IGRvbmVQYXNzVGhyb3VnaCgpOyByZXR1cm47IH0KICAgICAgICBpZiAoY29uZmlnLm1vZGUgPT09ICJpbnNwZWN0IikgeyBkb25lSW5zcGVjdChjb25maWcsIGhhc1Jlc3BvbnNlKTsgcmV0dXJuOyB9CiAgICAgICAgaWYgKGhhc1Jlc3BvbnNlKSB7CiAgICAgICAgICBpZiAoY29uZmlnLmRlYnVnKSB7CiAgICAgICAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIGludGVyY2VwdCAtPiBsYXQ9IiArIGNvbmZpZy5sYXRpdHVkZSArICIsIGxuZz0iICsgY29uZmlnLmxvbmdpdHVkZSArICIsIHVybD0iICsgKCgkcmVxdWVzdCAmJiAkcmVxdWVzdC51cmwpIHx8ICI8bm9uZT4iKSk7CiAgICAgICAgICB9CiAgICAgICAgICBpZiAoY29uZmlnLm1vZGUgPT09ICJwcm9iZSIpIHsgZG9uZVJlc3BvbnNlUHJvYmUoY29uZmlnKTsgcmV0dXJuOyB9CiAgICAgICAgICBpZiAoY29uZmlnLm1vZGUgIT09ICJyZXNwb25zZSIpIHsgZG9uZVBhc3NUaHJvdWdoKCk7IHJldHVybjsgfQogICAgICAgICAgcHJlcGFyZVJlc3BvbnNlQm9keShjb25maWcpOwogICAgICAgICAgY29udGludWVSZXNwb25zZVJld3JpdGUoY29uZmlnKTsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgICAgaWYgKGNvbmZpZy5tb2RlICE9PSAicmVxdWVzdCIpIHsgZG9uZVBhc3NUaHJvdWdoKCk7IHJldHVybjsgfQogICAgICAgIHZhciByZXF1ZXN0Qm9keSA9IG1lc3NhZ2VCb2R5VG9CeXRlcygkcmVxdWVzdCk7CiAgICAgICAgaWYgKGNvbmZpZy5kZWJ1ZykgeyBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciByZXF1ZXN0IG1vZGUgYm9keSBsZW5ndGg6ICIgKyAocmVxdWVzdEJvZHkgPyByZXF1ZXN0Qm9keS5sZW5ndGggOiAwKSk7IH0KICAgICAgICBpZiAoIXJlcXVlc3RCb2R5KSB7CiAgICAgICAgICBpZiAoY29uZmlnLmRlYnVnKSB7IGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIHJlcXVlc3QgYm9keSB1bmF2YWlsYWJsZSIpOyB9CiAgICAgICAgICBkb25lUGFzc1Rocm91Z2goKTsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgICAgaWYgKHJlcXVlc3RCb2R5Lmxlbmd0aCA8IDIpIHsKICAgICAgICAgIGlmIChjb25maWcuZGVidWcpIHsgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcmVxdWVzdCBib2R5IHRvbyBzaG9ydDogIiArIHJlcXVlc3RCb2R5Lmxlbmd0aCArICIgYnl0ZXMsIGhlYWQ9IiArIGhleFByZXZpZXcocmVxdWVzdEJvZHkpKTsgfQogICAgICAgICAgZG9uZVBhc3NUaHJvdWdoKCk7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQogICAgICAgIGxvZ0h0dHBEdW1wKCJyZXF1ZXN0LW9yaWdpbmFsIiwgJHJlcXVlc3QsIGNvbmZpZyk7CiAgICAgICAgbG9nUmF3RHVtcCgicmVxdWVzdC1vcmlnaW5hbCIsIHJlcXVlc3RCb2R5LCBjb25maWcpOwogICAgICAgIHZhciByZXF1ZXN0UmVzdWx0ID0gc3Bvb2ZBcnBjUmVxdWVzdChyZXF1ZXN0Qm9keSwgY29uZmlnKTsKICAgICAgICBpZiAoY29uZmlnLmRlYnVnKSB7CiAgICAgICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciByZXF1ZXN0IHN5bnRoZXRpYyByZXNwb25zZTogcGF0Y2hlZCAiICsgcmVxdWVzdFJlc3VsdC53aWZpQ291bnQgKyAiIHdpZmkgZGV2aWNlcywgIiArIHJlcXVlc3RSZXN1bHQuY2VsbENvdW50ICsgIiBjZWxsIHRvd2VycywgcmVzcG9uc2U9IiArIHJlcXVlc3RSZXN1bHQucmVzcG9uc2UubGVuZ3RoICsgIiBieXRlcyIpOwogICAgICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcGF0Y2hlZCBsb2NhdGlvbnM6ICIgKyBwYXRjaGVkUGF5bG9hZFN1bW1hcnkocmVxdWVzdFJlc3VsdC5wYXlsb2FkKSk7CiAgICAgICAgfQogICAgICAgIGxvZ1Jhd0R1bXAoInJlcXVlc3Qtc3ludGhldGljLXJlc3BvbnNlIiwgcmVxdWVzdFJlc3VsdC5yZXNwb25zZSwgY29uZmlnKTsKICAgICAgICBkb25lU3ludGhldGljUmVzcG9uc2UocmVxdWVzdFJlc3VsdC5yZXNwb25zZSwgewogICAgICAgICAgd2lmaUNvdW50OiByZXF1ZXN0UmVzdWx0LndpZmlDb3VudCwgY2VsbENvdW50OiByZXF1ZXN0UmVzdWx0LmNlbGxDb3VudCwgZGVidWc6IGNvbmZpZy5kZWJ1ZwogICAgICAgIH0pOwogICAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgICBpZiAoY29uZmlnLmRlYnVnKSB7CiAgICAgICAgICB2YXIgZGlhZ0JvZHkgPSBoYXNSZXNwb25zZSA/IG1lc3NhZ2VCb2R5VG9CeXRlcygkcmVzcG9uc2UpIDogbWVzc2FnZUJvZHlUb0J5dGVzKCRyZXF1ZXN0KTsKICAgICAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIGZhaWxlZDogIiArIGVyci5tZXNzYWdlICsgIiB8IGJvZHlMZW49IiArIChkaWFnQm9keSA/IGRpYWdCb2R5Lmxlbmd0aCA6IDApICsgIiBoZWFkPSIgKyAoZGlhZ0JvZHkgPyBoZXhQcmV2aWV3KGRpYWdCb2R5LCAzMikgOiAiPG5vbmU+IikpOwogICAgICAgIH0KICAgICAgICBpZiAoY29uZmlnLmZhaWxPcGVuICE9PSBmYWxzZSkgeyBkb25lUGFzc1Rocm91Z2goKTsgcmV0dXJuOyB9CiAgICAgICAgJGRvbmUoeyByZXNwb25zZTogeyBzdGF0dXM6ICJIVFRQLzEuMSA1MDAgSW50ZXJuYWwgU2VydmVyIEVycm9yIiwgaGVhZGVyczogeyAiQ29udGVudC1UeXBlIjogInRleHQvcGxhaW4iIH0sIGJvZHk6ICJsb2NhdGlvbiBzcG9vZmVyIGZhaWxlZDogIiArIGVyci5tZXNzYWdlIH0gfSk7CiAgICAgIH0KICAgIH0pOwogIH0KCiAgdmFyIGFwaSA9IHsKICAgIERFRkFVTFRfQ09ORklHOiBERUZBVUxUX0NPTkZJRywgQVBQTEVfV0xPQ19QUkVGSVg6IEFQUExFX1dMT0NfUFJFRklYLAogICAgQVBQTEVfV0xPQ19NQVJLRVI6IEFQUExFX1dMT0NfTUFSS0VSLCBib2R5VG9CeXRlczogYm9keVRvQnl0ZXMsCiAgICBtZXNzYWdlQm9keVRvQnl0ZXM6IG1lc3NhZ2VCb2R5VG9CeXRlcywgaGV4UHJldmlldzogaGV4UHJldmlldywKICAgIGJ5dGVzVG9CaW5hcnlTdHJpbmc6IGJ5dGVzVG9CaW5hcnlTdHJpbmcsIGJ5dGVzVG9CYXNlNjQ6IGJ5dGVzVG9CYXNlNjQsCiAgICBiaW5hcnlTdHJpbmdUb0J5dGVzOiBiaW5hcnlTdHJpbmdUb0J5dGVzLCBjb25jYXRCeXRlczogY29uY2F0Qnl0ZXMsCiAgICByZWFkVUludDE2QkU6IHJlYWRVSW50MTZCRSwgd3JpdGVVSW50MTZCRTogd3JpdGVVSW50MTZCRSwKICAgIGVuY29kZVZhcmludFVuc2lnbmVkOiBlbmNvZGVWYXJpbnRVbnNpZ25lZCwgZW5jb2RlVmFyaW50U2lnbmVkSW50NjQ6IGVuY29kZVZhcmludFNpZ25lZEludDY0LAogICAgZGVjb2RlVmFyaW50OiBkZWNvZGVWYXJpbnQsIG1ha2VWYXJpbnRGaWVsZDogbWFrZVZhcmludEZpZWxkLAogICAgbWFrZUxlbmd0aERlbGltaXRlZEZpZWxkOiBtYWtlTGVuZ3RoRGVsaW1pdGVkRmllbGQsIHBhcnNlRmllbGRzOiBwYXJzZUZpZWxkcywKICAgIHRyeVBhcnNlRmllbGRzOiB0cnlQYXJzZUZpZWxkcywgZmlyc3RGaWVsZEJ5TnVtYmVyOiBmaXJzdEZpZWxkQnlOdW1iZXIsCiAgICBsb2NhdGlvblN1bW1hcnk6IGxvY2F0aW9uU3VtbWFyeSwgcGF0Y2hlZFBheWxvYWRTdW1tYXJ5OiBwYXRjaGVkUGF5bG9hZFN1bW1hcnksCiAgICBjb29yZFRvSW50OiBjb29yZFRvSW50LCBub3JtYWxpemVDb25maWc6IG5vcm1hbGl6ZUNvbmZpZywgcGF0Y2hMb2NhdGlvbjogcGF0Y2hMb2NhdGlvbiwKICAgIHBhdGNoV2lmaURldmljZTogcGF0Y2hXaWZpRGV2aWNlLCBwYXRjaENlbGxUb3dlcjogcGF0Y2hDZWxsVG93ZXIsCiAgICBwYXRjaEFwcGxlV0xvY1BheWxvYWQ6IHBhdGNoQXBwbGVXTG9jUGF5bG9hZCwgcGFyc2VBcnBjOiBwYXJzZUFycGMsCiAgICBzZXJpYWxpemVBcnBjOiBzZXJpYWxpemVBcnBjLCBidWlsZEFwcGxlV0xvY1Jlc3BvbnNlOiBidWlsZEFwcGxlV0xvY1Jlc3BvbnNlLAogICAgZXh0cmFjdEFwcGxlV0xvY1BheWxvYWQ6IGV4dHJhY3RBcHBsZVdMb2NQYXlsb2FkLCBzcG9vZkFycGNSZXF1ZXN0OiBzcG9vZkFycGNSZXF1ZXN0LAogICAgc3Bvb2ZBcHBsZVJlc3BvbnNlOiBzcG9vZkFwcGxlUmVzcG9uc2UsIHBhcnNlQXJndW1lbnRTdHJpbmc6IHBhcnNlQXJndW1lbnRTdHJpbmcsCiAgICByZWFkU2NyaXB0QXJndW1lbnRzOiByZWFkU2NyaXB0QXJndW1lbnRzLCBnZW9jb2RlQWRkcmVzczogZ2VvY29kZUFkZHJlc3MsCiAgICBwcmVwYXJlUmVxdWVzdEhlYWRlcnM6IHByZXBhcmVSZXF1ZXN0SGVhZGVycwogIH07CgogIGlmICh0eXBlb2YgbW9kdWxlICE9PSAidW5kZWZpbmVkIiAmJiBtb2R1bGUuZXhwb3J0cykgeyBtb2R1bGUuZXhwb3J0cyA9IGFwaTsgfQogIGVsc2UgeyBydW5TaGFkb3dyb2NrZXQoKTsgfQp9KSgpOwo=";
const LOCATION_SETTINGS_B64 = "LyoKICogbG9jYXRpb24tc2V0dGluZ3MuanMg4oCUIHN0YXRlbGVzcyBzYXZlLWludGVyY2VwdG9yIGZvciBpT1MgTG9jYXRpb24gU3Bvb2Zlci4KICogUnVucyBhcyBhbiBodHRwLVJFUVVFU1Qgc2NyaXB0IG9uIGdzLWxvYy5hcHBsZS5jb20vaWxzLXNldHRpbmdzL+KApgogKi8KKGZ1bmN0aW9uICgpIHsKICAidXNlIHN0cmljdCI7CgogIHZhciBpc1F1YW5YID0gdHlwZW9mICR0YXNrICE9PSAidW5kZWZpbmVkIjsKCiAgZnVuY3Rpb24gcmVhZEtleShrKSB7CiAgICB0cnkgeyByZXR1cm4gaXNRdWFuWCA/ICRwcmVmcy52YWx1ZUZvcktleShrKSA6ICRwZXJzaXN0ZW50U3RvcmUucmVhZChrKTsgfQogICAgY2F0Y2ggKGUpIHsgcmV0dXJuIG51bGw7IH0KICB9CiAgZnVuY3Rpb24gd3JpdGVLZXkoaywgdikgewogICAgdHJ5IHsgcmV0dXJuIGlzUXVhblggPyAkcHJlZnMuc2V0VmFsdWVGb3JLZXkoU3RyaW5nKHYpLCBrKSA6ICRwZXJzaXN0ZW50U3RvcmUud3JpdGUoU3RyaW5nKHYpLCBrKTsgfQogICAgY2F0Y2ggKGUpIHsgcmV0dXJuIGZhbHNlOyB9CiAgfQoKICBmdW5jdGlvbiBwYXJzZVF1ZXJ5KHVybCkgewogICAgdmFyIG91dCA9IHt9OwogICAgdmFyIHFpID0gdXJsLmluZGV4T2YoIj8iKTsKICAgIGlmIChxaSA8IDApIHJldHVybiBvdXQ7CiAgICB2YXIgcGFydHMgPSB1cmwuc2xpY2UocWkgKyAxKS5zcGxpdCgiJiIpOwogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBwYXJ0cy5sZW5ndGg7IGkgKz0gMSkgewogICAgICBpZiAoIXBhcnRzW2ldKSBjb250aW51ZTsKICAgICAgdmFyIGVxID0gcGFydHNbaV0uaW5kZXhPZigiPSIpOwogICAgICB2YXIgayA9IGVxIDwgMCA/IHBhcnRzW2ldIDogcGFydHNbaV0uc2xpY2UoMCwgZXEpOwogICAgICB2YXIgdiA9IGVxIDwgMCA/ICIiIDogcGFydHNbaV0uc2xpY2UoZXEgKyAxKTsKICAgICAgdHJ5IHsgayA9IGRlY29kZVVSSUNvbXBvbmVudChrLnJlcGxhY2UoL1wrL2csICIgIikpOyB9IGNhdGNoIChlKSB7fQogICAgICB0cnkgeyB2ID0gZGVjb2RlVVJJQ29tcG9uZW50KHYucmVwbGFjZSgvXCsvZywgIiAiKSk7IH0gY2F0Y2ggKGUpIHt9CiAgICAgIGlmICghKGsgaW4gb3V0KSkgb3V0W2tdID0gdjsKICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICBmdW5jdGlvbiBmaW5pdGVOdW0ocykgewogICAgaWYgKHMgPT0gbnVsbCB8fCBzID09PSAiIikgcmV0dXJuIE5hTjsKICAgIHZhciBuID0gcGFyc2VGbG9hdChzKTsKICAgIHJldHVybiBpc0Zpbml0ZShuKSA/IG4gOiBOYU47CiAgfQoKICB2YXIgdXJsID0gKHR5cGVvZiAkcmVxdWVzdCAhPT0gInVuZGVmaW5lZCIgJiYgJHJlcXVlc3QgJiYgJHJlcXVlc3QudXJsKSB8fCAiIjsKICB2YXIgcSA9IHBhcnNlUXVlcnkodXJsKTsKICB2YXIgYWN0aW9uID0gcS5hY3Rpb24gfHwgInNhdmUiOwogIHZhciByZXN1bHQ7CgogIGlmIChhY3Rpb24gPT09ICJxdWVyeSIpIHsKICAgIHZhciBxbGF0ID0gcmVhZEtleSgibGF0aXR1ZGUiKTsKICAgIHZhciBxbG9uID0gcmVhZEtleSgibG9uZ2l0dWRlIik7CiAgICB2YXIgcWFsdCA9IHJlYWRLZXkoImFsdGl0dWRlIik7CiAgICB2YXIgcWVuID0gcmVhZEtleSgiZW5hYmxlZCIpOwogICAgdmFyIHFoYWNjID0gcmVhZEtleSgiaG9yaXpvbnRhbEFjY3VyYWN5Iik7CiAgICB2YXIgcXZhY2MgPSByZWFkS2V5KCJ2ZXJ0aWNhbEFjY3VyYWN5Iik7CiAgICB2YXIgcXJyID0gcmVhZEtleSgicmFuZG9tUmFkaXVzIik7CiAgICBpZiAocWxhdCAhPSBudWxsICYmIHFsYXQgIT09ICIiICYmIHFsb24gIT0gbnVsbCAmJiBxbG9uICE9PSAiIikgewogICAgICByZXN1bHQgPSB7CiAgICAgICAgc3VjY2VzczogdHJ1ZSwKICAgICAgICBsYXRpdHVkZTogTnVtYmVyKHFsYXQpLCBsb25naXR1ZGU6IE51bWJlcihxbG9uKSwKICAgICAgICBhbHRpdHVkZTogcWFsdCAhPSBudWxsICYmIHFhbHQgIT09ICIiID8gTnVtYmVyKHFhbHQpIDogbnVsbCwKICAgICAgICBob3Jpem9udGFsQWNjdXJhY3k6IHFoYWNjICE9IG51bGwgJiYgcWhhY2MgIT09ICIiID8gTnVtYmVyKHFoYWNjKSA6IG51bGwsCiAgICAgICAgdmVydGljYWxBY2N1cmFjeTogcXZhY2MgIT0gbnVsbCAmJiBxdmFjYyAhPT0gIiIgPyBOdW1iZXIocXZhY2MpIDogbnVsbCwKICAgICAgICByYW5kb21SYWRpdXM6IHFyciAhPSBudWxsICYmIHFyciAhPT0gIiIgPyBOdW1iZXIocXJyKSA6IG51bGwsCiAgICAgICAgZW5hYmxlZDogU3RyaW5nKHFlbikgPT09ICJ0cnVlIgogICAgICB9OwogICAgfSBlbHNlIHsKICAgICAgcmVzdWx0ID0geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6ICJObyBzYXZlZCBjb29yZGluYXRlcyIgfTsKICAgIH0KICB9IGVsc2UgaWYgKGFjdGlvbiA9PT0gImNsZWFyIikgewogICAgd3JpdGVLZXkoImVuYWJsZWQiLCAiZmFsc2UiKTsKICAgIHJlc3VsdCA9IHsgc3VjY2VzczogdHJ1ZSB9OwogIH0gZWxzZSB7CiAgICB2YXIgbG9uID0gZmluaXRlTnVtKHEubG9uICE9IG51bGwgPyBxLmxvbiA6IHEubG9uZ2l0dWRlKTsKICAgIHZhciBsYXQgPSBmaW5pdGVOdW0ocS5sYXQgIT0gbnVsbCA/IHEubGF0IDogcS5sYXRpdHVkZSk7CiAgICB2YXIgYWx0ID0gZmluaXRlTnVtKHEuYWx0ICE9IG51bGwgPyBxLmFsdCA6IHEuYWx0aXR1ZGUpOwogICAgdmFyIGhhY2MgPSBmaW5pdGVOdW0ocS5oYWNjICE9IG51bGwgPyBxLmhhY2MgOiBxLmhvcml6b250YWxBY2N1cmFjeSk7CiAgICB2YXIgdmFjYyA9IGZpbml0ZU51bShxLnZhY2MgIT0gbnVsbCA/IHEudmFjYyA6IHEudmVydGljYWxBY2N1cmFjeSk7CiAgICB2YXIgcnIgPSBmaW5pdGVOdW0ocS5yciAhPSBudWxsID8gcS5yciA6IHEucmFuZG9tUmFkaXVzKTsKICAgIGlmIChpc0Zpbml0ZShsb24pICYmIGlzRmluaXRlKGxhdCkpIHsKICAgICAgd3JpdGVLZXkoImxhdGl0dWRlIiwgU3RyaW5nKGxhdCkpOwogICAgICB3cml0ZUtleSgibG9uZ2l0dWRlIiwgU3RyaW5nKGxvbikpOwogICAgICBpZiAoaXNGaW5pdGUoYWx0KSkgd3JpdGVLZXkoImFsdGl0dWRlIiwgU3RyaW5nKE1hdGgucm91bmQoYWx0KSkpOwogICAgICBpZiAoaXNGaW5pdGUoaGFjYykpIHdyaXRlS2V5KCJob3Jpem9udGFsQWNjdXJhY3kiLCBTdHJpbmcoTWF0aC5yb3VuZChoYWNjKSkpOwogICAgICBpZiAoaXNGaW5pdGUodmFjYykpIHdyaXRlS2V5KCJ2ZXJ0aWNhbEFjY3VyYWN5IiwgU3RyaW5nKE1hdGgucm91bmQodmFjYykpKTsKICAgICAgaWYgKGlzRmluaXRlKHJyKSkgd3JpdGVLZXkoInJhbmRvbVJhZGl1cyIsIFN0cmluZyhNYXRoLm1heCgwLCBNYXRoLnJvdW5kKHJyKSkpKTsKICAgICAgd3JpdGVLZXkoImVuYWJsZWQiLCAidHJ1ZSIpOwogICAgICByZXN1bHQgPSB7IHN1Y2Nlc3M6IHRydWUsIGxhdGl0dWRlOiBsYXQsIGxvbmdpdHVkZTogbG9uIH07CiAgICAgIGlmIChpc0Zpbml0ZShhbHQpKSByZXN1bHQuYWx0aXR1ZGUgPSBNYXRoLnJvdW5kKGFsdCk7CiAgICAgIGlmIChpc0Zpbml0ZShoYWNjKSkgcmVzdWx0Lmhvcml6b250YWxBY2N1cmFjeSA9IE1hdGgucm91bmQoaGFjYyk7CiAgICAgIGlmIChpc0Zpbml0ZSh2YWNjKSkgcmVzdWx0LnZlcnRpY2FsQWNjdXJhY3kgPSBNYXRoLnJvdW5kKHZhY2MpOwogICAgICBpZiAoaXNGaW5pdGUocnIpKSByZXN1bHQucmFuZG9tUmFkaXVzID0gTWF0aC5tYXgoMCwgTWF0aC5yb3VuZChycikpOwogICAgfSBlbHNlIHsKICAgICAgcmVzdWx0ID0geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6ICJtaXNzaW5nIGxhdC9sb24gcGFyYW1ldGVycyIgfTsKICAgIH0KICB9CgogIHZhciBoZWFkZXJzID0gewogICAgIkNvbnRlbnQtVHlwZSI6ICJhcHBsaWNhdGlvbi9qc29uIiwKICAgICJBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4iOiAiKiIsCiAgICAiQWNjZXNzLUNvbnRyb2wtQWxsb3ctTWV0aG9kcyI6ICJHRVQsIE9QVElPTlMiCiAgfTsKICB2YXIgYm9keSA9IEpTT04uc3RyaW5naWZ5KHJlc3VsdCk7CgogIGlmIChpc1F1YW5YKSB7ICRkb25lKHsgc3RhdHVzOiAiSFRUUC8xLjEgMjAwIE9LIiwgaGVhZGVyczogaGVhZGVycywgYm9keTogYm9keSB9KTsgfQogIGVsc2UgeyAkZG9uZSh7IHJlc3BvbnNlOiB7IHN0YXR1czogMjAwLCBoZWFkZXJzOiBoZWFkZXJzLCBib2R5OiBib2R5IH0gfSk7IH0KfSkoKTsK";
const LOCATION_SPOOFER_QX_B64 = "LyoKICogUVgg55qEICRyZXNwb25zZS5ib2R5IOe1pueahOaYryBiYXNlNjQg5a2X5Liy77yI5LiN5pivIFVpbnQ4QXJyYXnvvInvvIwKICog5omA5Lul6YCZ54mI5aSa5LqG5LiA5q2lIGJhc2U2NCDihpIgYnl0ZXMg55qE6L2J5o+b77yM5YW25LuW6YKP6Lyv5ZKM5Li754mI5LiA6Ie044CCCiAqLwooZnVuY3Rpb24gKCkgewogICJ1c2Ugc3RyaWN0IjsKCiAgdmFyIERFRkFVTFRfQ09ORklHID0gewogICAgZW5hYmxlZDogZmFsc2UsCiAgICBsYXRpdHVkZTogMzcuMzM0OSwKICAgIGxvbmdpdHVkZTogLTEyMi4wMDkwMiwKICAgIGhvcml6b250YWxBY2N1cmFjeTogMzksCiAgICB2ZXJ0aWNhbEFjY3VyYWN5OiAxMDAwLAogICAgcmFuZG9tUmFkaXVzOiAwLAogICAgYWx0aXR1ZGU6IDUzMCwKICAgIHVua25vd25WYWx1ZTQ6IDMsCiAgICBtb3Rpb25BY3Rpdml0eVR5cGU6IDYzLAogICAgbW90aW9uQWN0aXZpdHlDb25maWRlbmNlOiA0NjcsCiAgICBmYWlsT3BlbjogdHJ1ZSwKICAgIGRlYnVnOiBmYWxzZQogIH07CgogIHZhciBBUFBMRV9XTE9DX1BSRUZJWCA9IG5ldyBVaW50OEFycmF5KFsweDAwLCAweDAxLCAweDAwLCAweDAwLCAweDAwLCAweDAxLCAweDAwLCAweDAwXSk7CiAgdmFyIEFQUExFX1dMT0NfTUFSS0VSID0gbmV3IFVpbnQ4QXJyYXkoWzB4MDAsIDB4MDAsIDB4MDAsIDB4MDEsIDB4MDAsIDB4MDBdKTsKICB2YXIgUk9PVF9EUk9QX0ZJRUxEUyA9IHsgMzogdHJ1ZSwgNDogdHJ1ZSwgMzM6IHRydWUgfTsKICB2YXIgQ0VMTF9SRVNQT05TRV9GSUVMRFMgPSB7IDIyOiB0cnVlLCAyNDogdHJ1ZSB9OwogIHZhciBMT0NBVElPTl9SRVBMQUNFRF9GSUVMRFMgPSB7IDE6IHRydWUsIDI6IHRydWUsIDM6IHRydWUsIDQ6IHRydWUsIDU6IHRydWUsIDY6IHRydWUsIDExOiB0cnVlLCAxMjogdHJ1ZSB9OwoKICBmdW5jdGlvbiBjb25jYXRCeXRlcyhwYXJ0cykgewogICAgdmFyIHRvdGFsID0gMCwgaTsKICAgIGZvciAoaSA9IDA7IGkgPCBwYXJ0cy5sZW5ndGg7IGkrKykgdG90YWwgKz0gcGFydHNbaV0ubGVuZ3RoOwogICAgdmFyIG91dCA9IG5ldyBVaW50OEFycmF5KHRvdGFsKSwgb2Zmc2V0ID0gMDsKICAgIGZvciAoaSA9IDA7IGkgPCBwYXJ0cy5sZW5ndGg7IGkrKykgeyBvdXQuc2V0KHBhcnRzW2ldLCBvZmZzZXQpOyBvZmZzZXQgKz0gcGFydHNbaV0ubGVuZ3RoOyB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgZnVuY3Rpb24gZmluZEJ5dGVzKGJ5dGVzLCBtYXJrZXIpIHsKICAgIGlmICghYnl0ZXMgfHwgIW1hcmtlciB8fCBtYXJrZXIubGVuZ3RoID09PSAwKSByZXR1cm4gLTE7CiAgICBmb3IgKHZhciBpID0gMDsgaSA8PSBieXRlcy5sZW5ndGggLSBtYXJrZXIubGVuZ3RoOyBpKyspIHsKICAgICAgdmFyIG9rID0gdHJ1ZTsKICAgICAgZm9yICh2YXIgaiA9IDA7IGogPCBtYXJrZXIubGVuZ3RoOyBqKyspIHsgaWYgKGJ5dGVzW2kgKyBqXSAhPT0gbWFya2VyW2pdKSB7IG9rID0gZmFsc2U7IGJyZWFrOyB9IH0KICAgICAgaWYgKG9rKSByZXR1cm4gaTsKICAgIH0KICAgIHJldHVybiAtMTsKICB9CgogIGZ1bmN0aW9uIGhleFByZXZpZXcoYnl0ZXMsIGxpbWl0KSB7CiAgICBpZiAoIWJ5dGVzKSByZXR1cm4gIjxub25lPiI7CiAgICB2YXIgb3V0ID0gW10sIG1heCA9IE1hdGgubWluKGJ5dGVzLmxlbmd0aCwgbGltaXQgfHwgMTYpOwogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBtYXg7IGkrKykgb3V0LnB1c2goKCIwIiArIGJ5dGVzW2ldLnRvU3RyaW5nKDE2KSkuc2xpY2UoLTIpKTsKICAgIHJldHVybiBvdXQuam9pbigiIik7CiAgfQoKICBmdW5jdGlvbiBiYXNlNjRUb0J5dGVzKGI2NCkgewogICAgdmFyIGFscGhhYmV0ID0gIkFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg5Ky8iOwogICAgdmFyIGxvb2t1cCA9IHt9LCBpOwogICAgZm9yIChpID0gMDsgaSA8IGFscGhhYmV0Lmxlbmd0aDsgaSsrKSBsb29rdXBbYWxwaGFiZXRbaV1dID0gaTsKICAgIGI2NCA9IGI2NC5yZXBsYWNlKC9bXkEtWmEtejAtOVwrXC9dL2csICIiKTsKICAgIHZhciBsZW4gPSBiNjQubGVuZ3RoLCBvdXQgPSBbXSwgcGFkZGluZyA9IDA7CiAgICBpZiAobGVuID4gMCAmJiBiNjRbbGVuIC0gMV0gPT09ICI9IikgcGFkZGluZysrOwogICAgaWYgKGxlbiA+IDEgJiYgYjY0W2xlbiAtIDJdID09PSAiPSIpIHBhZGRpbmcrKzsKICAgIHZhciBidWZMZW4gPSAobGVuIC8gNCkgKiAzIC0gcGFkZGluZzsKICAgIHZhciBidWYgPSBuZXcgVWludDhBcnJheShidWZMZW4pLCBwb3MgPSAwOwogICAgZm9yIChpID0gMDsgaSA8IGxlbjsgaSArPSA0KSB7CiAgICAgIHZhciBlbmMxID0gbG9va3VwW2I2NFtpXV0sIGVuYzIgPSBsb29rdXBbYjY0W2kgKyAxXV0sIGVuYzMgPSBsb29rdXBbYjY0W2kgKyAyXV0sIGVuYzQgPSBsb29rdXBbYjY0W2kgKyAzXV07CiAgICAgIHZhciBjaHIxID0gKGVuYzEgPDwgMikgfCAoZW5jMiA+PiA0KTsKICAgICAgdmFyIGNocjIgPSAoKGVuYzIgJiAxNSkgPDwgNCkgfCAoZW5jMyA+PiAyKTsKICAgICAgdmFyIGNocjMgPSAoKGVuYzMgJiAzKSA8PCA2KSB8IGVuYzQ7CiAgICAgIGJ1Zltwb3MrK10gPSBjaHIxOwogICAgICBpZiAoZW5jMyAhPT0gNjQpIGJ1Zltwb3MrK10gPSBjaHIyOwogICAgICBpZiAoZW5jNCAhPT0gNjQpIGJ1Zltwb3MrK10gPSBjaHIzOwogICAgfQogICAgcmV0dXJuIGJ1ZjsKICB9CgogIGZ1bmN0aW9uIGJ5dGVzVG9CYXNlNjQoYnl0ZXMpIHsKICAgIHZhciBhbHBoYWJldCA9ICJBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWmFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6MDEyMzQ1Njc4OSsvIjsKICAgIHZhciBvdXQgPSAiIjsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgYnl0ZXMubGVuZ3RoOyBpICs9IDMpIHsKICAgICAgdmFyIGIwID0gYnl0ZXNbaV0sIGIxID0gaSArIDEgPCBieXRlcy5sZW5ndGggPyBieXRlc1tpICsgMV0gOiAwLCBiMiA9IGkgKyAyIDwgYnl0ZXMubGVuZ3RoID8gYnl0ZXNbaSArIDJdIDogMDsKICAgICAgdmFyIHRyaXBsZSA9IChiMCA8PCAxNikgfCAoYjEgPDwgOCkgfCBiMjsKICAgICAgb3V0ICs9IGFscGhhYmV0Wyh0cmlwbGUgPj4gMTgpICYgMHgzZl0gKyBhbHBoYWJldFsodHJpcGxlID4+IDEyKSAmIDB4M2ZdOwogICAgICBvdXQgKz0gaSArIDEgPCBieXRlcy5sZW5ndGggPyBhbHBoYWJldFsodHJpcGxlID4+IDYpICYgMHgzZl0gOiAiPSI7CiAgICAgIG91dCArPSBpICsgMiA8IGJ5dGVzLmxlbmd0aCA/IGFscGhhYmV0W3RyaXBsZSAmIDB4M2ZdIDogIj0iOwogICAgfQogICAgcmV0dXJuIG91dDsKICB9CgogIGZ1bmN0aW9uIGVuY29kZVZhcmludFVuc2lnbmVkKHZhbHVlKSB7CiAgICB2YXIgdiA9IHR5cGVvZiB2YWx1ZSA9PT0gImJpZ2ludCIgPyB2YWx1ZSA6IEJpZ0ludCh2YWx1ZSk7CiAgICBpZiAodiA8IDBuKSB0aHJvdyBuZXcgRXJyb3IoIm5lZ2F0aXZlIHVuc2lnbmVkIHZhcmludCIpOwogICAgdmFyIG91dCA9IFtdOwogICAgd2hpbGUgKHYgPj0gMHg4MG4pIHsgb3V0LnB1c2goTnVtYmVyKCh2ICYgMHg3Zm4pIHwgMHg4MG4pKTsgdiA+Pj0gN247IH0KICAgIG91dC5wdXNoKE51bWJlcih2KSk7CiAgICByZXR1cm4gbmV3IFVpbnQ4QXJyYXkob3V0KTsKICB9CgogIGZ1bmN0aW9uIGVuY29kZVZhcmludFNpZ25lZEludDY0KHZhbHVlKSB7CiAgICB2YXIgdiA9IHR5cGVvZiB2YWx1ZSA9PT0gImJpZ2ludCIgPyB2YWx1ZSA6IEJpZ0ludChNYXRoLnRydW5jKHZhbHVlKSk7CiAgICBpZiAodiA8IDBuKSB2ID0gQmlnSW50LmFzVWludE4oNjQsIHYpOwogICAgcmV0dXJuIGVuY29kZVZhcmludFVuc2lnbmVkKHYpOwogIH0KCiAgZnVuY3Rpb24gZGVjb2RlVmFyaW50KGJ5dGVzLCBvZmZzZXQpIHsKICAgIHZhciByZXN1bHQgPSAwbiwgc2hpZnQgPSAwbiwgY3VycmVudCA9IG9mZnNldDsKICAgIHdoaWxlIChjdXJyZW50IDwgYnl0ZXMubGVuZ3RoKSB7CiAgICAgIHZhciBiID0gYnl0ZXNbY3VycmVudF07IGN1cnJlbnQgKz0gMTsKICAgICAgcmVzdWx0IHw9IEJpZ0ludChiICYgMHg3ZikgPDwgc2hpZnQ7CiAgICAgIGlmICgoYiAmIDB4ODApID09PSAwKSByZXR1cm4geyB2YWx1ZTogcmVzdWx0LCBvZmZzZXQ6IGN1cnJlbnQgfTsKICAgICAgc2hpZnQgKz0gN247CiAgICAgIGlmIChzaGlmdCA+IDcwbikgdGhyb3cgbmV3IEVycm9yKCJ2YXJpbnQgdG9vIGxvbmciKTsKICAgIH0KICAgIHRocm93IG5ldyBFcnJvcigidW50ZXJtaW5hdGVkIHZhcmludCIpOwogIH0KCiAgZnVuY3Rpb24gbWFrZUtleShmaWVsZE51bWJlciwgd2lyZVR5cGUpIHsgcmV0dXJuIGVuY29kZVZhcmludFVuc2lnbmVkKChCaWdJbnQoZmllbGROdW1iZXIpIDw8IDNuKSB8IEJpZ0ludCh3aXJlVHlwZSkpOyB9CiAgZnVuY3Rpb24gbWFrZVZhcmludEZpZWxkKGZpZWxkTnVtYmVyLCB2YWx1ZSkgeyByZXR1cm4gY29uY2F0Qnl0ZXMoW21ha2VLZXkoZmllbGROdW1iZXIsIDApLCBlbmNvZGVWYXJpbnRTaWduZWRJbnQ2NCh2YWx1ZSldKTsgfQogIGZ1bmN0aW9uIG1ha2VMZW5ndGhEZWxpbWl0ZWRGaWVsZChmaWVsZE51bWJlciwgcGF5bG9hZCkgeyByZXR1cm4gY29uY2F0Qnl0ZXMoW21ha2VLZXkoZmllbGROdW1iZXIsIDIpLCBlbmNvZGVWYXJpbnRVbnNpZ25lZChwYXlsb2FkLmxlbmd0aCksIHBheWxvYWRdKTsgfQoKICBmdW5jdGlvbiBwYXJzZUZpZWxkcyhieXRlcykgewogICAgdmFyIGZpZWxkcyA9IFtdLCBvZmZzZXQgPSAwOwogICAgd2hpbGUgKG9mZnNldCA8IGJ5dGVzLmxlbmd0aCkgewogICAgICB2YXIga2V5U3RhcnQgPSBvZmZzZXQ7CiAgICAgIHZhciBrZXkgPSBkZWNvZGVWYXJpbnQoYnl0ZXMsIG9mZnNldCk7CiAgICAgIG9mZnNldCA9IGtleS5vZmZzZXQ7CiAgICAgIHZhciBmaWVsZE51bWJlciA9IE51bWJlcihrZXkudmFsdWUgPj4gM24pLCB3aXJlVHlwZSA9IE51bWJlcihrZXkudmFsdWUgJiAweDduKTsKICAgICAgaWYgKGZpZWxkTnVtYmVyID09PSAwKSB0aHJvdyBuZXcgRXJyb3IoInByb3RvYnVmIGZpZWxkIG51bWJlciAwIik7CiAgICAgIHZhciB2YWx1ZVN0YXJ0ID0gb2Zmc2V0LCB2YWx1ZUVuZDsKICAgICAgaWYgKHdpcmVUeXBlID09PSAwKSB7IHZhbHVlRW5kID0gZGVjb2RlVmFyaW50KGJ5dGVzLCBvZmZzZXQpLm9mZnNldDsgfQogICAgICBlbHNlIGlmICh3aXJlVHlwZSA9PT0gMSkgeyB2YWx1ZUVuZCA9IG9mZnNldCArIDg7IH0KICAgICAgZWxzZSBpZiAod2lyZVR5cGUgPT09IDIpIHsgdmFyIGxlbkluZm8gPSBkZWNvZGVWYXJpbnQoYnl0ZXMsIG9mZnNldCk7IHZhbHVlU3RhcnQgPSBsZW5JbmZvLm9mZnNldDsgdmFsdWVFbmQgPSB2YWx1ZVN0YXJ0ICsgTnVtYmVyKGxlbkluZm8udmFsdWUpOyB9CiAgICAgIGVsc2UgaWYgKHdpcmVUeXBlID09PSA1KSB7IHZhbHVlRW5kID0gb2Zmc2V0ICsgNDsgfQogICAgICBlbHNlIHRocm93IG5ldyBFcnJvcigidW5zdXBwb3J0ZWQgd2lyZSB0eXBlOiAiICsgd2lyZVR5cGUpOwogICAgICBpZiAodmFsdWVFbmQgPiBieXRlcy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcigiZmllbGQgZXhjZWVkcyBidWZmZXIiKTsKICAgICAgZmllbGRzLnB1c2goeyBmaWVsZE51bWJlcjogZmllbGROdW1iZXIsIHdpcmVUeXBlOiB3aXJlVHlwZSwga2V5U3RhcnQ6IGtleVN0YXJ0LCB2YWx1ZVN0YXJ0OiB2YWx1ZVN0YXJ0LCB2YWx1ZUVuZDogdmFsdWVFbmQsIHJhdzogYnl0ZXMuc2xpY2Uoa2V5U3RhcnQsIHZhbHVlRW5kKSwgdmFsdWVCeXRlczogYnl0ZXMuc2xpY2UodmFsdWVTdGFydCwgdmFsdWVFbmQpIH0pOwogICAgICBvZmZzZXQgPSB2YWx1ZUVuZDsKICAgIH0KICAgIHJldHVybiBmaWVsZHM7CiAgfQoKICBmdW5jdGlvbiBmaXJzdEZpZWxkQnlOdW1iZXIoZmllbGRzLCBmaWVsZE51bWJlcikgewogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBmaWVsZHMubGVuZ3RoOyBpKyspIHsgaWYgKGZpZWxkc1tpXS5maWVsZE51bWJlciA9PT0gZmllbGROdW1iZXIpIHJldHVybiBmaWVsZHNbaV07IH0KICAgIHJldHVybiBudWxsOwogIH0KCiAgZnVuY3Rpb24gc2lnbmVkVmFyaW50RmllbGRWYWx1ZShmaWVsZCkgewogICAgaWYgKCFmaWVsZCB8fCBmaWVsZC53aXJlVHlwZSAhPT0gMCkgcmV0dXJuIG51bGw7CiAgICByZXR1cm4gQmlnSW50LmFzSW50Tig2NCwgZGVjb2RlVmFyaW50KGZpZWxkLnZhbHVlQnl0ZXMsIDApLnZhbHVlKTsKICB9CgogIGZ1bmN0aW9uIHRyeVBhcnNlRmllbGRzKGJ5dGVzKSB7CiAgICB0cnkgeyBpZiAoIWJ5dGVzIHx8IGJ5dGVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7IHZhciBmID0gcGFyc2VGaWVsZHMoYnl0ZXMpOyByZXR1cm4gZi5sZW5ndGggPiAwID8gZiA6IG51bGw7IH0KICAgIGNhdGNoIChlKSB7IHJldHVybiBudWxsOyB9CiAgfQoKICBmdW5jdGlvbiBpc0NlbGxSZXNwb25zZUZpZWxkKGZpZWxkTnVtYmVyKSB7IHJldHVybiBDRUxMX1JFU1BPTlNFX0ZJRUxEU1tmaWVsZE51bWJlcl0gPT09IHRydWU7IH0KCiAgZnVuY3Rpb24gcmVhZFVJbnQxNkJFKGJ5dGVzLCBvZmZzZXQpIHsgcmV0dXJuIChieXRlc1tvZmZzZXRdIDw8IDgpIHwgYnl0ZXNbb2Zmc2V0ICsgMV07IH0KICBmdW5jdGlvbiByZWFkVUludDMyQkUoYnl0ZXMsIG9mZnNldCkgeyByZXR1cm4gKChieXRlc1tvZmZzZXRdICogMHgxMDAwMDAwKSArICgoYnl0ZXNbb2Zmc2V0ICsgMV0gPDwgMTYpIHwgKGJ5dGVzW29mZnNldCArIDJdIDw8IDgpIHwgYnl0ZXNbb2Zmc2V0ICsgM10pKSA+Pj4gMDsgfQogIGZ1bmN0aW9uIHdyaXRlVUludDE2QkUodmFsdWUpIHsgcmV0dXJuIG5ldyBVaW50OEFycmF5KFsodmFsdWUgPj4gOCkgJiAweGZmLCB2YWx1ZSAmIDB4ZmZdKTsgfQogIGZ1bmN0aW9uIHdyaXRlVUludDMyQkUodmFsdWUpIHsgcmV0dXJuIG5ldyBVaW50OEFycmF5KFsodmFsdWUgPj4+IDI0KSAmIDB4ZmYsICh2YWx1ZSA+Pj4gMTYpICYgMHhmZiwgKHZhbHVlID4+PiA4KSAmIDB4ZmYsIHZhbHVlICYgMHhmZl0pOyB9CgogIGZ1bmN0aW9uIGFzY2lpQnl0ZXModmFsdWUpIHsKICAgIHZhciBvdXQgPSBuZXcgVWludDhBcnJheSh2YWx1ZS5sZW5ndGgpOwogICAgZm9yICh2YXIgaSA9IDA7IGkgPCB2YWx1ZS5sZW5ndGg7IGkrKykgb3V0W2ldID0gdmFsdWUuY2hhckNvZGVBdChpKSAmIDB4N2Y7CiAgICByZXR1cm4gb3V0OwogIH0KCiAgZnVuY3Rpb24gcmVhZFBhc2NhbFN0cmluZyhieXRlcywgc3RhdGUpIHsKICAgIHZhciBsZW5ndGggPSByZWFkVUludDE2QkUoYnl0ZXMsIHN0YXRlLm9mZnNldCk7IHN0YXRlLm9mZnNldCArPSAyOwogICAgdmFyIGNoYXJzID0gW107CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbmd0aDsgaSsrKSBjaGFycy5wdXNoKFN0cmluZy5mcm9tQ2hhckNvZGUoYnl0ZXNbc3RhdGUub2Zmc2V0ICsgaV0pKTsKICAgIHN0YXRlLm9mZnNldCArPSBsZW5ndGg7CiAgICByZXR1cm4gY2hhcnMuam9pbigiIik7CiAgfQoKICBmdW5jdGlvbiB3cml0ZVBhc2NhbFN0cmluZyh2YWx1ZSkgeyByZXR1cm4gY29uY2F0Qnl0ZXMoW3dyaXRlVUludDE2QkUodmFsdWUubGVuZ3RoKSwgYXNjaWlCeXRlcyh2YWx1ZSldKTsgfQoKICBmdW5jdGlvbiBwYXJzZUFycGMoYnl0ZXMpIHsKICAgIHZhciBzdGF0ZSA9IHsgb2Zmc2V0OiAwIH07CiAgICB2YXIgdmVyc2lvbiA9IHJlYWRVSW50MTZCRShieXRlcywgc3RhdGUub2Zmc2V0KTsgc3RhdGUub2Zmc2V0ICs9IDI7CiAgICB2YXIgbG9jYWxlID0gcmVhZFBhc2NhbFN0cmluZyhieXRlcywgc3RhdGUpOwogICAgdmFyIGFwcElkZW50aWZpZXIgPSByZWFkUGFzY2FsU3RyaW5nKGJ5dGVzLCBzdGF0ZSk7CiAgICB2YXIgb3NWZXJzaW9uID0gcmVhZFBhc2NhbFN0cmluZyhieXRlcywgc3RhdGUpOwogICAgdmFyIGZ1bmN0aW9uSWQgPSByZWFkVUludDMyQkUoYnl0ZXMsIHN0YXRlLm9mZnNldCk7IHN0YXRlLm9mZnNldCArPSA0OwogICAgdmFyIHBheWxvYWRMZW5ndGggPSByZWFkVUludDMyQkUoYnl0ZXMsIHN0YXRlLm9mZnNldCk7IHN0YXRlLm9mZnNldCArPSA0OwogICAgaWYgKHN0YXRlLm9mZnNldCArIHBheWxvYWRMZW5ndGggPiBieXRlcy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcigiQVJQQyBwYXlsb2FkIGV4Y2VlZHMgYnVmZmVyIik7CiAgICByZXR1cm4geyB2ZXJzaW9uOiB2ZXJzaW9uLCBsb2NhbGU6IGxvY2FsZSwgYXBwSWRlbnRpZmllcjogYXBwSWRlbnRpZmllciwgb3NWZXJzaW9uOiBvc1ZlcnNpb24sIGZ1bmN0aW9uSWQ6IGZ1bmN0aW9uSWQsIHBheWxvYWQ6IGJ5dGVzLnNsaWNlKHN0YXRlLm9mZnNldCwgc3RhdGUub2Zmc2V0ICsgcGF5bG9hZExlbmd0aCkgfTsKICB9CgogIGZ1bmN0aW9uIHNlcmlhbGl6ZUFycGMoYXJwYykgewogICAgcmV0dXJuIGNvbmNhdEJ5dGVzKFt3cml0ZVVJbnQxNkJFKGFycGMudmVyc2lvbiksIHdyaXRlUGFzY2FsU3RyaW5nKGFycGMubG9jYWxlKSwgd3JpdGVQYXNjYWxTdHJpbmcoYXJwYy5hcHBJZGVudGlmaWVyKSwgd3JpdGVQYXNjYWxTdHJpbmcoYXJwYy5vc1ZlcnNpb24pLCB3cml0ZVVJbnQzMkJFKGFycGMuZnVuY3Rpb25JZCksIHdyaXRlVUludDMyQkUoYXJwYy5wYXlsb2FkLmxlbmd0aCksIGFycGMucGF5bG9hZF0pOwogIH0KCiAgZnVuY3Rpb24gY29vcmRUb0ludCh2YWx1ZSkgeyByZXR1cm4gTWF0aC50cnVuYyhOdW1iZXIodmFsdWUpICogMTAwMDAwMDAwKTsgfQoKICBmdW5jdGlvbiBwYXRjaExvY2F0aW9uKGxvY2F0aW9uUGF5bG9hZCwgY29uZmlnKSB7CiAgICB2YXIgcGFydHMgPSBbXSwgZmllbGRzID0gbG9jYXRpb25QYXlsb2FkLmxlbmd0aCA/IHBhcnNlRmllbGRzKGxvY2F0aW9uUGF5bG9hZCkgOiBbXTsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZmllbGRzLmxlbmd0aDsgaSsrKSB7IGlmICghTE9DQVRJT05fUkVQTEFDRURfRklFTERTW2ZpZWxkc1tpXS5maWVsZE51bWJlcl0pIHBhcnRzLnB1c2goZmllbGRzW2ldLnJhdyk7IH0KICAgIHBhcnRzLnB1c2gobWFrZVZhcmludEZpZWxkKDEsIGNvb3JkVG9JbnQoY29uZmlnLmxhdGl0dWRlKSkpOwogICAgcGFydHMucHVzaChtYWtlVmFyaW50RmllbGQoMiwgY29vcmRUb0ludChjb25maWcubG9uZ2l0dWRlKSkpOwogICAgcGFydHMucHVzaChtYWtlVmFyaW50RmllbGQoMywgY29uZmlnLmhvcml6b250YWxBY2N1cmFjeSkpOwogICAgcGFydHMucHVzaChtYWtlVmFyaW50RmllbGQoNCwgY29uZmlnLnVua25vd25WYWx1ZTQpKTsKICAgIHBhcnRzLnB1c2gobWFrZVZhcmludEZpZWxkKDUsIGNvbmZpZy5hbHRpdHVkZSkpOwogICAgcGFydHMucHVzaChtYWtlVmFyaW50RmllbGQoNiwgY29uZmlnLnZlcnRpY2FsQWNjdXJhY3kpKTsKICAgIHBhcnRzLnB1c2gobWFrZVZhcmludEZpZWxkKDExLCBjb25maWcubW90aW9uQWN0aXZpdHlUeXBlKSk7CiAgICBwYXJ0cy5wdXNoKG1ha2VWYXJpbnRGaWVsZCgxMiwgY29uZmlnLm1vdGlvbkFjdGl2aXR5Q29uZmlkZW5jZSkpOwogICAgcmV0dXJuIGNvbmNhdEJ5dGVzKHBhcnRzKTsKICB9CgogIGZ1bmN0aW9uIHBhdGNoV2lmaURldmljZSh3aWZpUGF5bG9hZCwgY29uZmlnKSB7CiAgICB2YXIgZmllbGRzID0gcGFyc2VGaWVsZHMod2lmaVBheWxvYWQpLCBwYXJ0cyA9IFtdLCBwYXRjaGVkTG9jYXRpb24gPSBmYWxzZTsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZmllbGRzLmxlbmd0aDsgaSsrKSB7CiAgICAgIGlmIChmaWVsZHNbaV0uZmllbGROdW1iZXIgPT09IDIgJiYgZmllbGRzW2ldLndpcmVUeXBlID09PSAyKSB7CiAgICAgICAgcGFydHMucHVzaChtYWtlTGVuZ3RoRGVsaW1pdGVkRmllbGQoMiwgcGF0Y2hMb2NhdGlvbihmaWVsZHNbaV0udmFsdWVCeXRlcywgY29uZmlnKSkpOyBwYXRjaGVkTG9jYXRpb24gPSB0cnVlOwogICAgICB9IGVsc2UgcGFydHMucHVzaChmaWVsZHNbaV0ucmF3KTsKICAgIH0KICAgIGlmICghcGF0Y2hlZExvY2F0aW9uKSBwYXJ0cy5wdXNoKG1ha2VMZW5ndGhEZWxpbWl0ZWRGaWVsZCgyLCBwYXRjaExvY2F0aW9uKG5ldyBVaW50OEFycmF5KFtdKSwgY29uZmlnKSkpOwogICAgcmV0dXJuIGNvbmNhdEJ5dGVzKHBhcnRzKTsKICB9CgogIGZ1bmN0aW9uIHBhdGNoQ2VsbFRvd2VyKGNlbGxQYXlsb2FkLCBjb25maWcpIHsKICAgIHZhciBmaWVsZHMgPSBwYXJzZUZpZWxkcyhjZWxsUGF5bG9hZCksIHBhcnRzID0gW10sIHBhdGNoZWRMb2NhdGlvbiA9IGZhbHNlOwogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBmaWVsZHMubGVuZ3RoOyBpKyspIHsKICAgICAgaWYgKGZpZWxkc1tpXS5maWVsZE51bWJlciA9PT0gNSAmJiBmaWVsZHNbaV0ud2lyZVR5cGUgPT09IDIpIHsKICAgICAgICBwYXJ0cy5wdXNoKG1ha2VMZW5ndGhEZWxpbWl0ZWRGaWVsZCg1LCBwYXRjaExvY2F0aW9uKGZpZWxkc1tpXS52YWx1ZUJ5dGVzLCBjb25maWcpKSk7IHBhdGNoZWRMb2NhdGlvbiA9IHRydWU7CiAgICAgIH0gZWxzZSBwYXJ0cy5wdXNoKGZpZWxkc1tpXS5yYXcpOwogICAgfQogICAgaWYgKCFwYXRjaGVkTG9jYXRpb24pIHBhcnRzLnB1c2gobWFrZUxlbmd0aERlbGltaXRlZEZpZWxkKDUsIHBhdGNoTG9jYXRpb24obmV3IFVpbnQ4QXJyYXkoW10pLCBjb25maWcpKSk7CiAgICByZXR1cm4gY29uY2F0Qnl0ZXMocGFydHMpOwogIH0KCiAgZnVuY3Rpb24gcGF0Y2hBcHBsZVdMb2NQYXlsb2FkKHBheWxvYWQsIGNvbmZpZykgewogICAgdmFyIGZpZWxkcyA9IHBhcnNlRmllbGRzKHBheWxvYWQpLCBwYXJ0cyA9IFtdLCB3aWZpQ291bnQgPSAwLCBjZWxsQ291bnQgPSAwOwogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBmaWVsZHMubGVuZ3RoOyBpKyspIHsKICAgICAgdmFyIGZpZWxkID0gZmllbGRzW2ldOwogICAgICBpZiAoZmllbGQuZmllbGROdW1iZXIgPT09IDIgJiYgZmllbGQud2lyZVR5cGUgPT09IDIpIHsgcGFydHMucHVzaChtYWtlTGVuZ3RoRGVsaW1pdGVkRmllbGQoMiwgcGF0Y2hXaWZpRGV2aWNlKGZpZWxkLnZhbHVlQnl0ZXMsIGNvbmZpZykpKTsgd2lmaUNvdW50ICs9IDE7IH0KICAgICAgZWxzZSBpZiAoaXNDZWxsUmVzcG9uc2VGaWVsZChmaWVsZC5maWVsZE51bWJlcikgJiYgZmllbGQud2lyZVR5cGUgPT09IDIpIHsgcGFydHMucHVzaChtYWtlTGVuZ3RoRGVsaW1pdGVkRmllbGQoZmllbGQuZmllbGROdW1iZXIsIHBhdGNoQ2VsbFRvd2VyKGZpZWxkLnZhbHVlQnl0ZXMsIGNvbmZpZykpKTsgY2VsbENvdW50ICs9IDE7IH0KICAgICAgZWxzZSBpZiAoIVJPT1RfRFJPUF9GSUVMRFNbZmllbGQuZmllbGROdW1iZXJdKSBwYXJ0cy5wdXNoKGZpZWxkLnJhdyk7CiAgICB9CiAgICByZXR1cm4geyBwYXlsb2FkOiBjb25jYXRCeXRlcyhwYXJ0cyksIHdpZmlDb3VudDogd2lmaUNvdW50LCBjZWxsQ291bnQ6IGNlbGxDb3VudCB9OwogIH0KCiAgZnVuY3Rpb24gZXh0cmFjdFByZWZpeGVkQXBwbGVXTG9jUGF5bG9hZChyZXNwb25zZUJ5dGVzKSB7CiAgICBpZiAoIXJlc3BvbnNlQnl0ZXMgfHwgcmVzcG9uc2VCeXRlcy5sZW5ndGggPCAxMCkgcmV0dXJuIG51bGw7CiAgICBpZiAocmVzcG9uc2VCeXRlc1swXSAhPT0gMHgwMCB8fCByZXNwb25zZUJ5dGVzWzFdICE9PSAweDAxKSByZXR1cm4gbnVsbDsKICAgIGlmIChyZXNwb25zZUJ5dGVzWzZdICE9PSAweDAwIHx8IHJlc3BvbnNlQnl0ZXNbN10gIT09IDB4MDApIHJldHVybiBudWxsOwogICAgdmFyIHBheWxvYWRMZW5ndGggPSByZWFkVUludDE2QkUocmVzcG9uc2VCeXRlcywgOCksIHBheWxvYWRPZmZzZXQgPSAxMDsKICAgIGlmIChwYXlsb2FkTGVuZ3RoIDw9IDAgfHwgcGF5bG9hZE9mZnNldCArIHBheWxvYWRMZW5ndGggPiByZXNwb25zZUJ5dGVzLmxlbmd0aCkgcmV0dXJuIG51bGw7CiAgICB2YXIgcGF5bG9hZCA9IHJlc3BvbnNlQnl0ZXMuc2xpY2UocGF5bG9hZE9mZnNldCwgcGF5bG9hZE9mZnNldCArIHBheWxvYWRMZW5ndGgpOwogICAgaWYgKHRyeVBhcnNlRmllbGRzKHBheWxvYWQpID09PSBudWxsKSByZXR1cm4gbnVsbDsKICAgIHJldHVybiB7IGtpbmQ6ICJzeW50aGV0aWMiLCBwYXlsb2FkOiBwYXlsb2FkLCBwcmVmaXg6IHJlc3BvbnNlQnl0ZXMuc2xpY2UoMCwgOCksIHN1ZmZpeDogcmVzcG9uc2VCeXRlcy5zbGljZShwYXlsb2FkT2Zmc2V0ICsgcGF5bG9hZExlbmd0aCkgfTsKICB9CgogIGZ1bmN0aW9uIGV4dHJhY3RBcHBsZVdMb2NQYXlsb2FkKHJlc3BvbnNlQnl0ZXMpIHsKICAgIGlmICghcmVzcG9uc2VCeXRlcyB8fCByZXNwb25zZUJ5dGVzLmxlbmd0aCA8IDIpIHRocm93IG5ldyBFcnJvcigiQXBwbGUgV0xvYyByZXNwb25zZSB0b28gc2hvcnQiKTsKICAgIHZhciBwcmVmaXhlZCA9IGV4dHJhY3RQcmVmaXhlZEFwcGxlV0xvY1BheWxvYWQocmVzcG9uc2VCeXRlcyk7CiAgICBpZiAocHJlZml4ZWQpIHJldHVybiBwcmVmaXhlZDsKICAgIHRyeSB7CiAgICAgIHZhciBhcnBjID0gcGFyc2VBcnBjKHJlc3BvbnNlQnl0ZXMpOwogICAgICBpZiAoYXJwYy5wYXlsb2FkLmxlbmd0aCA+IDAgJiYgdHJ5UGFyc2VGaWVsZHMoYXJwYy5wYXlsb2FkKSAhPT0gbnVsbCkgcmV0dXJuIHsga2luZDogImFycGMiLCBwYXlsb2FkOiBhcnBjLnBheWxvYWQsIGFycGM6IGFycGMgfTsKICAgIH0gY2F0Y2ggKGUpIHt9CiAgICB2YXIgbWFya2VySWR4ID0gZmluZEJ5dGVzKHJlc3BvbnNlQnl0ZXMsIEFQUExFX1dMT0NfTUFSS0VSKTsKICAgIGlmIChtYXJrZXJJZHggPj0gMCkgewogICAgICB2YXIgbGVuT2Zmc2V0ID0gbWFya2VySWR4ICsgQVBQTEVfV0xPQ19NQVJLRVIubGVuZ3RoOwogICAgICBpZiAobGVuT2Zmc2V0ICsgMiA8PSByZXNwb25zZUJ5dGVzLmxlbmd0aCkgewogICAgICAgIHZhciByZWFsTGVuID0gcmVhZFVJbnQxNkJFKHJlc3BvbnNlQnl0ZXMsIGxlbk9mZnNldCksIHJlYWxQYXlsb2FkT2Zmc2V0ID0gbGVuT2Zmc2V0ICsgMjsKICAgICAgICBpZiAocmVhbExlbiA+IDAgJiYgcmVhbFBheWxvYWRPZmZzZXQgKyByZWFsTGVuIDw9IHJlc3BvbnNlQnl0ZXMubGVuZ3RoKSB7CiAgICAgICAgICB2YXIgY2FuZGlkYXRlUGF5bG9hZCA9IHJlc3BvbnNlQnl0ZXMuc2xpY2UocmVhbFBheWxvYWRPZmZzZXQsIHJlYWxQYXlsb2FkT2Zmc2V0ICsgcmVhbExlbik7CiAgICAgICAgICBpZiAodHJ5UGFyc2VGaWVsZHMoY2FuZGlkYXRlUGF5bG9hZCkgIT09IG51bGwpIHJldHVybiB7IGtpbmQ6ICJtYXJrZXIiLCBwYXlsb2FkOiBjYW5kaWRhdGVQYXlsb2FkLCBwcmVmaXg6IHJlc3BvbnNlQnl0ZXMuc2xpY2UoMCwgbWFya2VySWR4KSwgbWFya2VyQW5kTGVuOiByZXNwb25zZUJ5dGVzLnNsaWNlKG1hcmtlcklkeCwgcmVhbFBheWxvYWRPZmZzZXQpLCBzdWZmaXg6IHJlc3BvbnNlQnl0ZXMuc2xpY2UocmVhbFBheWxvYWRPZmZzZXQgKyByZWFsTGVuKSB9OwogICAgICAgIH0KICAgICAgfQogICAgfQogICAgaWYgKHJlc3BvbnNlQnl0ZXMubGVuZ3RoID4gMCkgeyB2YXIgdGFnID0gcmVzcG9uc2VCeXRlc1swXTsgdmFyIGZuID0gdGFnID4+IDMsIHd0ID0gdGFnICYgMHg3OyBpZiAoZm4gPiAwICYmICh3dCA9PT0gMCB8fCB3dCA9PT0gMikpIHJldHVybiB7IGtpbmQ6ICJiYXJlIiwgcGF5bG9hZDogcmVzcG9uc2VCeXRlcyB9OyB9CiAgICB0aHJvdyBuZXcgRXJyb3IoIm1pc3NpbmcgQXBwbGUgV0xvYyByZXNwb25zZSBwcmVmaXgiKTsKICB9CgogIGZ1bmN0aW9uIGJ1aWxkQXBwbGVXTG9jUmVzcG9uc2UocGF5bG9hZCwgcHJlZml4KSB7CiAgICByZXR1cm4gY29uY2F0Qnl0ZXMoW3ByZWZpeCB8fCBBUFBMRV9XTE9DX1BSRUZJWCwgd3JpdGVVSW50MTZCRShwYXlsb2FkLmxlbmd0aCksIHBheWxvYWRdKTsKICB9CgogIGZ1bmN0aW9uIHNwb29mQXBwbGVSZXNwb25zZShyZXNwb25zZUJ5dGVzLCBjb25maWcpIHsKICAgIHZhciBleHRyYWN0aW9uID0gZXh0cmFjdEFwcGxlV0xvY1BheWxvYWQocmVzcG9uc2VCeXRlcyk7CiAgICB2YXIgcGF0Y2hlZCA9IHBhdGNoQXBwbGVXTG9jUGF5bG9hZChleHRyYWN0aW9uLnBheWxvYWQsIGNvbmZpZyk7CiAgICB2YXIgcmVzcG9uc2U7CiAgICBpZiAoZXh0cmFjdGlvbi5raW5kID09PSAiYXJwYyIpIHsKICAgICAgcmVzcG9uc2UgPSBzZXJpYWxpemVBcnBjKHsgdmVyc2lvbjogZXh0cmFjdGlvbi5hcnBjLnZlcnNpb24sIGxvY2FsZTogZXh0cmFjdGlvbi5hcnBjLmxvY2FsZSwgYXBwSWRlbnRpZmllcjogZXh0cmFjdGlvbi5hcnBjLmFwcElkZW50aWZpZXIsIG9zVmVyc2lvbjogZXh0cmFjdGlvbi5hcnBjLm9zVmVyc2lvbiwgZnVuY3Rpb25JZDogZXh0cmFjdGlvbi5hcnBjLmZ1bmN0aW9uSWQsIHBheWxvYWQ6IHBhdGNoZWQucGF5bG9hZCB9KTsKICAgIH0gZWxzZSBpZiAoZXh0cmFjdGlvbi5raW5kID09PSAibWFya2VyIikgewogICAgICB2YXIgbmV3TGVuQnl0ZXMgPSB3cml0ZVVJbnQxNkJFKHBhdGNoZWQucGF5bG9hZC5sZW5ndGgpOwogICAgICByZXNwb25zZSA9IGNvbmNhdEJ5dGVzKFtleHRyYWN0aW9uLnByZWZpeCwgZXh0cmFjdGlvbi5tYXJrZXJBbmRMZW4uc2xpY2UoMCwgQVBQTEVfV0xPQ19NQVJLRVIubGVuZ3RoKSwgbmV3TGVuQnl0ZXMsIHBhdGNoZWQucGF5bG9hZCwgZXh0cmFjdGlvbi5zdWZmaXhdKTsKICAgIH0gZWxzZSB7CiAgICAgIHJlc3BvbnNlID0gYnVpbGRBcHBsZVdMb2NSZXNwb25zZShwYXRjaGVkLnBheWxvYWQsIGV4dHJhY3Rpb24ucHJlZml4KTsKICAgIH0KICAgIHJldHVybiB7IHJlc3BvbnNlOiByZXNwb25zZSwgcGF5bG9hZDogcGF0Y2hlZC5wYXlsb2FkLCB3aWZpQ291bnQ6IHBhdGNoZWQud2lmaUNvdW50LCBjZWxsQ291bnQ6IHBhdGNoZWQuY2VsbENvdW50LCBraW5kOiBleHRyYWN0aW9uLmtpbmQgfTsKICB9CgogIGZ1bmN0aW9uIHBhdGNoZWRQYXlsb2FkU3VtbWFyeShwYXlsb2FkKSB7CiAgICB0cnkgewogICAgICB2YXIgcm9vdEZpZWxkcyA9IHBhcnNlRmllbGRzKHBheWxvYWQpLCBwYXJ0cyA9IFtdOwogICAgICB2YXIgd2lmaSA9IGZpcnN0RmllbGRCeU51bWJlcihyb290RmllbGRzLCAyKTsKICAgICAgaWYgKHdpZmkgJiYgd2lmaS53aXJlVHlwZSA9PT0gMikgewogICAgICAgIHZhciB3aWZpTG9jID0gZmlyc3RGaWVsZEJ5TnVtYmVyKHBhcnNlRmllbGRzKHdpZmkudmFsdWVCeXRlcyksIDIpOwogICAgICAgIHBhcnRzLnB1c2goImZpcnN0V2lmaT0iICsgKHdpZmlMb2MgPyAoTnVtYmVyKHNpZ25lZFZhcmludEZpZWxkVmFsdWUoZmlyc3RGaWVsZEJ5TnVtYmVyKHBhcnNlRmllbGRzKHdpZmlMb2MudmFsdWVCeXRlcyksIDEpKSkgLyAxMDAwMDAwMDApLnRvRml4ZWQoOCkgKyAiLCIgKyAoTnVtYmVyKHNpZ25lZFZhcmludEZpZWxkVmFsdWUoZmlyc3RGaWVsZEJ5TnVtYmVyKHBhcnNlRmllbGRzKHdpZmlMb2MudmFsdWVCeXRlcyksIDIpKSkgLyAxMDAwMDAwMDApLnRvRml4ZWQoOCkgOiAiPG1pc3Npbmc+IikpOwogICAgICB9CiAgICAgIHJldHVybiBwYXJ0cy5sZW5ndGggPyBwYXJ0cy5qb2luKCIsICIpIDogIm5vIGxvY2F0aW9uIGZpZWxkcyI7CiAgICB9IGNhdGNoIChlcnIpIHsgcmV0dXJuICJzdW1tYXJ5IGZhaWxlZDogIiArIGVyci5tZXNzYWdlOyB9CiAgfQoKICBmdW5jdGlvbiBub3JtYWxpemVDb25maWcoaW5wdXQpIHsKICAgIHZhciBjZmcgPSB7fSwga2V5OwogICAgZm9yIChrZXkgaW4gREVGQVVMVF9DT05GSUcpIHsgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChERUZBVUxUX0NPTkZJRywga2V5KSkgY2ZnW2tleV0gPSBERUZBVUxUX0NPTkZJR1trZXldOyB9CiAgICBpbnB1dCA9IGlucHV0IHx8IHt9OwogICAgZm9yIChrZXkgaW4gaW5wdXQpIHsgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChpbnB1dCwga2V5KSkgY2ZnW2tleV0gPSBpbnB1dFtrZXldOyB9CiAgICBjZmcuZW5hYmxlZCA9ICEoY2ZnLmVuYWJsZWQgPT09IGZhbHNlIHx8IGNmZy5lbmFibGVkID09PSAiZmFsc2UiIHx8IGNmZy5lbmFibGVkID09PSAiMCIgfHwgY2ZnLmVuYWJsZWQgPT09ICJvZmYiIHx8IGNmZy5lbmFibGVkID09PSAibm8iIHx8IGNmZy5lbmFibGVkID09PSAwKTsKICAgIGNmZy5sYXRpdHVkZSA9IE51bWJlcihjZmcubGF0aXR1ZGUpOyBjZmcubG9uZ2l0dWRlID0gTnVtYmVyKGNmZy5sb25naXR1ZGUpOwogICAgY2ZnLmhvcml6b250YWxBY2N1cmFjeSA9IE1hdGgudHJ1bmMoTnVtYmVyKGNmZy5ob3Jpem9udGFsQWNjdXJhY3kpKTsKICAgIGNmZy52ZXJ0aWNhbEFjY3VyYWN5ID0gTWF0aC50cnVuYyhOdW1iZXIoY2ZnLnZlcnRpY2FsQWNjdXJhY3kpKTsKICAgIGNmZy5hbHRpdHVkZSA9IE1hdGgudHJ1bmMoTnVtYmVyKGNmZy5hbHRpdHVkZSkpOwogICAgY2ZnLnVua25vd25WYWx1ZTQgPSBNYXRoLnRydW5jKE51bWJlcihjZmcudW5rbm93blZhbHVlNCkpOwogICAgY2ZnLm1vdGlvbkFjdGl2aXR5VHlwZSA9IE1hdGgudHJ1bmMoTnVtYmVyKGNmZy5tb3Rpb25BY3Rpdml0eVR5cGUpKTsKICAgIGNmZy5tb3Rpb25BY3Rpdml0eUNvbmZpZGVuY2UgPSBNYXRoLnRydW5jKE51bWJlcihjZmcubW90aW9uQWN0aXZpdHlDb25maWRlbmNlKSk7CiAgICBjZmcuZmFpbE9wZW4gPSBjZmcuZmFpbE9wZW4gIT09IGZhbHNlOwogICAgY2ZnLmRlYnVnID0gY2ZnLmRlYnVnID09PSB0cnVlIHx8IFN0cmluZyhjZmcuZGVidWcpLnRvTG93ZXJDYXNlKCkgPT09ICJ0cnVlIjsKICAgIGNmZy5yYW5kb21SYWRpdXMgPSBOdW1iZXIoY2ZnLnJhbmRvbVJhZGl1cyk7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShjZmcucmFuZG9tUmFkaXVzKSB8fCBjZmcucmFuZG9tUmFkaXVzIDwgMCkgY2ZnLnJhbmRvbVJhZGl1cyA9IDA7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShjZmcubGF0aXR1ZGUpIHx8IGNmZy5sYXRpdHVkZSA8IC05MCB8fCBjZmcubGF0aXR1ZGUgPiA5MCkgdGhyb3cgbmV3IEVycm9yKCJpbnZhbGlkIGxhdGl0dWRlIik7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShjZmcubG9uZ2l0dWRlKSB8fCBjZmcubG9uZ2l0dWRlIDwgLTE4MCB8fCBjZmcubG9uZ2l0dWRlID4gMTgwKSB0aHJvdyBuZXcgRXJyb3IoImludmFsaWQgbG9uZ2l0dWRlIik7CiAgICBpZiAoY2ZnLnJhbmRvbVJhZGl1cyA+IDApIHsKICAgICAgdmFyIGppdHRlcmVkID0gYXBwbHlSYW5kb21SYWRpdXMoY2ZnLmxhdGl0dWRlLCBjZmcubG9uZ2l0dWRlLCBjZmcucmFuZG9tUmFkaXVzKTsKICAgICAgY2ZnLmxhdGl0dWRlID0gaml0dGVyZWQubGF0aXR1ZGU7CiAgICAgIGNmZy5sb25naXR1ZGUgPSBqaXR0ZXJlZC5sb25naXR1ZGU7CiAgICAgIGNmZy5yYW5kb21EaXN0YW5jZSA9IGppdHRlcmVkLmRpc3RhbmNlOwogICAgfQogICAgcmV0dXJuIGNmZzsKICB9CgogIGZ1bmN0aW9uIGFwcGx5UmFuZG9tUmFkaXVzKGxhdCwgbG9uLCByYWRpdXNNZXRlcnMpIHsKICAgIHZhciByID0gTnVtYmVyKHJhZGl1c01ldGVycyk7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShyKSB8fCByIDw9IDApIHJldHVybiB7IGxhdGl0dWRlOiBsYXQsIGxvbmdpdHVkZTogbG9uLCBkaXN0YW5jZTogMCB9OwogICAgdmFyIGRpc3RhbmNlID0gTWF0aC5zcXJ0KE1hdGgucmFuZG9tKCkpICogcjsKICAgIHZhciBiZWFyaW5nID0gMiAqIE1hdGgucmFuZG9tKCkgKiBNYXRoLlBJOwogICAgdmFyIGFuZ3VsYXIgPSBkaXN0YW5jZSAvIDYzNzgxMzcKICAgIHZhciBsYXRSYWQgPSAobGF0ICogTWF0aC5QSSkgLyAxODA7CiAgICB2YXIgbG9uUmFkID0gKGxvbiAqIE1hdGguUEkpIC8gMTgwOwogICAgdmFyIG5ld0xhdCA9IE1hdGguYXNpbihNYXRoLnNpbihsYXRSYWQpICogTWF0aC5jb3MoYW5ndWxhcikgKyBNYXRoLmNvcyhsYXRSYWQpICogTWF0aC5zaW4oYW5ndWxhcikgKiBNYXRoLmNvcyhiZWFyaW5nKSk7CiAgICB2YXIgbmV3TG9uID0gKChsb25SYWQgKyBNYXRoLmF0YW4yKE1hdGguc2luKGJlYXJpbmcpICogTWF0aC5zaW4oYW5ndWxhcikgKiBNYXRoLmNvcyhsYXRSYWQpLCBNYXRoLmNvcyhhbmd1bGFyKSAtIE1hdGguc2luKGxhdFJhZCkgKiBNYXRoLnNpbihuZXdMYXQpKSArIDMgKiBNYXRoLlBJKSAlICgyICogTWF0aC5QSSkpIC0gTWF0aC5QSTsKICAgIHJldHVybiB7CiAgICAgIGxhdGl0dWRlOiBOdW1iZXIoKChuZXdMYXQgKiAxODApIC8gTWF0aC5QSSkudG9GaXhlZCg4KSksCiAgICAgIGxvbmdpdHVkZTogTnVtYmVyKCgobmV3TG9uICogMTgwKSAvIE1hdGguUEkpLnRvRml4ZWQoOCkpLAogICAgICBkaXN0YW5jZTogZGlzdGFuY2UKICAgIH07CiAgfQoKICBmdW5jdGlvbiBsb2FkQ29uZmlnKCkgewogICAgLy8g54Sh54uA5oWL77ya5b6e5pys5qmfICRwcmVmcyDoroDlj5bpgbjpu57poIHlr6vlhaXnmoTluqfmqJnvvIjkuI3nmbzotbfku7vkvZXlpJbpg6jntrLot6/oq4vmsYLvvInjgIIKICAgIC8vIOiIhyBsb2NhdGlvbi1zZXR0aW5ncy5qcyDlr6vlhaXnmoTmrITkvY3kuIDoh7TvvJplbmFibGVkL2xhdGl0dWRlL2xvbmdpdHVkZS9hbHRpdHVkZS9ob3Jpem9udGFsQWNjdXJhY3kvdmVydGljYWxBY2N1cmFjeeOAggogICAgdmFyIGNmZyA9IHt9OwogICAgZm9yICh2YXIgayBpbiBERUZBVUxUX0NPTkZJRykgeyBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKERFRkFVTFRfQ09ORklHLCBrKSkgY2ZnW2tdID0gREVGQVVMVF9DT05GSUdba107IH0KICAgIHZhciBrZXlzID0gWyJlbmFibGVkIiwgImxhdGl0dWRlIiwgImxvbmdpdHVkZSIsICJhbHRpdHVkZSIsICJob3Jpem9udGFsQWNjdXJhY3kiLCAidmVydGljYWxBY2N1cmFjeSIsICJyYW5kb21SYWRpdXMiXTsKICAgIGlmICh0eXBlb2YgJHByZWZzICE9PSAidW5kZWZpbmVkIiAmJiAkcHJlZnMudmFsdWVGb3JLZXkpIHsKICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBrZXlzLmxlbmd0aDsgaSsrKSB7CiAgICAgICAgdmFyIHYgPSAkcHJlZnMudmFsdWVGb3JLZXkoa2V5c1tpXSk7CiAgICAgICAgaWYgKHYgIT0gbnVsbCAmJiB2ICE9PSAiIikgY2ZnW2tleXNbaV1dID0gdjsKICAgICAgfQogICAgfQogICAgcmV0dXJuIG5vcm1hbGl6ZUNvbmZpZyhjZmcpOwogIH0KCiAgZnVuY3Rpb24gbWVyZ2VDb25maWcoYmFzZSwgZXh0cmEpIHsKICAgIHZhciBvdXQgPSB7fSwga2V5OwogICAgZm9yIChrZXkgaW4gYmFzZSkgeyBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGJhc2UsIGtleSkpIG91dFtrZXldID0gYmFzZVtrZXldOyB9CiAgICBleHRyYSA9IGV4dHJhIHx8IHt9OwogICAgZm9yIChrZXkgaW4gZXh0cmEpIHsgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChleHRyYSwga2V5KSkgb3V0W2tleV0gPSBleHRyYVtrZXldOyB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgZnVuY3Rpb24gcnVuUVgoKSB7CiAgICB2YXIgaGFzUmVzcG9uc2UgPSB0eXBlb2YgJHJlc3BvbnNlICE9PSAidW5kZWZpbmVkIjsKICAgIGlmIChoYXNSZXNwb25zZSkgewogICAgICB2YXIgY29uZmlnID0gbG9hZENvbmZpZygpOwogICAgICB0cnkgewogICAgICAgIGlmICghY29uZmlnLmVuYWJsZWQpIHsgJGRvbmUoe30pOyByZXR1cm47IH0KICAgICAgICB2YXIgcmF3QnVmID0gJHJlc3BvbnNlLmJvZHlCeXRlczsKICAgICAgICBpZiAoIXJhd0J1ZiB8fCAocmF3QnVmLmJ5dGVMZW5ndGggIT09IHVuZGVmaW5lZCAmJiByYXdCdWYuYnl0ZUxlbmd0aCA9PT0gMCkpIHsgJGRvbmUoe30pOyByZXR1cm47IH0KICAgICAgICB2YXIgcmVzcG9uc2VCeXRlcyA9IHJhd0J1ZiBpbnN0YW5jZW9mIFVpbnQ4QXJyYXkgPyByYXdCdWYgOiBuZXcgVWludDhBcnJheShyYXdCdWYpOwogICAgICAgIGlmIChyZXNwb25zZUJ5dGVzLmxlbmd0aCA8IDIpIHsgJGRvbmUoe30pOyByZXR1cm47IH0KICAgICAgICBpZiAoY29uZmlnLmRlYnVnKSBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBRWCByZXNwb25zZTogIiArIHJlc3BvbnNlQnl0ZXMubGVuZ3RoICsgIiBieXRlcywgaGVhZD0iICsgaGV4UHJldmlldyhyZXNwb25zZUJ5dGVzLCAzMikpOwogICAgICAgIHZhciByZXN1bHQgPSBzcG9vZkFwcGxlUmVzcG9uc2UocmVzcG9uc2VCeXRlcywgY29uZmlnKTsKICAgICAgICBpZiAoY29uZmlnLmRlYnVnKSBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBwYXRjaGVkICIgKyByZXN1bHQud2lmaUNvdW50ICsgIiB3aWZpLCAiICsgcmVzdWx0LmNlbGxDb3VudCArICIgY2VsbCwga2luZD0iICsgcmVzdWx0LmtpbmQgKyAiLCByZXNwb25zZT0iICsgcmVzdWx0LnJlc3BvbnNlLmxlbmd0aCArICIgYnl0ZXMiKTsKICAgICAgICBpZiAoY29uZmlnLmRlYnVnKSBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBsb2NhdGlvbnM6ICIgKyBwYXRjaGVkUGF5bG9hZFN1bW1hcnkocmVzdWx0LnBheWxvYWQpKTsKICAgICAgICAkZG9uZSh7CiAgICAgICAgICBib2R5Qnl0ZXM6IHJlc3VsdC5yZXNwb25zZS5idWZmZXIuc2xpY2UoCiAgICAgICAgICAgIHJlc3VsdC5yZXNwb25zZS5ieXRlT2Zmc2V0LAogICAgICAgICAgICByZXN1bHQucmVzcG9uc2UuYnl0ZU9mZnNldCArIHJlc3VsdC5yZXNwb25zZS5ieXRlTGVuZ3RoCiAgICAgICAgICApCiAgICAgICAgfSk7CiAgICAgIH0gY2F0Y2ggKGVycikgewogICAgICAgIGlmIChjb25maWcuZGVidWcpIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIGZhaWxlZDogIiArIGVyci5tZXNzYWdlKTsKICAgICAgICAkZG9uZSh7fSk7CiAgICAgIH0KICAgIH0gZWxzZSB7ICRkb25lKHt9KTsgfQogIH0KCiAgdmFyIGFwaSA9IHsKICAgIERFRkFVTFRfQ09ORklHOiBERUZBVUxUX0NPTkZJRywgYmFzZTY0VG9CeXRlczogYmFzZTY0VG9CeXRlcywgYnl0ZXNUb0Jhc2U2NDogYnl0ZXNUb0Jhc2U2NCwKICAgIHBhdGNoQXBwbGVXTG9jUGF5bG9hZDogcGF0Y2hBcHBsZVdMb2NQYXlsb2FkLCBzcG9vZkFwcGxlUmVzcG9uc2U6IHNwb29mQXBwbGVSZXNwb25zZSwKICAgIGV4dHJhY3RBcHBsZVdMb2NQYXlsb2FkOiBleHRyYWN0QXBwbGVXTG9jUGF5bG9hZCwgcGFyc2VBcnBjOiBwYXJzZUFycGMsCiAgICBjb29yZFRvSW50OiBjb29yZFRvSW50LCBub3JtYWxpemVDb25maWc6IG5vcm1hbGl6ZUNvbmZpZywgbG9hZENvbmZpZzogbG9hZENvbmZpZwogIH07CgogIGlmICh0eXBlb2YgbW9kdWxlICE9PSAidW5kZWZpbmVkIiAmJiBtb2R1bGUuZXhwb3J0cykgeyBtb2R1bGUuZXhwb3J0cyA9IGFwaTsgfQogIGVsc2UgeyBydW5RWCgpOyB9Cn0pKCk7Cg==";

/* ==== inlined from src/page.js ==== */

function getPageHtml() {
  return `<!DOCTYPE html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>iOS 虛擬定位</title>
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="iOSLoc">
<meta name="theme-color" content="#ffffff">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icon-180.png">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js"><\/script>
<style>
:root {
  --bg:#ffffff; --card:#ffffff; --card2:#f5f5f7; --line:#e5e5ea; --inset:#f2f2f7;
  --cyan:#007aff; --cyan2:#0056b3; --green:#248a3d; --red:#d70015; --orange:#ff9500; /* ponytail: iOS tokens; red/green darkened for AA contrast on white */
  --txt:#1c1c1e; --muted:#6e6e73; --mono:#5856d6;
  --blue:#007aff; --gray:#6e6e73;
}
* { margin:0; padding:0; box-sizing:border-box; }
body {
  font-family:-apple-system,system-ui,"SF Pro TC","PingFang TC","Helvetica Neue",sans-serif;
  color:var(--txt);
  background:var(--bg);
  overscroll-behavior-y:none;
}
::placeholder { color:#98989d; }
::-webkit-scrollbar { width:6px; height:6px; }
::-webkit-scrollbar-thumb { background:#d1d1d6; border-radius:3px; }

/* ---- 頂部列 ---- */
.topbar { position:sticky; top:0; z-index:1200; display:flex; align-items:center; gap:10px; padding:9px 12px; background:rgba(255,255,255,.92); -webkit-backdrop-filter:blur(14px); backdrop-filter:blur(14px); border-bottom:1px solid var(--line); font-size:11px; color:var(--muted); }
.topbar .back { flex:none; color:var(--cyan); font-weight:700; text-decoration:none; }
.topbar .topcredit { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-align:center; }
.topbar .topcredit .title { font-size:14px; font-weight:800; color:var(--txt); letter-spacing:.3px; }

/* ---- 地圖 ---- */
#map { height:56vh; width:100%; min-height:300px; background:#f2f2f7; border-bottom:1px solid var(--line); }
.leaflet-container { background:#f2f2f7; }
.leaflet-control-zoom a { background:rgba(255,255,255,.92)!important; color:var(--txt)!important; border-color:var(--line)!important; -webkit-backdrop-filter:blur(10px); backdrop-filter:blur(10px); }
.leaflet-control-zoom a:hover { background:#f2f2f7!important; }
.leaflet-bar { border:1px solid var(--line)!important; box-shadow:0 2px 12px rgba(0,0,0,.08)!important; }
.leaflet-control-attribution { background:rgba(255,255,255,.8)!important; color:var(--muted)!important; }
.leaflet-control-attribution a { color:var(--muted)!important; }

.panel { padding:16px; max-width:600px; margin:0 auto; padding-bottom:calc(16px + env(safe-area-inset-bottom)); }

/* ---- 卡片 ---- */
.card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:16px; margin-bottom:12px; box-shadow:0 1px 4px rgba(0,0,0,.04); }
.card h3 { font-size:15px; font-weight:700; margin-bottom:12px; color:var(--txt); display:flex; align-items:center; gap:8px; }
.card h3::before { content:""; width:3px; height:14px; border-radius:2px; background:var(--cyan); flex:none; }

.coords { font-family:"SF Mono",ui-monospace,monospace; font-size:13.5px; color:var(--muted); padding:10px 12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; word-break:break-all; }
.crow { display:flex; align-items:center; gap:8px; padding:8px 12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; margin-bottom:6px; }
.crow .ck { font-size:11px; font-weight:700; letter-spacing:.6px; text-transform:uppercase; color:var(--cyan); width:34px; flex:none; }
.crow .cv { flex:1; min-width:0; font-family:"SF Mono",ui-monospace,monospace; font-size:14px; color:var(--mono); word-break:break-all; }
.copybtn { flex:none; }

/* ---- 按鈕 ---- */
.row { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
.btn { flex:1; min-width:100px; padding:12px 16px; border:none; border-radius:11px; font-size:14px; font-weight:700; cursor:pointer; transition:all .15s; }
.btn-primary { background:var(--cyan); color:#ffffff; }
.btn-primary:active { filter:brightness(.92); transform:scale(.97); }
.btn-secondary { background:var(--card2); color:var(--txt); border:1px solid var(--line); font-weight:600; }
.btn-secondary:active { background:#e5e5ea; transform:scale(.97); }
.btn-danger { background:transparent; color:var(--red); border:1px solid rgba(255,59,48,.35); }
.btn-danger:active { background:rgba(255,59,48,.08); transform:scale(.97); }
.btn.success { background:var(--green); color:#ffffff; border:none; }
.btn-sm { flex:none; min-width:auto; min-height:40px; padding:6px 12px; font-size:12px; border-radius:8px; }

/* ---- 輸入框 ---- */
.input-row { display:flex; gap:8px; margin-top:10px; }
.input-row input { flex:1; padding:10px 12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; font-size:14px; color:var(--txt); outline:none; min-width:0; -webkit-appearance:none; transition:border-color .15s,box-shadow .15s; }
.cvi { flex:1; min-width:0; width:100%; font-family:"SF Mono",ui-monospace,monospace; font-size:14px; color:var(--mono); padding:6px 10px; background:var(--inset); border:1px solid var(--line); border-radius:8px; outline:none; -webkit-appearance:none; transition:border-color .15s,box-shadow .15s; }
.accfield input { width:100%; padding:8px 10px; background:var(--inset); border:1px solid var(--line); border-radius:8px; font-size:14px; color:var(--txt); outline:none; -webkit-appearance:none; transition:border-color .15s,box-shadow .15s; }
.input-row input:focus, .cvi:focus, .accfield input:focus, .modal input:focus { border-color:var(--cyan); box-shadow:0 0 0 3px rgba(0,122,255,.12); }
.acc-row { display:flex; gap:8px; margin-bottom:6px; }
.accfield { flex:1; min-width:0; display:flex; flex-direction:column; gap:4px; }
.acclbl { font-size:11px; color:var(--muted); }

.status { font-size:12px; color:var(--muted); margin-top:8px; text-align:center; }
.hint { font-size:11px; color:var(--muted); margin-top:8px; line-height:1.6; }
.accnote { margin-top:10px; padding:11px 13px; background:var(--inset); border:1px solid var(--line); border-left:3px solid var(--cyan); border-radius:9px; font-size:11.5px; color:#3a3a3c; line-height:1.85; }
.accnote b { display:block; color:var(--cyan); font-weight:800; font-size:12px; margin-bottom:6px; letter-spacing:.3px; }
.accnote code { font-family:"SF Mono",ui-monospace,monospace; color:var(--mono); font-size:11px; }
.accnote em { color:var(--txt); font-style:normal; font-weight:800; }
.accnote .src { display:block; margin-top:7px; color:var(--muted); font-size:10.5px; }

/* ---- 清單 ---- */
.search-results { margin-top:8px; max-height:260px; overflow-y:auto; }
.search-item { padding:10px 12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; margin-bottom:6px; cursor:pointer; transition:all .15s; }
.search-item:active { background:#e5e5ea; border-color:var(--cyan); }
.search-item .si-name { font-size:14px; color:var(--txt); font-weight:600; }
.search-item .si-sub { font-size:11px; color:var(--muted); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

.error-banner { background:rgba(255,59,48,.06); border:1px solid rgba(255,59,48,.3); border-left:4px solid var(--red); color:#3a3a3c; padding:14px 16px; border-radius:12px; margin-bottom:12px; font-size:13.5px; line-height:1.6; display:none; }
.error-banner b { display:block; margin-bottom:4px; color:var(--red); font-size:14.5px; }

.toast { position:fixed; top:60px; left:50%; transform:translateX(-50%); background:rgba(28,28,30,.92); -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px); color:#ffffff; padding:11px 20px; border-radius:22px; font-size:14px; opacity:0; transition:opacity .3s; pointer-events:none; z-index:9999; max-width:90vw; text-align:center; box-shadow:0 8px 28px rgba(0,0,0,.15); }
.toast.show { opacity:1; }

.active-loc { background:var(--inset); border:1px solid var(--line); border-radius:10px; padding:11px 12px; font-size:13px; color:var(--txt); }
.active-loc .label { font-size:11px; color:var(--muted); margin-bottom:5px; }
.active-loc .value { font-family:"SF Mono",ui-monospace,monospace; font-size:13px; color:var(--mono); }

.fav-list { max-height:240px; overflow-y:auto; }
.fav-item { display:flex; align-items:center; gap:8px; padding:10px 12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; margin-bottom:6px; cursor:pointer; transition:all .15s; }
.fav-item:active { background:#e5e5ea; border-color:var(--cyan); }
.fav-item .fav-info { flex:1; min-width:0; }
.fav-item .fav-name { font-size:14px; font-weight:600; color:var(--txt); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.fav-item .fav-coords { font-size:11px; color:var(--muted); font-family:"SF Mono",ui-monospace,monospace; margin-top:2px; }
.fav-item .fav-active { font-size:10px; color:var(--green); font-weight:700; margin-top:2px; }
.fav-item .fav-del { flex:none; width:38px; height:38px; border:none; border-radius:50%; background:transparent; color:var(--red); font-size:16px; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:background .15s; }
.fav-item .fav-del:hover { background:rgba(255,59,48,.08); }
.fav-empty { text-align:center; color:var(--muted); font-size:13px; padding:16px 0; }
.fav-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
.fav-header h3 { margin-bottom:0; }

/* ---- 彈窗 ---- */
.modal-overlay { position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,.4); -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px); z-index:10000; display:none; align-items:center; justify-content:center; padding:20px; }
.modal-overlay.show { display:flex; }
.modal { background:#ffffff; border:1px solid var(--line); border-radius:18px; padding:20px; width:100%; max-width:340px; box-shadow:0 20px 60px rgba(0,0,0,.15); }
.modal h3 { font-size:17px; font-weight:700; margin-bottom:16px; text-align:center; color:var(--txt); }
.modal input { width:100%; padding:12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; font-size:15px; color:var(--txt); outline:none; margin-bottom:12px; -webkit-appearance:none; transition:border-color .15s,box-shadow .15s; }
.modal .modal-btns { display:flex; gap:8px; }
.modal .modal-btns .btn { padding:12px; }

/* ---- 地圖圖層切換 ---- */
.layer-switch { position:absolute; top:10px; right:10px; z-index:1000; display:flex; gap:4px; max-width:calc(100vw - 110px); flex-wrap:wrap; background:rgba(255,255,255,.92); -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px); border:1px solid var(--line); border-radius:10px; padding:4px; box-shadow:0 2px 8px rgba(0,0,0,.06); }
.layer-btn { border:none; background:transparent; min-height:32px; padding:6px 10px; border-radius:7px; font-size:12px; font-weight:600; color:var(--muted); cursor:pointer; transition:all .15s; white-space:nowrap; }
.layer-btn.active { background:var(--cyan); color:#ffffff; font-weight:700; }
.layer-btn:active { transform:scale(.95); }
.lang-switch { position:absolute; top:10px; left:10px; z-index:1000; display:flex; gap:2px; background:rgba(255,255,255,.92); -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px); border:1px solid var(--line); border-radius:10px; padding:4px; box-shadow:0 2px 8px rgba(0,0,0,.06); }
.lang-btn { border:none; background:transparent; min-height:32px; padding:6px 11px; border-radius:7px; font-size:12px; font-weight:700; color:var(--muted); cursor:pointer; transition:all .15s; }
.lang-btn.active { background:var(--cyan); color:#ffffff; }
.lang-btn:active { transform:scale(.95); }

@media(max-width:480px) { #map { height:50vh; } .panel { padding:12px; } .layer-btn { padding:5px 7px; font-size:11px; } }
</style>
</head>
<body>
<div class="topbar">
  <a class="back" href="/">← 首頁</a>
  <span class="topcredit"><span class="title">iOS Location Spoofer <span data-i18n="app_title">定位修改</span></span></span>
</div>
<div style="position:relative">
<div id="map"></div>
<div class="lang-switch">
  <button class="lang-btn" data-lang="zh" onclick="setLang('zh')">繁中</button>
  <button class="lang-btn" data-lang="en" onclick="setLang('en')">EN</button>
</div>
<div class="layer-switch">
  <button class="layer-btn active" data-layer="satellite" data-i18n="layer_satellite" onclick="switchLayer('satellite')">衛星</button>
  <button class="layer-btn" data-layer="wgs84" onclick="switchLayer('wgs84')">WGS84</button>
  <button class="layer-btn" data-layer="amap" data-i18n="layer_amap" onclick="switchLayer('amap')">高德</button>
  <button class="layer-btn" data-layer="voyager" data-i18n="layer_color" onclick="switchLayer('voyager')">彩色</button>
  <button class="layer-btn" data-layer="standard" data-i18n="layer_standard" onclick="switchLayer('standard')">標準</button>
  <button class="layer-btn" data-layer="dark" data-i18n="layer_dark" onclick="switchLayer('dark')">暗色</button>
</div>
</div>
<div class="panel">
  <div class="error-banner" id="errorBanner" data-i18n-html="err_html"></div>
  <div class="card">
    <h3 data-i18n="choose_title">選擇目標位置</h3>
    <div class="coords" id="coords" data-i18n="coords_hint">點擊地圖或使用下方工具選擇位置</div>
    <div id="coordGrid" style="display:none">
      <div class="crow"><span class="ck" data-i18n="lat">緯度</span><span class="cv" id="cvLat"></span><button class="btn btn-sm btn-secondary copybtn" data-i18n="copy" onclick="copyField('lat',this)">複製</button></div>
      <div class="crow"><span class="ck" data-i18n="lon">經度</span><span class="cv" id="cvLon"></span><button class="btn btn-sm btn-secondary copybtn" data-i18n="copy" onclick="copyField('lon',this)">複製</button></div>
      <div class="crow"><span class="ck" data-i18n="alt">海拔</span><input class="cvi" id="altInput" type="number" inputmode="decimal" step="1" /><button class="btn btn-sm btn-secondary copybtn" data-i18n="copy" onclick="copyField('alt',this)">複製</button></div>
      <div class="acc-row">
        <div class="accfield"><span class="acclbl" data-i18n="hacc">水平精確度</span><input id="haccInput" type="number" inputmode="numeric" step="1" min="1" value="39" /></div>
        <div class="accfield"><span class="acclbl" data-i18n="vacc">垂直精確度</span><input id="vaccInput" type="number" inputmode="numeric" step="1" min="1" value="1000" /></div>
        <div class="accfield"><span class="acclbl" data-i18n="jitter">擾動半徑 (公尺)</span><input id="jitterInput" type="number" inputmode="numeric" step="1" min="0" value="0" /></div>
      </div>
    </div>
    <div class="row">
      <button class="btn btn-primary" id="saveBtn" data-i18n="save" onclick="save()">儲存到裝置</button>
      <button class="btn btn-secondary" data-i18n="restore" onclick="restoreReal()">還原真實定位</button>
    </div>
    <div class="row">
      <button class="btn btn-secondary" data-i18n="copy_params" onclick="copyParams(this)">複製模組參數</button>
      <button class="btn btn-secondary" data-i18n="add_fav" onclick="addFav()">收藏位置</button>
      <button class="btn btn-secondary" data-i18n="locate" onclick="locateMe()">當前位置</button>
    </div>
    <div class="hint" data-i18n="alt_hint">海拔由 Open-Meteo（WGS-84）自動填入，可手動編輯。儲存到裝置時會一併寫入，並由 iOS Location Spoofer 模組生效。</div>
    <div class="accnote" data-i18n-html="acc_note_html"></div>
  </div>
  <div class="card">
    <div class="fav-header">
      <h3 data-i18n="fav_title">收藏的位置</h3>
      <button class="btn btn-sm btn-secondary" data-i18n="clear_all" onclick="clearAllFav()" id="clearAllBtn" style="display:none">清空全部</button>
    </div>
    <div id="favList" class="fav-list"></div>
  </div>
  <div class="card">
    <h3 data-i18n="active_title">當前生效座標</h3>
    <div class="active-loc" id="activeLoc">
      <div class="label" data-i18n="active_label">裝置本地座標（latitude/longitude/altitude）</div>
      <div class="value" id="activeValue">查詢中...</div>
    </div>
    <div class="row">
      <button class="btn btn-sm btn-secondary" data-i18n="refresh" onclick="queryActive()">重新整理</button>
      <button class="btn btn-sm btn-danger" data-i18n="clear_data" onclick="clearActive()">清除資料</button>
    </div>
  </div>
  <div class="card">
    <h3 data-i18n="paste_title">貼上地圖連結</h3>
    <div class="input-row">
      <input id="urlInput" data-i18n-ph="paste_ph" data-i18n-al="paste_ph" placeholder="Apple/Google/高德/百度地圖連結或座標" />
      <button class="btn btn-secondary" style="flex:none;min-width:56px" data-i18n="parse" onclick="parseUrl()">解析</button>
    </div>
    <div style="font-size:11px;color:var(--gray);margin-top:6px" data-i18n="paste_hint">支援 Apple Maps · Google Maps · 高德 · 百度 · 座標文字（自動換算為 WGS-84）</div>
  </div>
  <div class="card">
    <h3 data-i18n="search_title">搜尋地點</h3>
    <div class="input-row">
      <input id="searchInput" data-i18n-ph="search_ph" data-i18n-al="search_ph" placeholder="搜尋地名，按 Enter 列出候選（僅預覽，不改定位）" />
      <button class="btn btn-secondary" style="flex:none;min-width:56px" data-i18n="search" onclick="searchPlace()">搜尋</button>
    </div>
    <div id="searchResults" class="search-results"></div>
  </div>
  <div class="status" id="status" aria-live="polite">選好位置後點擊「儲存到裝置」寫入代理工具</div>
</div>
<div class="toast" id="toast" aria-live="polite"></div>
<div class="modal-overlay" id="favModal" onclick="if(event.target===this)closeFavModal()">
  <div class="modal">
    <h3 data-i18n="modal_title">收藏此位置</h3>
    <input id="favNameInput" data-i18n-ph="modal_ph" data-i18n-al="modal_ph" placeholder="輸入備註名稱（例如：公司、家）" maxlength="30" />
    <div style="font-size:12px;color:var(--gray);margin-bottom:12px;text-align:center" id="favModalCoords"></div>
    <div class="modal-btns">
      <button class="btn btn-secondary" data-i18n="cancel" onclick="closeFavModal()">取消</button>
      <button class="btn btn-primary" data-i18n="save_short" onclick="confirmFav()">儲存</button>
    </div>
  </div>
</div>
<script>
const SAVE_API = 'https://gs-loc.apple.com/ils-settings/save';
const PARSE_API = '/api/parse';
const ELEV_API = 'https://api.open-meteo.com/v1/elevation';
const FAV_KEY = 'ils_favorites';
const LANG_KEY = 'ils_lang';
let lat = 0, lon = 0;
let didInitialCenter = false;
let selected = false;
let elev = null, elevState = 'idle';
let elevSeq = 0, elevTimer = null;
const elevCache = new Map();
let activeLon = null, activeLat = null, activeAcc = null, activeAlt = null, activeStatus = 'querying';
let savedLon = null, savedLat = null, savedTimeStr = '';

/* ---- i18n ---- */
const I18N = {
  zh: {
    title: 'iOS 虛擬定位',
    app_title: '定位修改',
    layer_satellite: '衛星', layer_amap: '高德', layer_color: '彩色', layer_standard: '標準', layer_dark: '暗色',
    err_html: '<b>模組未生效</b>請檢查以下設定：<br>1. 已安裝並啟用 iOS Location Spoofer 模組<br>2. MITM 已開啟並信任憑證<br>3. MITM 主機名稱包含 gs-loc.apple.com<br>4. 當前網路已走代理',
    choose_title: '選擇目標位置',
    coords_hint: '點擊地圖或使用下方工具選擇位置',
    save: '儲存到裝置', add_fav: '收藏位置', locate: '當前位置',
    copy: '複製', copy_params: '複製模組參數',
    lat: '緯度', lon: '經度', alt: '海拔',
    alt_querying: '海拔查詢中…', alt_na: '海拔無法取得',
    alt_hint: '海拔由 Open-Meteo 自動查詢（WGS-84），儲存到裝置時會隨經緯度一併寫入，並由 iOS Location Spoofer 模組生效。',
    acc_note_html: '<b>精確度參數怎麼填</b>' +
      '<code>horizontalAccuracy</code> 水平精確度（公尺），預設 <em>39</em>，數值越小越「精準」—— 想更像 GPS 可設 <em>5~15</em>；維持 <em>39</em> 也完全正常。<br>' +
      '<code>verticalAccuracy</code> 垂直精確度（公尺），預設 <em>1000</em> —— 本頁已自動填入目標點的真實海拔，可調小到 <em>10~30</em>，讓海拔看起來更可信。<br>' +
      '<code>擾動半徑</code>（公尺），預設 <em>0</em>（關閉）—— 設為 <em>N</em> 後，每次定位會在目標點周圍 <em>N</em> 公尺內隨機偏移，避免每次結果都一模一樣。想固定在精確座標就維持 <em>0</em>。' +
      '<span class="src">參數建議來自上游專案 mekos2772 / ios-location-spoofer</span>',
    fav_title: '收藏的位置', clear_all: '清空全部',
    active_title: '當前生效座標', active_label: '裝置本地座標（latitude/longitude/altitude）',
    refresh: '重新整理', clear_data: '清除資料',
    paste_title: '貼上地圖連結', paste_ph: 'Apple/Google/高德/百度地圖連結或座標', parse: '解析',
    paste_hint: '支援 Apple Maps · Google Maps · 高德 · 百度 · 座標文字（自動換算為 WGS-84）',
    search_title: '搜尋地點', search_ph: '搜尋地名，按 Enter 列出候選（僅預覽，不改定位）', search: '搜尋',
    status_hint: '選好位置後點擊「儲存到裝置」寫入代理工具',
    modal_title: '收藏此位置', modal_ph: '輸入備註名稱（例如：公司、家）', cancel: '取消', save_short: '儲存',
    acc: '精確度', restore: '還原真實定位', restored: '✓ 虛擬定位已清除。請將定位服務關閉、代理開關關閉，等待至少 10 秒後再開啟即生效。', hacc: '水平精確度', vacc: '垂直精確度', jitter: '擾動半徑（公尺）',
    querying: '查詢中...', no_saved: '沒有已儲存的座標', query_failed: '查詢失敗（需代理模組支援）', cleared: '已清除',
    fav_empty: '尚無收藏，選好位置後點擊「收藏位置」',
    active_now: '✓ 當前生效', del: '刪除',
    pick_first: '請先在地圖上選擇一個位置',
    enter_label: '請輸入備註名稱',
    added: function(n){ return '已收藏：' + n; },
    deleted: function(n){ return '已刪除：' + n; },
    clear_fav_confirm: '確定清空所有收藏？', all_cleared: '已清空所有收藏',
    clear_confirm: '確定清除裝置上已儲存的座標？清除後將使用模組預設參數或停止修改定位。',
    dev_cleared: '已清除裝置座標',
    clear_failed: function(e){ return '清除失敗：' + e; },
    clear_failed_cfg: '清除失敗 — 請檢查模組設定',
    saving: '儲存中...', saved: '✓ 已儲存',
    written: function(lo, la, ts){ return '✓ 已寫入：' + lo.toFixed(6) + ', ' + la.toFixed(6) + ' · ' + ts; },
    saved_toast: '✓ 座標已成功寫入模組。請將定位服務關閉、代理開關關閉，等待至少 10 秒後再開啟即生效。',
    save_failed: '✗ 儲存失敗 — 請檢查模組設定', write_failed: '寫入失敗',
    no_geo: '瀏覽器不支援定位', getting_loc: '取得位置中...', got_loc: '已取得當前位置',
    loc_failed: function(m){ return '定位失敗：' + m; },
    paste_first: '請貼上地圖連結或座標', parse_failed: '無法解析座標，請檢查連結格式', parsing: '解析中...',
    parsed: function(lo, la){ return '已解析：' + lo.toFixed(4) + ', ' + la.toFixed(4); },
    enter_place: '請輸入地名', searching: '搜尋中...',
    not_found: function(q){ return '找不到：' + q; }, search_failed: '搜尋失敗',
    copied: function(x){ return '已複製：' + x; }, copy_failed: '複製失敗，請手動選取',
    alt_unknown_copy: '海拔尚未取得，僅複製經緯度'
  },
  en: {
    title: 'iOS Location Spoofer',
    app_title: 'Location Editor',
    layer_satellite: 'Satellite', layer_amap: 'Amap', layer_color: 'Color', layer_standard: 'Standard', layer_dark: 'Dark',
    err_html: '<b>Module not active</b>Please check the following:<br>1. The iOS Location Spoofer module is installed and enabled<br>2. MITM is on and the certificate is trusted<br>3. The MITM hostname list includes gs-loc.apple.com<br>4. The current network is routed through the proxy',
    choose_title: 'Choose target location',
    coords_hint: 'Tap the map or use the tools below to pick a location',
    save: 'Save to Device', add_fav: 'Add Favorite', locate: 'Current Location',
    copy: 'Copy', copy_params: 'Copy module params',
    lat: 'Lat', lon: 'Lon', alt: 'Alt',
    alt_querying: 'querying altitude…', alt_na: 'altitude unavailable',
    alt_hint: 'Altitude is auto-filled from Open-Meteo (WGS-84), written to the device on Save, and applied by the iOS Location Spoofer module.',
    acc_note_html: '<b>Choosing the accuracy values</b>' +
      '<code>horizontalAccuracy</code> in metres, default <em>39</em> — the smaller, the more "precise" it looks. Set <em>5–15</em> to look more like GPS; <em>39</em> is perfectly fine too.<br>' +
      '<code>verticalAccuracy</code> in metres, default <em>1000</em> — this page already fills in the target\\'s real altitude, so lowering it to <em>10–30</em> makes that altitude look more credible.<br>' +
      '<code>Jitter radius</code> in metres, default <em>0</em> (off) — set to <em>N</em> and each positioning is randomly offset within <em>N</em> m of the target, so results are never identical. Leave <em>0</em> to stay pinned to the exact point.' +
      '<span class="src">Guidance from the upstream project mekos2772 / ios-location-spoofer</span>',
    fav_title: 'Favorites', clear_all: 'Clear All',
    active_title: 'Active coordinates', active_label: 'On-device coordinates (latitude/longitude/altitude)',
    refresh: 'Refresh', clear_data: 'Clear Data',
    paste_title: 'Paste map link', paste_ph: 'Apple / Google / Amap / Baidu map link or coordinates', parse: 'Parse',
    paste_hint: 'Supports Apple Maps · Google Maps · Amap · Baidu · coordinate text (auto-converted to WGS-84)',
    search_title: 'Search place', search_ph: 'Search a place, Enter to list candidates (preview only)', search: 'Search',
    status_hint: 'Pick a location, then tap "Save to Device" to write it to your proxy tool',
    modal_title: 'Add this location to favorites', modal_ph: 'Enter a label (e.g. Office, Home)', cancel: 'Cancel', save_short: 'Save',
    acc: 'Accuracy', restore: 'Restore real location', restored: '✓ Spoofed location cleared. Turn Location Services OFF, switch your proxy off, wait at least 10 seconds, then turn it back ON to take effect.', hacc: 'H. accuracy', vacc: 'V. accuracy', jitter: 'Jitter radius(m)',
    querying: 'Querying...', no_saved: 'No saved coordinates', query_failed: 'Query failed (requires the proxy module)', cleared: 'Cleared',
    fav_empty: 'No favorites yet. Pick a location and tap "Add Favorite".',
    active_now: '✓ Active now', del: 'Delete',
    pick_first: 'Please pick a location on the map first',
    enter_label: 'Please enter a label',
    added: function(n){ return 'Added: ' + n; },
    deleted: function(n){ return 'Deleted: ' + n; },
    clear_fav_confirm: 'Clear all favorites?', all_cleared: 'All favorites cleared',
    clear_confirm: 'Clear the coordinates saved on the device? After clearing, the module default parameters will be used or location spoofing will stop.',
    dev_cleared: 'Device coordinates cleared',
    clear_failed: function(e){ return 'Clear failed: ' + e; },
    clear_failed_cfg: 'Clear failed - please check the module configuration',
    saving: 'Saving...', saved: '✓ Saved',
    written: function(lo, la, ts){ return '✓ Written: ' + lo.toFixed(6) + ', ' + la.toFixed(6) + ' · ' + ts; },
    saved_toast: '✓ Coordinates written to the module. Turn Location Services OFF, wait at least 10 seconds, then turn it back ON to take effect.',
    save_failed: '✗ Save failed - please check the module configuration', write_failed: 'Write failed',
    no_geo: 'Browser does not support geolocation', getting_loc: 'Getting location...', got_loc: 'Current location acquired',
    loc_failed: function(m){ return 'Location failed: ' + m; },
    paste_first: 'Please paste a map link or coordinates', parse_failed: 'Could not parse coordinates, please check the link format', parsing: 'Parsing...',
    parsed: function(lo, la){ return 'Parsed: ' + lo.toFixed(4) + ', ' + la.toFixed(4); },
    enter_place: 'Please enter a place name', searching: 'Searching...',
    not_found: function(q){ return 'Not found: ' + q; }, search_failed: 'Search failed',
    copied: function(x){ return 'Copied: ' + x; }, copy_failed: 'Copy failed, please select manually',
    alt_unknown_copy: 'Altitude not ready, copied lat/lon only'
  }
};

function detectLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch(e) {}
  return 'zh';
}
let lang = detectLang();

function t(key) {
  const v = I18N[lang][key];
  if (typeof v === 'function') return v.apply(null, Array.prototype.slice.call(arguments, 1));
  return v === undefined ? key : v;
}

function applyI18n() {
  document.documentElement.lang = (lang === 'zh' ? 'zh-Hant-TW' : 'en');
  document.title = t('title');
  document.querySelectorAll('[data-i18n]').forEach(function(el){ el.textContent = t(el.getAttribute('data-i18n')); });
  document.querySelectorAll('[data-i18n-ph]').forEach(function(el){ el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
  document.querySelectorAll('[data-i18n-al]').forEach(function(el){ el.setAttribute('aria-label', t(el.getAttribute('data-i18n-al'))); });
  document.querySelectorAll('[data-i18n-html]').forEach(function(el){ el.innerHTML = t(el.getAttribute('data-i18n-html')); });
  document.querySelectorAll('.lang-btn').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-lang') === lang); });
  updateCoords();
  updateStatus();
  renderActive();
  renderFavs();
}

function setLang(l) {
  lang = l;
  try { localStorage.setItem(LANG_KEY, l); } catch(e) {}
  applyI18n();
}

const map = L.map('map').setView([20, 0], 2);
const tiles = {
  satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {maxZoom:19, attribution:'ArcGIS'}),
  wgs84: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {maxZoom:19, attribution:'ArcGIS WGS84'}),
  standard: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'\\u00a9 OSM'}),
  dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {maxZoom:19, attribution:'\\u00a9 Carto'}),
  amap: L.tileLayer('https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}', {maxZoom:18, subdomains:'1234', attribution:'\\u00a9 Amap'}),
  voyager: L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {maxZoom:19, attribution:'\\u00a9 Carto'})
};
let currentLayer = tiles.satellite;
currentLayer.addTo(map);
function switchLayer(name) {
  map.removeLayer(currentLayer);
  currentLayer = tiles[name];
  currentLayer.addTo(map);
  document.querySelectorAll('.layer-btn').forEach(b => b.classList.toggle('active', b.dataset.layer === name));
}
let marker = L.marker([lat, lon], {draggable:true});
let markerShown = false;
function showMarker() { if (!markerShown) { marker.addTo(map); markerShown = true; } }

marker.on('dragend', e => { const p=e.target.getLatLng(); setPos(p.lat, p.lng); });
map.on('click', e => { setPos(e.latlng.lat, e.latlng.lng); });

function currentAlt() {
  const el = document.getElementById('altInput');
  if (!el) return null;
  const n = parseFloat(el.value);
  return isFinite(n) ? Math.round(n) : null;
}
function haccVal() { const n = parseInt((document.getElementById('haccInput')||{}).value, 10); return isFinite(n) && n > 0 ? n : 39; }
function vaccVal() { const n = parseInt((document.getElementById('vaccInput')||{}).value, 10); return isFinite(n) && n > 0 ? n : 1000; }
function jitterVal() { const n = parseInt((document.getElementById('jitterInput')||{}).value, 10); return isFinite(n) && n > 0 ? n : 0; }
function setAltInput(v) {
  const el = document.getElementById('altInput');
  if (!el) return;
  if (v === null) { el.value = ''; el.placeholder = t('alt_na'); }
  else { el.value = v; el.placeholder = ''; }
}

function updateCoords() {
  const grid = document.getElementById('coordGrid');
  const coords = document.getElementById('coords');
  if (!selected) {
    grid.style.display = 'none';
    coords.style.display = '';
    coords.textContent = t('coords_hint');
    return;
  }
  coords.style.display = 'none';
  grid.style.display = '';
  document.getElementById('cvLat').textContent = lat.toFixed(6);
  document.getElementById('cvLon').textContent = lon.toFixed(6);
}

function updateStatus() {
  document.getElementById('status').textContent = (savedLon !== null)
    ? t('written', savedLon, savedLat, savedTimeStr)
    : t('status_hint');
}

function setPos(newLat, newLon, knownAlt) {
  lat = newLat; lon = newLon; selected = true;
  showMarker();
  marker.setLatLng([lat, lon]);
  if (typeof knownAlt === 'number') { elev = Math.round(knownAlt); elevState = 'ok'; elevCache.set(elevKey(lat, lon), elev); }
  updateCoords();
  fetchElevation(lat, lon);
}

function moveTo(newLat, newLon, zoom, knownAlt) {
  setPos(newLat, newLon, knownAlt);
  map.setView([lat, lon], zoom || 15);
}

function elevKey(la, lo) { return la.toFixed(4) + ',' + lo.toFixed(4); }
function fetchElevation(la, lo) {
  const key = elevKey(la, lo);
  if (elevCache.has(key)) { elev = elevCache.get(key); elevState = (elev === null ? 'fail' : 'ok'); setAltInput(elev); return; }
  elevState = 'loading'; elev = null;
  const el = document.getElementById('altInput'); if (el) { el.value = ''; el.placeholder = t('alt_querying'); }
  const seq = ++elevSeq;
  clearTimeout(elevTimer);
  elevTimer = setTimeout(function(){
    fetch(ELEV_API + '?latitude=' + la + '&longitude=' + lo, { cache:'no-store', signal:AbortSignal.timeout(8000) })
      .then(r => r.json())
      .then(d => {
        const e = (d && d.elevation && d.elevation.length && d.elevation[0] !== null) ? Math.round(d.elevation[0]) : null;
        elevCache.set(key, e);
        if (seq === elevSeq) { elev = e; elevState = (e === null ? 'fail' : 'ok'); setAltInput(e); }
      })
      .catch(() => { if (seq === elevSeq) { elev = null; elevState = 'fail'; setAltInput(null); } });
  }, 500);
}

let toastTimer = null;
function toast(msg, ms) {
  const t2 = document.getElementById('toast');
  t2.textContent = msg; t2.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t2.classList.remove('show'), ms || 2500);
}

function showError(show) {
  document.getElementById('errorBanner').style.display = show ? 'block' : 'none';
}

function copyText(str) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(str);
  }
  return new Promise(function(resolve, reject){
    try {
      const ta = document.createElement('textarea');
      ta.value = str; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('execCommand failed'));
    } catch(e) { reject(e); }
  });
}

function copyField(which, btn) {
  if (!selected) { toast(t('pick_first')); return; }
  let val;
  if (which === 'lat') val = lat.toFixed(6);
  else if (which === 'lon') val = lon.toFixed(6);
  else { const a = currentAlt(); if (a === null) { toast(t('alt_na')); return; } val = String(a); }
  copyText(val).then(() => {
    toast(t('copied', val));
    if (btn) { const o = btn.textContent; btn.classList.add('success'); btn.textContent = '✓'; setTimeout(() => { btn.textContent = o; btn.classList.remove('success'); }, 1200); }
  }).catch(() => toast(t('copy_failed'), 3000));
}

function moduleParamString() {
  let s = 'latitude=' + lat.toFixed(6) + '&longitude=' + lon.toFixed(6);
  const a = currentAlt(); if (a !== null) s += '&altitude=' + a;
  s += '&horizontalAccuracy=' + haccVal() + '&verticalAccuracy=' + vaccVal();
  const j = jitterVal(); if (j > 0) s += '&randomRadius=' + j;
  return s;
}

function copyParams(btn) {
  if (!selected) { toast(t('pick_first')); return; }
  const s = moduleParamString();
  copyText(s).then(() => {
    toast(t('copied', s));
    if (currentAlt() === null) toast(t('alt_unknown_copy'), 3000);
    if (btn) { const o = btn.textContent; btn.classList.add('success'); btn.textContent = t('saved'); setTimeout(() => { btn.textContent = o; btn.classList.remove('success'); }, 1200); }
  }).catch(() => toast(t('copy_failed'), 3000));
}

function getFavs() {
  try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; } catch(e) { return []; }
}
function saveFavs(favs) {
  localStorage.setItem(FAV_KEY, JSON.stringify(favs));
}

function renderFavs() {
  const favs = getFavs();
  const el = document.getElementById('favList');
  const clearBtn = document.getElementById('clearAllBtn');
  clearBtn.style.display = favs.length ? '' : 'none';
  if (!favs.length) {
    el.innerHTML = '<div class="fav-empty">' + escHtml(t('fav_empty')) + '<\\/div>';
    return;
  }
  el.innerHTML = favs.map((f, i) => {
    const isActive = activeLon !== null && Math.abs(f.lon - activeLon) < 0.000001 && Math.abs(f.lat - activeLat) < 0.000001;
    const altStr = (typeof f.alt === 'number') ? ('  ·  ' + f.alt + ' m') : '';
    return '<div class="fav-item" onclick="loadFav(' + i + ')">' +
      '<div class="fav-info">' +
        '<div class="fav-name">' + escHtml(f.name) + '<\\/div>' +
        '<div class="fav-coords">' + f.lon.toFixed(6) + ', ' + f.lat.toFixed(6) + altStr + '<\\/div>' +
        (isActive ? '<div class="fav-active">' + escHtml(t('active_now')) + '<\\/div>' : '') +
      '<\\/div>' +
      '<button class="fav-del" aria-label="' + escHtml(t('del')) + '" onclick="event.stopPropagation();delFav(' + i + ')" title="' + escHtml(t('del')) + '">\\u00d7<\\/button>' +
    '<\\/div>';
  }).join('');
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function addFav() {
  if (!selected) { toast(t('pick_first')); return; }
  var _fa = currentAlt();
  document.getElementById('favModalCoords').textContent = lon.toFixed(6) + ', ' + lat.toFixed(6) + (_fa !== null ? ('  ·  ' + _fa + ' m') : '');
  document.getElementById('favNameInput').value = '';
  document.getElementById('favModal').classList.add('show');
  setTimeout(() => document.getElementById('favNameInput').focus(), 100);
}

function closeFavModal() {
  document.getElementById('favModal').classList.remove('show');
}

function confirmFav() {
  const name = document.getElementById('favNameInput').value.trim();
  if (!name) { toast(t('enter_label')); return; }
  const favs = getFavs();
  const rec = { name, lon, lat, time: new Date().toISOString() };
  const _ca = currentAlt(); if (_ca !== null) rec.alt = _ca;
  favs.push(rec);
  saveFavs(favs);
  closeFavModal();
  renderFavs();
  toast(t('added', name));
}

function loadFav(i) {
  const favs = getFavs();
  if (!favs[i]) return;
  moveTo(favs[i].lat, favs[i].lon, 15, typeof favs[i].alt === 'number' ? favs[i].alt : undefined);
  toast(favs[i].name + ' (' + favs[i].lon.toFixed(4) + ', ' + favs[i].lat.toFixed(4) + ')');
}

function delFav(i) {
  const favs = getFavs();
  if (!favs[i]) return;
  const name = favs[i].name;
  favs.splice(i, 1);
  saveFavs(favs);
  renderFavs();
  toast(t('deleted', name));
}

function clearAllFav() {
  if (!confirm(t('clear_fav_confirm'))) return;
  saveFavs([]);
  renderFavs();
  toast(t('all_cleared'));
}

function renderActive() {
  const el = document.getElementById('activeValue');
  if (activeStatus === 'ok') {
    el.textContent = t('lon') + ' ' + activeLon.toFixed(6) + '  ' + t('lat') + ' ' + activeLat.toFixed(6)
      + (activeAcc ? ('  ' + t('acc') + ' ' + activeAcc + 'm') : '')
      + (activeAlt !== null && activeAlt !== undefined ? ('  ' + t('alt') + ' ' + activeAlt + 'm') : '');
  } else if (activeStatus === 'none') {
    el.textContent = t('no_saved');
  } else if (activeStatus === 'failed') {
    el.textContent = t('query_failed');
  } else if (activeStatus === 'cleared') {
    el.textContent = t('cleared');
  } else {
    el.textContent = t('querying');
  }
}

function queryActive() {
  activeStatus = 'querying';
  renderActive();
  fetch(SAVE_API + '?action=query', { method:'GET', mode:'cors', cache:'no-store', signal:AbortSignal.timeout(8000) })
    .then(r => r.json())
    .then(d => {
      if (d.success && d.longitude && d.latitude) {
        activeLon = parseFloat(d.longitude);
        activeLat = parseFloat(d.latitude);
        activeAcc = (d.horizontalAccuracy != null ? d.horizontalAccuracy : (d.accuracy || null));
        activeAlt = (d.altitude !== undefined && d.altitude !== null) ? d.altitude : null;
        if (d.randomRadius != null) { const ji = document.getElementById('jitterInput'); if (ji) ji.value = d.randomRadius; }
        activeStatus = 'ok';
        if (!didInitialCenter && !selected) {
          didInitialCenter = true;
          moveTo(activeLat, activeLon, 15, (activeAlt !== null && activeAlt !== undefined) ? activeAlt : undefined);
        }
      } else {
        activeLon = null; activeLat = null; activeAcc = null; activeAlt = null;
        activeStatus = 'none';
      }
      renderActive();
      renderFavs();
    })
    .catch(() => { activeStatus = 'failed'; renderActive(); });
}

function clearActive() {
  if (!confirm(t('clear_confirm'))) return;
  fetch(SAVE_API + '?action=clear', { method:'GET', mode:'cors', cache:'no-store', signal:AbortSignal.timeout(8000) })
    .then(r => r.json())
    .then(d => {
      if (d.success) {
        activeLon = null; activeLat = null; activeAcc = null; activeAlt = null;
        activeStatus = 'cleared';
        renderActive();
        renderFavs();
        toast(t('dev_cleared'));
      } else { toast(t('clear_failed', d.error || ''), 3000); }
    })
    .catch(() => { toast(t('clear_failed_cfg'), 3000); });
}

let saveResetTimer = null;
async function save() {
  if (!selected) { toast(t('pick_first')); return; }
  const btn = document.getElementById('saveBtn');
  clearTimeout(saveResetTimer);
  btn.textContent = t('saving'); btn.disabled = true;
  showError(false);
  try {
    let url = SAVE_API + '?lon=' + lon + '&lat=' + lat;
    const a = currentAlt(); if (a !== null) url += '&alt=' + a;
    url += '&hacc=' + haccVal() + '&vacc=' + vaccVal() + '&randomRadius=' + jitterVal();
    const r = await fetch(url, { method: 'GET', mode: 'cors', cache: 'no-store', signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    if (d.success) {
      activeLon = lon; activeLat = lat; activeAcc = haccVal();
      activeAlt = currentAlt();
      activeStatus = 'ok';
      savedLon = lon; savedLat = lat; savedTimeStr = new Date().toLocaleTimeString();
      btn.textContent = t('saved'); btn.className = 'btn btn-primary success';
      updateStatus();
      renderActive();
      renderFavs();
      toast(t('saved_toast'), 30000);
      clearTimeout(saveResetTimer); saveResetTimer = setTimeout(() => { btn.textContent = t('save'); btn.className='btn btn-primary'; btn.disabled=false; }, 2500);
    } else {
      throw new Error(d.error || t('write_failed'));
    }
  } catch(e) {
    btn.textContent = t('save'); btn.className = 'btn btn-primary'; btn.disabled = false;
    showError(true);
    toast(t('save_failed'), 4000);
  }
}

function locateMe() {
  if (!navigator.geolocation) return toast(t('no_geo'));
  toast(t('getting_loc'));
  navigator.geolocation.getCurrentPosition(
    pos => { moveTo(pos.coords.latitude, pos.coords.longitude, 16); toast(t('got_loc')); },
    err => toast(t('loc_failed', err.message), 3000),
    { enableHighAccuracy:true, timeout:10000 }
  );
}

function parseLocalCoords(text) {
  const m = text.match(/(-?[0-9]+\\.[0-9]+)[,\\s]+(-?[0-9]+\\.[0-9]+)/);
  if (!m) return null;
  const a = parseFloat(m[1]), b = parseFloat(m[2]);
  if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lon: b };
  if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return { lat: b, lon: a };
  return { lat: a, lon: b };
}

async function parseUrl() {
  const input = document.getElementById('urlInput').value.trim();
  if (!input) return toast(t('paste_first'));
  toast(t('parsing'));
  try {
    const r = await fetch(PARSE_API + '?format=json&u=' + encodeURIComponent(input), { cache:'no-store', signal:AbortSignal.timeout(8000) });
    const d = await r.json();
    if (d && typeof d.lat === 'number' && typeof d.lon === 'number') {
      moveTo(d.lat, d.lon, 15);
      toast(d.name ? (d.name + ' (' + d.lon.toFixed(4) + ', ' + d.lat.toFixed(4) + ')') : t('parsed', d.lon, d.lat));
      return;
    }
    throw new Error(d && d.error ? d.error : 'parse failed');
  } catch(e) {
    const local = parseLocalCoords(input);
    if (local) { moveTo(local.lat, local.lon, 15); toast(t('parsed', local.lon, local.lat)); return; }
    toast(t('parse_failed'), 3000);
  }
}

let searchResults = [];
async function searchPlace() {
  const q = document.getElementById('searchInput').value.trim();
  if (!q) return toast(t('enter_place'));
  const box = document.getElementById('searchResults');
  box.innerHTML = '<div class="search-item">' + escHtml(t('searching')) + '<\\/div>';
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=6&q='+encodeURIComponent(q), { headers: { 'Accept-Language': (lang === 'zh' ? 'zh-TW' : 'en') }, signal:AbortSignal.timeout(8000) });
    searchResults = await r.json();
    if (!searchResults.length) { box.innerHTML = ''; toast(t('not_found', q), 3000); return; }
    box.innerHTML = searchResults.map(function(p, i){
      const name = p.display_name || '';
      return '<div class="search-item" onclick="selectSearchResult(' + i + ')">' +
        '<div class="si-name">' + escHtml(name.split(',')[0]) + '<\\/div>' +
        '<div class="si-sub">' + escHtml(name) + '<\\/div>' +
      '<\\/div>';
    }).join('');
  } catch(e) { box.innerHTML = ''; toast(t('search_failed'), 3000); }
}
function selectSearchResult(i) {
  const p = searchResults[i];
  if (!p) return;
  moveTo(parseFloat(p.lat), parseFloat(p.lon), 15);
  toast((p.display_name || '').slice(0, 40));
}
function restoreReal() {
  fetch(SAVE_API + '?action=clear', { method:'GET', mode:'cors', cache:'no-store', signal:AbortSignal.timeout(8000) })
    .then(r => r.json())
    .then(d => {
      if (d.success) {
        activeLon = null; activeLat = null; activeAcc = null; activeAlt = null;
        activeStatus = 'cleared'; savedLon = null;
        updateStatus(); renderActive(); renderFavs();
        toast(t('restored'), 30000);
      } else { toast(t('clear_failed_cfg'), 3000); }
    })
    .catch(() => toast(t('clear_failed_cfg'), 3000));
}

document.addEventListener('paste', e => {
  const tgt = e.target;
  if (tgt && tgt !== document.body && tgt.id !== 'urlInput') return;
  const text = (e.clipboardData||window.clipboardData).getData('text');
  if (text && (text.includes('map') || text.includes('loc') || text.includes('lnglat') || text.includes('baidu') || /[0-9]+\\.[0-9]+/.test(text))) {
    document.getElementById('urlInput').value = text;
    setTimeout(parseUrl, 200);
  }
});
document.getElementById('searchInput').addEventListener('keydown', e => { if(e.key==='Enter') searchPlace(); });
document.getElementById('urlInput').addEventListener('keydown', e => { if(e.key==='Enter') parseUrl(); });
document.getElementById('favNameInput').addEventListener('keydown', e => { if(e.key==='Enter') confirmFav(); });

applyI18n();
queryActive();
<\/script>
</body>
</html>`;
}

/* ==== inlined from src/landing.js ==== */

function getLandingHtml() {
  return `<!DOCTYPE html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>iOS Location Spoofer · 虛擬定位</title>
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#ffffff">
<link rel="apple-touch-icon" href="/icon-180.png">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>
:root{
  --bg:#f4f6fa; --card:#ffffff; --card2:#f0f3f8; --line:#e4e8ef;
  --brand:#2b7de9; --brand2:#1c62c4; --green:#248a3d; --green2:#059669;
  --red:#ef4444; --amber:#f59e0b; --txt:#1e293b; --muted:#64748b; --mono:#0b8ce0;
}
*{ margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
body{
  font-family:-apple-system,system-ui,"SF Pro","PingFang TC","Helvetica Neue","Microsoft JhengHei",sans-serif;
  color:var(--txt); line-height:1.5;
  background:var(--bg);
  -webkit-font-smoothing:antialiased;
}
.wrap{ max-width:600px; margin:0 auto; padding:20px 16px calc(44px + env(safe-area-inset-bottom)); }

header{ text-align:center; padding:8px 0 6px; }
header .logowrap{ position:relative; width:74px; margin:0 auto 14px; }
header .logo{ width:74px; height:74px; border-radius:20px; display:block; box-shadow:0 0 0 1px var(--line),0 10px 30px rgba(43,125,233,.15); }
h1{ font-size:23px; font-weight:800; letter-spacing:.3px; color:var(--txt); }
.credit{ font-size:12px; color:var(--muted); margin-top:12px; line-height:1.7; }
.credit a{ color:var(--brand); text-decoration:none; font-weight:600; }
.synced{ font-size:12px; color:var(--green); font-weight:700; margin-top:8px; }
.synced a{ color:var(--green); text-decoration:underline; }

.ctas{ display:flex; justify-content:center; margin:18px 0 4px; }
.enter{ flex:1; display:flex; align-items:center; justify-content:center; gap:8px; padding:17px 14px; border:none; border-radius:14px; font-size:16px; font-weight:800; cursor:pointer; text-decoration:none; transition:transform .12s,box-shadow .12s; font-family:inherit; }
.enter:active{ transform:scale(.97); }
.enter.go{ background:linear-gradient(135deg,var(--brand),var(--brand2)); color:#fff; box-shadow:0 10px 26px rgba(43,125,233,.25); }

.divider{ height:1px; background:linear-gradient(90deg,transparent,var(--line),transparent); margin:24px 0 20px; }

h2{ font-size:16px; font-weight:800; margin-bottom:4px; display:flex; align-items:center; gap:9px; }
h2::before{ content:""; width:4px; height:16px; border-radius:2px; background:linear-gradient(180deg,var(--brand),#5ba0f0); }
.sub{ font-size:12.5px; color:var(--muted); margin:0 0 14px 13px; }
.note{ background:#f5f9ff; border:1px solid #dbe8fb; border-left:4px solid var(--brand); border-radius:11px; padding:12px 14px; font-size:12.5px; color:#4a5568; margin-bottom:16px; }
.note b{ color:var(--txt); }

.plat{ background:var(--card); border:1px solid var(--line); border-radius:14px; padding:12px; margin-bottom:12px; box-shadow:0 2px 10px rgba(15,25,45,.04); }
.plat .big{ display:flex; align-items:center; justify-content:center; gap:8px; width:100%; padding:14px; border:none; border-radius:11px; background:linear-gradient(135deg,var(--brand),var(--brand2)); color:#fff; font-size:15.5px; font-weight:800; cursor:pointer; text-align:center; text-decoration:none; transition:filter .12s,transform .12s; }
.plat .big:active{ filter:brightness(1.1); transform:scale(.98); }
.plat .line{ display:flex; align-items:center; gap:8px; margin-top:9px; }
.plat .url{ flex:1; min-width:0; font-family:"SF Mono",ui-monospace,monospace; font-size:11px; color:var(--muted); background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:8px 10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.plat .copy{ flex:none; padding:8px 15px; border:1px solid var(--line); border-radius:8px; background:var(--card2); color:var(--txt); font-size:12.5px; font-weight:600; cursor:pointer; transition:all .12s; font-family:inherit; }
.plat .copy:active{ background:#e4e8ef; }
.plat .copy.ok{ background:var(--green); border-color:var(--green); color:#fff; }
.plat .pnote{ font-size:11.5px; color:var(--muted); margin-top:7px; line-height:1.6; }

.mitm{ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:13px 15px; font-size:12.5px; color:#4a5568; margin-top:16px; box-shadow:0 2px 10px rgba(15,25,45,.04); }
.mitm b{ color:var(--txt); }
.mitm code{ display:inline-block; font-family:"SF Mono",ui-monospace,monospace; font-size:11.5px; color:var(--mono); word-break:break-all; line-height:2; }
.mitm .hosts{ margin-top:8px; padding:10px 12px; background:var(--bg); border:1px solid var(--line); border-radius:9px; }
.mitm .hosts code{ line-height:2.1; }

.toast{ position:fixed; left:50%; bottom:40px; transform:translateX(-50%) translateY(20px); background:rgba(30,41,59,.94); color:#fff; padding:11px 20px; border-radius:22px; font-size:14px; opacity:0; transition:all .25s; pointer-events:none; z-index:99; box-shadow:0 8px 26px rgba(15,25,45,.28); }
.toast.show{ opacity:1; transform:translateX(-50%) translateY(0); }
footer{ text-align:center; font-size:11.5px; color:var(--muted); margin-top:26px; line-height:1.9; }
footer b{ color:var(--brand); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logowrap"><img class="logo" src="/icon.svg" alt=""></div>
    <h1>iOS Location Spoofer · 虛擬定位</h1>
    <p class="credit">
      衍生自開源專案：<a href="https://github.com/Yu9191/wloc" target="_blank" rel="noopener">Yu9191</a> ·
      <a href="https://github.com/mekos2772/ios-location-spoofer" target="_blank" rel="noopener">mekos2772</a> ·
      <a href="https://github.com/acheong08/ios-location-spoofer" target="_blank" rel="noopener">acheong08</a>
    </p>
    <p class="synced">✅ 已同步上游 <a href="https://github.com/Yu9191/wloc/releases" target="_blank" rel="noopener">Yu9191/wloc v1.1</a>：隨機擾動半徑 · 台/百度座標解析</p>
  </header>

  <div class="ctas">
    <a class="enter go" href="/picker">🗺️ 進入選點網頁</a>
  </div>

  <div class="divider"></div>

  <h2>安裝模組</h2>
  <p class="sub">選擇你的代理客戶端，點「一鍵匯入」直接安裝；或「複製」手動加入。</p>
  <div class="note">📍 生效前提：① 代理 App 已連線（開關/引擎開啟、<b>非「直連」模式</b>）；② 開啟 HTTPS 解密 (MITM) 並信任憑證；③ 裝好對應客戶端的模組。之後打開選點頁選位置、點「儲存到裝置」即可生效。iOS 26+ 切換後可能需重啟一次裝置清快取。</div>

  <div id="plats"></div>

  <div class="mitm">
    <b>Quantumult X 資源解析器 URL（QX 一鍵匯入 / 重寫引用需先設定好）：</b><br>
    <code>https://raw.githubusercontent.com/KOP-XIAO/QuantumultX/master/Scripts/resource-parser.js</code><br>
    加入方式 —— 把下面這段填入 QX 設定：<br>
    <code>[general]<br>#複製下面這些內容（另起一行）<br>resource_parser_url=https://raw.githubusercontent.com/KOP-XIAO/QuantumultX/master/Scripts/resource-parser.js</code>
  </div>
  <div class="mitm">
    <b>MITM 主機名稱（如全部設定成功仍不生效，在 MITM / HTTPS 解密中手動加入下面四個網域）：</b>
    <div class="hosts"><code>gs-loc.apple.com<br>gs-loc-cn.apple.com<br>bluedot.is.autonavi.com<br>bluedot.is.autonavi.com.gds.alibabadns.com</code></div>
  </div>

  <footer>
    座標只存在你<b>目前裝置</b>上，伺服器端不留存記錄。<br>
    GNU AGPL-3.0 · 僅供學習研究
  </footer>
</div>
<div class="toast" id="toast"></div>
<script>
var origin = location.origin;
function u(file){ return origin + '/' + file; }
var qxExtra = ', tag=iOS Location Spoofer, update-interval=172800, opt-parser=true, enabled=true';
var PLATS = [
  { name:'Surge', file:'ios-location-spoofer.sgmodule', scheme:function(x){ return 'surge:///install-module?url=' + encodeURIComponent(x); } },
  { name:'Shadowrocket', file:'ios-location-spoofer.sgmodule', scheme:function(x){ return 'shadowrocket://install?module=' + encodeURIComponent(x); } },
  { name:'Egern', file:'ios-location-spoofer.sgmodule', scheme:function(x){ return 'egern:///install-module?url=' + encodeURIComponent(x); } },
  { name:'Loon', file:'ios-location-spoofer.lnplugin', scheme:function(x){ return 'loon://import?plugin=' + encodeURIComponent(x); } },
  { name:'Stash', file:'ios-location-spoofer.stoverride', scheme:function(x){ return 'stash://install-override?url=' + encodeURIComponent(x); } },
  { name:'Quantumult X', file:'ios-location-spoofer.snippet',
    scheme:function(x){ return 'quantumult-x:///add-resource?remote-resource=' + encodeURIComponent(JSON.stringify({ rewrite_remote:[x + qxExtra] })); },
    note:'QX 沒有模組面板：一鍵匯入 = 加入「重寫」資源（需已設定資源解析器）；MITM 主機名稱要手動加進 設定→MITM。' }
];

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function toast(m){ var t=document.getElementById('toast'); t.textContent=m; t.classList.add('show'); setTimeout(function(){ t.classList.remove('show'); }, 1800); }
function copyText(s){
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(s);
  return new Promise(function(res,rej){ try{ var ta=document.createElement('textarea'); ta.value=s; ta.style.position='fixed'; ta.style.opacity='0'; document.body.appendChild(ta); ta.select(); var ok=document.execCommand('copy'); document.body.removeChild(ta); ok?res():rej(); }catch(e){ rej(e); } });
}
function doCopy(s, btn){ copyText(s).then(function(){ toast('已複製模組連結'); var o=btn.textContent; btn.classList.add('ok'); btn.textContent='✓'; setTimeout(function(){ btn.textContent=o; btn.classList.remove('ok'); }, 1200); }).catch(function(){ toast('複製失敗，請手動選擇'); }); }

var html = '';
for (var i=0; i<PLATS.length; i++){
  var p = PLATS[i];
  var url = u(p.file);
  html += '<div class="plat">' +
    '<a class="big" href="' + esc(p.scheme(url)) + '">一鍵匯入 ' + esc(p.name) + '</a>' +
    '<div class="line"><span class="url">' + esc(url) + '</span>' +
    '<button class="copy" data-url="' + esc(url) + '">複製</button></div>' +
    (p.note ? '<div class="pnote">' + esc(p.note) + '</div>' : '') +
    '</div>';
}
document.getElementById('plats').innerHTML = html;
var btns = document.querySelectorAll('.copy');
for (var j=0; j<btns.length; j++){ (function(b){ b.addEventListener('click', function(){ doCopy(b.getAttribute('data-url'), b); }); })(btns[j]); }
<\/script>
</body>
</html>`;
}

/* ==== inlined from src/index.js (imports stripped, Hono shimmed) ==== */

const app = new Hono();

app.get("/", (c) => {
  c.header("Cache-Control", "no-cache");
  return c.html(getLandingHtml());
});
app.get("/picker", (c) => {
  c.header("Cache-Control", "no-cache");
  return c.html(getPageHtml());
});

/* ---- PWA: manifest + icons (enables "Add to Home Screen") ---- */
const MANIFEST = {
  name: "iOS Location Spoofer",
  short_name: "iOSLoc",
  description: "Stateless map picker for iOS Location Spoofer (WGS-84 + altitude).",
  start_url: "/picker",
  scope: "/",
  display: "standalone",
  orientation: "portrait",
  background_color: "#f2f2f7",
  theme_color: "#007aff",
  icons: [
    { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    { src: "/icon-180.png", sizes: "180x180", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
};
const IMG_CACHE = "public, max-age=604800, immutable";
app.get("/manifest.webmanifest", (c) =>
  c.body(JSON.stringify(MANIFEST), 200, { "Content-Type": "application/manifest+json", "Cache-Control": IMG_CACHE })
);
app.get("/icon.svg", (c) => c.body(ICON_SVG, 200, { "Content-Type": "image/svg+xml", "Cache-Control": IMG_CACHE }));
app.get("/icon-180.png", (c) => c.body(b64ToBytes(ICON_180_B64), 200, { "Content-Type": "image/png", "Cache-Control": IMG_CACHE }));
app.get("/icon-512.png", (c) => c.body(b64ToBytes(ICON_512_B64), 200, { "Content-Type": "image/png", "Cache-Control": IMG_CACHE }));
app.get("/favicon.ico", (c) => c.body(ICON_SVG, 200, { "Content-Type": "image/svg+xml", "Cache-Control": IMG_CACHE }));

/* ---- Self-hosted on-device module ----
   Serve the two module scripts + a subscribable manifest so the whole stateless
   setup runs from this worker with NO GitHub dependency. The manifest self-references
   whatever domain served it (workers.dev URL or a custom domain). */
const JS_HEADERS = { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" };
app.get("/location-spoofer.js", (c) => c.body(b64ToBytes(LOCATION_SPOOFER_B64), 200, JS_HEADERS));
app.get("/location-settings.js", (c) => c.body(b64ToBytes(LOCATION_SETTINGS_B64), 200, JS_HEADERS));
app.get("/location-spoofer-qx.js", (c) => c.body(b64ToBytes(LOCATION_SPOOFER_QX_B64), 200, JS_HEADERS));

function sgmodule(origin) {
  return String.raw`#!name=iOS Location Spoofer (Stateless)
#!desc=無狀態版：座標寫入每台裝置各自的本機儲存、可公開共用、多人互不覆蓋。搭配選點頁使用。適用於 Shadowrocket / Surge / Egern。
#!homepage=${origin}

[Script]
iOS Location Spoofer = type=http-response,pattern=^https?:\/\/(?:gs-loc(?:-cn)?\.apple\.com|bluedot\.is\.autonavi\.com(?:\.gds\.alibabadns\.com)?)\/clls\/wloc(?:\?.*)?$,requires-body=1,binary-body-mode=1,max-size=1048576,timeout=10,script-path=${origin}/location-spoofer.js,argument=mode=response&debug=false
iLS Settings = type=http-request,pattern=^https?:\/\/gs-loc(?:-cn)?\.apple\.com\/ils-settings\/,requires-body=0,max-size=0,timeout=10,script-path=${origin}/location-settings.js

[MITM]
hostname = %APPEND% gs-loc.apple.com, gs-loc-cn.apple.com, bluedot.is.autonavi.com, bluedot.is.autonavi.com.gds.alibabadns.com`;
}
function stoverride(origin) {
  return String.raw`name: iOS Location Spoofer (Stateless)
desc: "iOS Location Spoofer 無狀態版 (Stash)"
homepage: ${origin}

http:
  mitm:
    - "gs-loc.apple.com"
    - "gs-loc-cn.apple.com"
  script:
    - match: ^https?:\/\/gs-loc(-cn)?\.apple\.com\/clls\/wloc
      name: ios-location-spoofer
      type: response
      require-body: true
      binary-mode: true
      max-size: 0
      timeout: 30
      argument: mode=response&debug=false
    - match: ^https?:\/\/gs-loc(-cn)?\.apple\.com\/ils-settings\/
      name: ios-location-settings
      type: request
      require-body: false
      timeout: 10

script-providers:
  ios-location-spoofer:
    url: ${origin}/location-spoofer.js
    interval: 86400
  ios-location-settings:
    url: ${origin}/location-settings.js
    interval: 86400`;
}
function lnplugin(origin) {
  return String.raw`#!name=iOS Location Spoofer (Stateless)
#!desc=無狀態版，配合選點頁使用。Loon 外掛。
#!homepage=${origin}

[Script]
http-response ^https?:\/\/(?:gs-loc(?:-cn)?\.apple\.com|bluedot\.is\.autonavi\.com(?:\.gds\.alibabadns\.com)?)\/clls\/wloc(?:\?.*)?$ script-path=${origin}/location-spoofer.js, requires-body=true, binary-body-mode=true, max-size=1048576, timeout=12, tag=iOS Location Spoofer, argument=mode=response&debug=false
http-request ^https?:\/\/gs-loc(?:-cn)?\.apple\.com\/ils-settings\/ script-path=${origin}/location-settings.js, requires-body=false, timeout=10, tag=iLS Settings

[MITM]
hostname = gs-loc.apple.com, gs-loc-cn.apple.com, bluedot.is.autonavi.com, bluedot.is.autonavi.com.gds.alibabadns.com`;
}
// Quantumult X has NO module/plugin system — it uses a "rewrite" reference. QX also does
// not auto-merge MITM hostnames the way Surge modules do, so the user must add them manually.
function qxsnippet(origin) {
  return String.raw`#!name=iOS Location Spoofer (Stateless)
#!desc=無狀態版。Quantumult X 使用「重寫 (rewrite) 引用」（非模組／外掛）。MITM 主機名稱需手動加進 QX 設定 → MITM。
#!homepage=${origin}

[rewrite_local]
^https?:\/\/(?:gs-loc(?:-cn)?\.apple\.com|bluedot\.is\.autonavi\.com(?:\.gds\.alibabadns\.com)?)\/clls\/wloc(?:\?.*)?$ url script-response-body ${origin}/location-spoofer-qx.js
^https?:\/\/gs-loc(?:-cn)?\.apple\.com\/ils-settings\/ url script-echo-response ${origin}/location-settings.js

[mitm]
hostname = gs-loc.apple.com, gs-loc-cn.apple.com, bluedot.is.autonavi.com, bluedot.is.autonavi.com.gds.alibabadns.com`;
}
const TXT = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" };
app.get("/ios-location-spoofer.sgmodule", (c) => c.body(sgmodule(new URL(c.req.url).origin), 200, TXT));
app.get("/ios-location-spoofer.stoverride", (c) => c.body(stoverride(new URL(c.req.url).origin), 200, TXT));
app.get("/ios-location-spoofer.lnplugin", (c) => c.body(lnplugin(new URL(c.req.url).origin), 200, TXT));
app.get("/ios-location-spoofer.snippet", (c) => c.body(qxsnippet(new URL(c.req.url).origin), 200, TXT));

// Map link parsing: called by the iOS Shortcut.
// GET /api/parse?u=<link>&format=json&cs=<gcj|none>
//   Returns {lat, lon, name}; Amap / Apple Maps (both GCJ-02 in mainland China) are auto-converted to WGS84; coordinates outside China are skipped automatically (out_of_china). cs=none forces no conversion.
//   Without format=json it returns a plain-text "lat=..&lon=.." fragment.
app.get("/api/parse", async (c) => {
  const raw = c.req.query("u") || "";
  const cs = (c.req.query("cs") || "").toLowerCase();
  const fmt = (c.req.query("format") || "").toLowerCase();
  try {
    let { lat, lon, name, src } = await parseCoords(raw);
    // Normalize every source to WGS-84 at the entrance (hard requirement).
    // Automatic path uses toWgs84(src): Baidu => BD-09; Amap/Apple/Google => GCJ-02,
    // EXCEPT Apple/Google in HK/Macau/Taiwan which are already WGS-84 (Yu9191 v1.1).
    // Explicit cs= overrides still win. All guards no-op outside China.
    if (cs === "none") {
      // leave coordinates untouched
    } else if (cs === "bd09" || cs === "baidu") {
      ({ lat, lon } = toWgs84(lat, lon, "baidu"));
    } else if (cs === "gcj") {
      ({ lat, lon } = gcj02ToWgs84(lat, lon));
    } else {
      ({ lat, lon } = toWgs84(lat, lon, src));
    }
    lat = round6(lat);
    lon = round6(lon);
    name = name || "";
    c.header("Access-Control-Allow-Origin", "*");
    if (fmt === "json") return c.json({ lat, lon, name });
    return c.text(`lat=${lat}&lon=${lon}`);
  } catch (e) {
    c.header("Access-Control-Allow-Origin", "*");
    return c.json({ error: String(e && e.message ? e.message : e) }, 422);
  }
});

/* ---- Telegram bot webhook: a user sends /link (or /start) → the bot replies with the homepage link.
   One-time setup:
     1) @BotFather → 你的 bot (CyberHandymanMSG_bot) → 取得 API token
     2) 終端機:  wrangler secret put TG_BOT_TOKEN            (貼上 token)
     3) (可選) wrangler secret put TG_WEBHOOK_SECRET       (任意隨機字串，防止偽造)
     4) 註冊回呼:  curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<origin>/tg&secret_token=<SECRET>"
     5) @BotFather → /setprivacy → 選該 bot → Disable      (這樣它才能讀到群組裡的 /link)
   token 只存在 Cloudflare Secret 裡，不寫進程式碼。未設定時本路由靜默回傳 ok，不影響其他功能。 */
app.post("/tg", async (c) => {
  const secret = c.env && c.env.TG_WEBHOOK_SECRET;
  if (secret && c.req.header("X-Telegram-Bot-Api-Secret-Token") !== secret) {
    return c.text("forbidden", 403);
  }
  const token = c.env && c.env.TG_BOT_TOKEN;
  let update = null;
  try { update = await c.req.json(); } catch (e) {}
  const msg = update && (update.message || update.channel_post);
  const text = (msg && msg.text) || "";
  const chatId = msg && msg.chat && msg.chat.id;
  // Match /link, /links, /start — tolerate the /link@BotName form Telegram uses in groups.
  const cmd = text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
  if (token && chatId && (cmd === "/link" || cmd === "/links" || cmd === "/start")) {
    const origin = new URL(c.req.url).origin;
    const reply =
      "📍 iOS 虛擬定位 · 選點首頁\n" + origin + "/\n\n" +
      "▶️ 影片教學：https://youtu.be/EspuRlKWUxc";
    await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: reply, disable_web_page_preview: false }),
    });
  }
  return c.text("ok", 200);
});

app.onError((e, c) => {
  console.error(`${e}`);
  return c.text(`${e}`, 500);
});

/* ---- Geo-restriction: block mainland China (CN); allow everywhere else ---- */
const BLOCK_HTML = `<!DOCTYPE html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not available in your region</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0f;color:#f2f2f7;font-family:-apple-system,system-ui,sans-serif;text-align:center;padding:28px}div{max-width:520px}h1{font-size:20px;margin-bottom:14px}p{color:#9a9aa8;font-size:14px;line-height:1.8}</style></head><body><div><h1>本服務在你所在地區無法使用</h1><p>This service is not available in your region.<br><br>本專案僅提供給中國大陸以外地區存取。<br>This project is served only outside mainland China.</p></div></body></html>`;

export default {
  async fetch(request, env, ctx) {
    const country = request && request.cf && request.cf.country;
    let pathname = "/";
    try { pathname = new URL(request.url).pathname; } catch (e) {}
    // Telegram's webhook POST is a server-to-server call (non-CN anyway) — never geo-block /tg.
    if (country === "CN" && pathname !== "/tg") {
      return new Response(BLOCK_HTML, { status: 403, headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" } });
    }
    // Lightweight access log — stream it live with `wrangler tail` to spot resale / abuse.
    // (No IP logged; edge-cached static fetches won't appear here, but page loads will.)
    try {
      console.log("REQ " + JSON.stringify({
        country: country || "?",
        path: pathname,
        ref: request.headers.get("referer") || "",
        ua: (request.headers.get("user-agent") || "").slice(0, 90),
      }));
    } catch (e) {}
    return app.fetch(request, env, ctx);
  },
};