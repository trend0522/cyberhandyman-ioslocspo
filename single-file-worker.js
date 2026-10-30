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

// 輸入 u 的長度上限（2 KB）。正常的地圖分享連結遠小於此。
const MAX_INPUT_LEN = 2048;

// 只允許跟隨這些地圖服務的網域（含子網域），每一跳重新導向都要檢查，
// 避免 /api/parse 被當成任意網址的開放代理。
const ALLOWED_HOST_SUFFIXES = ["apple.com", "amap.com", "baidu.com", "goo.gl", "google.com"];

function isAllowedHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  for (const d of ALLOWED_HOST_SUFFIXES) {
    if (h === d || h.endsWith("." + d)) return true;
  }
  // Google 各地區網域：google.com.tw / google.co.jp / google.de …
  return /(^|\.)google\.(?:com?\.)?[a-z]{2}$/.test(h);
}

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
  if (!isAllowedHost(h)) return false;
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
  if (text.length > MAX_INPUT_LEN) throw new Error("輸入過長（上限 2KB）");

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
const ICON_180_B64 = "iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAYAAAA9zQYyAAASEklEQVR42u2de5BUVX7HP+d2z/S8gJkBZIPFzoAgrAb2ERWxICRGd6Oru+W+aitVqWyZ0gp5bLKb1BrLbILrwhor66uMu64xZXQ3bm2yKoIMIKsDGB6LKCgCMrxmAOU5L5h333vzx+8eugdheN3b03379626xQA993T3+d7f+Z3v73HMjKd9H4UiJnD0K1DECUnUPiviRGjls0JdDoVCXQ6FQi20QqGEVuimUKFQH1qhUJdDoVBCKxTqcih0U6hQqMuhUCihFQr1oRUKtdAK3RQqFOpyKBTqcigUSmiFQl0OhW4KFQp1ORQKJbRCoT60QqEWWqGbQoVCXQ6FQl0OhUIJrVAooRWx3RSqDx0ZzFn+Xb/yKDeFilCIa0xwAV7A2LSX+Tn7tSWJ4Oes1/uAGhcl9LCS2AlM8IAHfQPyp+dDaULIObpCfs6G58OxLvCAtCtETjqQSsprTWDBPSW3yna5JHFvGnrS8vfRFXD1WJg6BuqqYcY4cByor4bKUiGodT9cD3a1ivXeeQz2d8D2o7C7FT46Af0ulCWhrETu7XnqolzQHE19VBe6oWDJmHCEhCf7xFWoq4Y5dfCHk2D6ZTB+5KWN094rxF69D17fAzuPy0NTWSLW2/PlMjolQxP6SiX0kEg4YlU7eqGmHH6/Dr7+u3D9BKgqHfxa1xdXw5gsCcl8/Anx7cbQz/jSTtbrXA82H4IXt8GKXdDSIWOVJTNjKM5G6Ef06xmKyJ19MCoFX/4U/Pk1cOXowQS2xDWXaDr9rI1hIktMPdYNP98Cv9gCLe1C7FRS3ptCCX1+GwtHiFyehDuuGkxkq0g4Jtrl346TMFnE3izEPtAJNWWysdTZU0KfFY4RErX1wKwJcP+N8OnfyVjj7E1hznz4wHe2VvvwSVi4Cv5nK1SUQKlaayX0mUiTdKBnQMjz3dnwN9cLeV3v4z7ucL1HN3ifAEs+gO+vhCMnobpMNqxDRnM0Ulg8KHGgo0+Uiodvgdl1GS04kSfJAcZA0gQWG7htKkwfB3/fAG/ug9oKefiKfT4d9Zfh0Em45nJ49U+FzGlveNyL8yV2Ilg56qrhV9+EO6+BQycy0UoldLEqGQZau+GbM+C5r8HYSiFz0ikMFcYLJMKFN8P8P4LuAQnEGI0UFqdlbu0WBWPB5zPKQtIpvE2s68O3Z8EnquC7SwN9PFBJ1EIXQeQv6Yha8LXpQmabROSYwgzHJ4zkkXxjOvzwZjjSJaF3rSksEjejow9m18PCz2eIXIhkPn3FSXvwrc9B03H4j7cksllskl5RuRyOgd4BGF8Fz34VRqYK1zKf0VIHfvWCm+FAOyxvElKnPXU5YutupD147PbMRDsmfgUFvg8PfxEmjBJt3TFK6FhuAtu64Z65cMMnC0fNuJhVyENSWh+7vbisc9EQOmEkW27WJ2HeTFEFEibenzftyYN717VwvFseXl8jhfFA2pfUywe/IBPr+vEPQCSM+NP/MAfe2CMFBOVBXrVa6AJ3NTp64evT4apxsuvPlXW2+RfZV64MiAkIXVkKf3dD8fjSsSd02oNRZfAX1w1OvifCtE83KJuyYersy9hgiBe9tbSqx63T4LPj4WR//Ekda9ku6Uge8Z3XwMTaaH1nLzu9NBijtVuWersxSzpwRa0kEtmkJz8rvzoK1cMW7f7lTLjrRagqibfbEeuq7wFP5Ll5MwcXqoYtBfpZWvamg7BsJ2zYD81tsiGzlS2JoKC2rgZmToA/vhJ+7/IM8UwERQNOYKW/OE3G2npY6hTjSurYRgoTBtp64Y6ro7PONihjDKzZBz9ZD6v2Ql9arGJpAspLBv9ORy+8dQDWNsOT62HuRJh3PcypH3zPMK20G1jpb8yAjUGuR1zFgFj70A6SSedH5GI4Brr64XtL4avPw+u7oSIJo8tlM5Z0MtXa9ko68n+jy+W1r++W3/3eUrmXY8K3nvZBvn2a5Hz3peObkRdLH9oEIe76YGk3IT+5lszNbfDXi+DNZkk9JVAyhiKkdVFsvGNkqZjRpzfC9iPwxJfFJQnTUlvF47IqKS1btE2qXFxfLXTBuBvdA/AHk8Qa2jKqMMl8oANuexY2HoBxlTLGxRDEDVSRcZVyr9uelXuHbantvW6ZGqxYRl0OCqlG0DFw0+Rw6+ys39kzAPNehqNdYun6Qwgv93tyr6Ndcu+egcFjhuV2zK6X1aTfjSepHT8Q++NygUzW6AqY/olwn1ovkNfmr4Q1e0Xf7neDZPpLfd++3GtUmdx7/spMXkZYbofvw5hKuHKMuGQmZnPv+zG00AZpoTV5jPiMYQVTrEqyvgWe2ShWbsCNQGp05d7PbJSxEiY8X9cNVq7PXg796XgGWZw4ZpsNuHDVZeH6oSZY/h9fm5vQecLIWH4E/eymB80kfVU5CiPp2fNgYk14zcWtdd78ITTughGl4LrRfQTXlTEad8GWj+Az48PR0e1KVVcNpQ74Xvy6r8fOQnu+dBO6etzgSQxjM7h0h7gzNh8j0o6nRsZauiO8zaGd7Im14kvHcWOYjKGBHtQTLqzl3/VgXYt037dujB/xg1mSkDHDzhC0udF+DI/IcOK2IUx7EoWbWBuOYmc3lZ29sLcVUoncEMBHxtrbKmNblSIMpaOiFCbVioV21IfOb0Z7nrSbHZEKh9AekEAqqY93SYNEz8uNll7iyJhNx+G6isx7CaONw4hS8FwGm2q10PkbWAk7HyLtDU+GmudHUxfoaXKSwi+SMbWmMM+scxQsSDry9Ht+7lIvvcDiRFWdfnqEVS00+SvdhbVM2y9o8mgYUyFHseWiwNYYGWtMhYwd5mT5fvA51OXIf+tcmpAEn6ZjGSsXhjIwqgzqa6EvR0QwyFj1tTJ2GCF8m7R1ok++n1RJeLkiSugIRWgv5MbfbtD4/Ia6IAciauc2SLLpT8uYCSfk3GWbEhDLfGg/S7op9CuwqP0ufHA0vAibtYy3ThNt2PVPi+JE8DlcX8a6dVqIEc/gz5Y2kQOT2eHvmFyOH6/Pc4rEe1sJvWnLjPFw4xRZsh0nus/gODLGjVNkTC+kekj7/exvh+7+TH/pOF1OHDXoEgfeP5zJvgvLm3EMfHt2blrUup6M5YSYN2JXq62HpJuUMepy5P3l+RIpbDoix7M5Jhy3w+Ylz6qDu2bC0RPy4IT9/kscufddM2WsMKvV7cOx+SCUmPi5G/gxtdClCTjYATuOhKN0ZO+gPR/mfwHmTIL2HkkgCgslCbnnnEkyhueHK9U5QU7K1o+gLIYKR2x1aCfYGDbuDrcuzy7RFSXwVHDIUHsPJEMgdTIg89hKuXdFSXibweyHetMBONgpD30ce3PErqbQD6qoU0lYsUOIHeZZg7YKZkI1NNwN106Aw52ZYy0uuAYu+L3DnXKvhrvl3qGfLBCQ99Vt8p0Y4jfvsawptJHC8hLYdliu7IPmwyR1fQ3875/B3bOkmXpnr/xf0jn7WeCGwa/p7JXfvXuW3Ku+Jnwy+74oJ139sGq3tAJzfdDkJAqrN0dvGn75TjSRPSerXe3DX4JFd8JNU0QOO94lnT7tkRfZV9qT/zveJa+9aYr87sNfknuFbpmzzilf2QS7jon/HNdWYLFt1uh6Yole3Qb33Cg9L8Jup3tKx/Vh7hVybdwPDdthfTPsa4VjXZlUTcdI6VN9LVxfB7d8StwMspo1Oiaahw/ghbeDn31tp1t4bgfStX9fKzz7W/jO3GianZtg4+YG/tu1EzIkPd4Nu44Obqc7eaz0DBmUu010leSuJ3uIdftg5QdS+BDno95ifU5h2oeqFDyzAb51XTRW+vTORDa91HGEuKPrzrw/87yMRU4Q/dFYj67OHMUR5/7QsU7w94OzVfa1wX9tzFjSqCXDhJNREWzvOtv7zvbZSDjRN3qxK9K6Zli5E0aWxf8gzthFCk+/XE/q555eK/5sIocW6tSRFE5wmeEJN//4jaxD7WM+37EvwbJWen87/EtDONXThbIpTjjw3Fuix1cXyTHJRVFTmPagthJ+vgmWbg/yi2M8uV6Qv93SBvOXQVVZfHXn4jy83s8cnvOD5TB7omwW/RhmnNmI2YAHf/VrCdqc8p0NRWCh/fj7VQSqQlUKthwU1cMx8bRa1jo/tVZkukGuhq8+dOxcj5oKeGKNLMf2HL84kdkxor0/sko+q571HfMNYmkCjpyAhSsz0lqcPp8x8NgqOBTjjDp1ObKuAVcs1wubJDwdlw2iVTU2NMPzG+Vwz7RbXHMby5rC86o5RCb//oYglTIOUl6grz/0G9kQGlN0XI5nTeF5+Zqe5DQ07oZF70VzNmDOrbOBF9+FZUWkORfdWd/nIsHIFDywHG6aGm2eRy785n4XHmuUIFJce27opvA8Ioi7jkpYvFCTdqyy8dT/wdv75dhjz6NoUdTdR9M+VFfAo43SxyPhFBYZbA71kZPw72uKKyJ49ppCinPzYBPzEw509sGDrxVe+1pbk/ij10RXTwXuRjHPqVPUn96XE6eqy+C/35Ik+EKR8TxPcq7f/VAkyOry4pTpijpSOJTklUwUloznB0W4P1gGXX3hVrarDx0TGW/VLlj0bv7LeFamW/I+vLZD9gHFKtOpbDcESapScP8ykfFGleenjJct0y1cMbgXiNFpLPJNYdblZcl4P1ubv1baynQ/fRPeOSAPobXOOo/qcnysf0VNBTzSCLuPyaYrn2S8UzLdCckYrEqpTKc+9FDLeZDgc7IX/mlJkI1n8lOm298qK4qvvrP60Oc6OH5UGbz6vmwS507OZLLlhUx3UCTGUzKdnv2mFprzkPEcA/ctlgT5fJDxrEx3/zI4qTKdbgov5LKKx6b98Pxvh3+DaGW6xVthxXaR6dKeztOZLnU5hiBRRSksWA5f+bQUmg6HjGfHHHBh4fKsEwl03tTluFAilSflJICHVg5fNp6V6Z5cIzLdiFRxZ9MpoS9RxhtZJumlwyHjWTIfOQFPrFaZTmsKL/UAIg+SRnIl7lucexnPuhsLV0BLINN5ns7LUFdSH3jO2fpgZBks2QqrmmDulNzIeF4wxu6j8EIg0w24qtKpyxGijHdvDmU8uxLct0QO4VSZTgkdejbe2y3w/IboZTwr061qgiXvSaBHs+nQSGHoR1wEMt4dn4lOxrP3THtw7ytZPaR1ntRCR9KWtw0eei06K22Vjec2yIpQpTLdhXmHY+/x9dm/iI3iG38LMy6X5CDHCfcs7o5e+NyDcrRzMbbzUtkul7KQkePY5keQjWfTQx9aAQfaoTwRz/O4taYw3zqYlsPy7fDKe8Gh9l542XS7jkqPjVFlxdc5VH3o4eufTsKBBcvCK6q12XT3vSIrQFJnRgmdy5xpK+M9uerSN4hWpmtsgsUq03FpR1LohuOiXY+qFDzeCH9yLYypurhjjbNlun98eXDRq0ItdM5lvJY2+GFDVlrnxcp062FTS5BNp2RWQg/nBvEXG6U06kKz8WyNYHsPPNCg2XQq2+XBlTBSVPvPF5GNZ2W6f10OB9uhTGU6le3yISReUwHLt8Er756/jDdIpntTQulptc56TmE+wEPI+UAD3HK1SHrnyvPwjViTexdBV39xd91XlyPfCgGsjNcMTzSeW8Y7JdPthMVbAplOO4eqy5FvrseIFDz+hpRMnY3Up3rTpeGelzTPWVWOfJbxSqVU6oGlZ48eWpnupc2wqVmLXpXQ+SzjuVBbCf+5Ftbt+XjzdGud27rh+4uhQmU6jRTmvYUwMJCGhQ3w8rwzn8P9k9XQdBguG6EJSGqhC0TGW7IVfv1Oxkrbotc9x+DfVoglV+ushKZQTqeqLIEfLYOOnsyprgALGqCzV7LpdHVU2a5g+nlUpWBzM/xsjbghCQfW7oHn1kGtHvCjsl0h5nlUV8KjK6H5uPzbvS8FllnPjtBIIQUo45Uk4cN2+OlquOEKWL0Dxo7SjWCUMDXfUU8uamKnklLs2tmbCYvrCT/al6Ngd919A9DTf9pGUL/3iAitiLz+0DGSvKRroRI6NqRWi6yRQoVCAysKJbRCoSqHQqEWWqHQSKFCoRZaoT60QqEWWqFQQisUGilUKNRCK5TQCoUSWqFQ2U6h0EihQqEuh0JdDoVCLbRCoYRWKDRSqFCohVYooRUKJbRCobKdQqGRQoVCXQ6FuhwKhVpohUIJrVBopFChUAutiCP+HxNSsPujAEtWAAAAAElFTkSuQmCC";
const ICON_512_B64 = "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";

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
const LOCATION_SPOOFER_B64 = "LyoKICog5oum5oiqIEFwcGxlIC9jbGxzL3dsb2Mg5o6l5Y+j55qE5Zue5bqU77yM6KejIEFSUEMg5bCB5YyF77yM5pS5IFdpRmkg54Ot54K55ZKM5Z+656uZ5Z2Q5qCH77yMCiAqIOWGjeaMiSBBcHBsZSDnmoTmoLzlvI/lsIHlm57ljrvov5Tlm57nu5nns7vnu5/jgIIKICoKICog5Li76KaB5rWB56iL77yaCiAqICAgQVJQQyDmi4bljIUg4oaSIHByb3RvYnVmIOino+Wtl+autSDihpIg5pu/5o2iIExvY2F0aW9uIOWtkOa2iOaBr+eahOWdkOaghy/nsr7luqYv6L+Q5Yqo54q25oCBCiAqICAg4oaSIHByb3RvYnVmIOmHjeaWsOaJk+WMhSDihpIg5oyJ5Y6f5qC85byP77yIQVJQQyAvIG1hcmtlciAvIHN5bnRoZXRpY++8ieWwgeWbngogKi8KKGZ1bmN0aW9uICgpIHsKICAidXNlIHN0cmljdCI7CgogIHZhciBERUZBVUxUX0NPTkZJRyA9IHsKICAgIC8vIFN0YXRlbGVzcyBkZWZhdWx0OiBPRkYgdW50aWwgYSBjb29yZGluYXRlIGlzIHdyaXR0ZW4gdG8gdGhlIGRldmljZSdzIG93bgogICAgLy8gJHBlcnNpc3RlbnRTdG9yZSAoYnkgdGhlIHBpY2tlcidzIHNhdmUtaW50ZXJjZXB0b3IpIG9yIGVuYWJsZWQ9dHJ1ZSBpcyBwYXNzZWQKICAgIC8vIGFzIGEgbW9kdWxlIGFyZ3VtZW50LiBUaGlzIG1ha2VzICJub3RoaW5nIHBpY2tlZCB5ZXQiIGZhbGwgdGhyb3VnaCB0byB0aGUgcmVhbAogICAgLy8gbG9jYXRpb24gaW5zdGVhZCBvZiB0aGUgYnVpbHQtaW4gQXBwbGUgUGFyayBkZWZhdWx0LiBTdGF0ZWZ1bCBtb2R1bGUgbWFuaWZlc3RzCiAgICAvLyBwYXNzIGVuYWJsZWQ9dHJ1ZSBleHBsaWNpdGx5IHRvIGtlZXAgdGhlaXIgYWx3YXlzLW9uIGJlaGF2aW9yLgogICAgZW5hYmxlZDogZmFsc2UsCiAgICBtb2RlOiAicmVzcG9uc2UiLAogICAgbGF0aXR1ZGU6IDM3LjMzNDksCiAgICBsb25naXR1ZGU6IC0xMjIuMDA5MDIsCiAgICBob3Jpem9udGFsQWNjdXJhY3k6IDM5LAogICAgdmVydGljYWxBY2N1cmFjeTogMTAwMCwKICAgIC8vIFJhbmRvbSBwZXJ0dXJiYXRpb24gcmFkaXVzIGluIG1ldHJlcyAoWXU5MTkxIHYxLjEgIuaJsOWKqOWNiuW+hCIpLiAwID0gb2ZmLiBUaGUKICAgIC8vIHJlYWwgdmFsdWUgaXMgd3JpdHRlbiBwZXItZGV2aWNlIGJ5IHRoZSBwaWNrZXIgKHNlZSBsb2NhdGlvbi1zZXR0aW5ncy5qcykuCiAgICByYW5kb21SYWRpdXM6IDAsCiAgICBhbHRpdHVkZTogNTMwLAogICAgdW5rbm93blZhbHVlNDogMywKICAgIG1vdGlvbkFjdGl2aXR5VHlwZTogNjMsCiAgICBtb3Rpb25BY3Rpdml0eUNvbmZpZGVuY2U6IDQ2NywKICAgIGZhaWxPcGVuOiB0cnVlLAogICAgZGVidWc6IGZhbHNlLAogICAgZHVtcFJhdzogZmFsc2UsCiAgICBkdW1wSGVhZGVyczogZmFsc2UsCiAgICBwcmVwYXJlSGVhZGVyczogZmFsc2UsCiAgICByYXdMaW1pdDogMAogIH07CgogIC8vIFByZWZpeCBwcmVwZW5kZWQgdG8gYSBTUE9PRkVEIChzeW50aGVzaXplZCkgcmVzcG9uc2UuIE1pcnJvcnMgdGhlIG9yaWdpbmFsIEdvCiAgLy8gYGluaXRpYWxCeXRlcyA9IDAwMDEwMDAwMDAwMTAwMDBgIGZyb20gbWFpbi5nbzoyNTMuCiAgdmFyIEFQUExFX1dMT0NfUFJFRklYID0gYnl0ZXNGcm9tQXJyYXkoWzB4MDAsIDB4MDEsIDB4MDAsIDB4MDAsIDB4MDAsIDB4MDEsIDB4MDAsIDB4MDBdKTsKCiAgLy8gU3RhYmxlIG1hcmtlciB0aGF0IHByZWNlZGVzIHRoZSBBcHBsZVdMb2MgcHJvdG9idWYgaW5zaWRlIGEgUkVBTCBBcHBsZSAvY2xscy93bG9jCiAgLy8gcmVzcG9uc2UuIEFmdGVyIHRoZSBtYXJrZXIgY29tZSAyIGJ5dGVzICh1aW50MTYgQkUgcGF5bG9hZCBsZW5ndGgpIHRoZW4gdGhlIHBheWxvYWQuCiAgdmFyIEFQUExFX1dMT0NfTUFSS0VSID0gYnl0ZXNGcm9tQXJyYXkoWzB4MDAsIDB4MDAsIDB4MDAsIDB4MDEsIDB4MDAsIDB4MDBdKTsKICB2YXIgUk9PVF9EUk9QX0ZJRUxEUyA9IHsgMzogdHJ1ZSwgNDogdHJ1ZSwgMzM6IHRydWUgfTsKICB2YXIgQ0VMTF9SRVNQT05TRV9GSUVMRFMgPSB7IDIyOiB0cnVlLCAyNDogdHJ1ZSB9OwogIHZhciBMT0NBVElPTl9SRVBMQUNFRF9GSUVMRFMgPSB7CiAgICAxOiB0cnVlLAogICAgMjogdHJ1ZSwKICAgIDM6IHRydWUsCiAgICA0OiB0cnVlLAogICAgNTogdHJ1ZSwKICAgIDY6IHRydWUsCiAgICAxMTogdHJ1ZSwKICAgIDEyOiB0cnVlCiAgfTsKCiAgZnVuY3Rpb24gYnl0ZXNGcm9tQXJyYXkodmFsdWVzKSB7CiAgICByZXR1cm4gbmV3IFVpbnQ4QXJyYXkodmFsdWVzKTsKICB9CgogIGZ1bmN0aW9uIGNvbmNhdEJ5dGVzKHBhcnRzKSB7CiAgICB2YXIgdG90YWwgPSAwOwogICAgdmFyIGk7CiAgICBmb3IgKGkgPSAwOyBpIDwgcGFydHMubGVuZ3RoOyBpICs9IDEpIHsKICAgICAgdG90YWwgKz0gcGFydHNbaV0ubGVuZ3RoOwogICAgfQoKICAgIHZhciBvdXQgPSBuZXcgVWludDhBcnJheSh0b3RhbCk7CiAgICB2YXIgb2Zmc2V0ID0gMDsKICAgIGZvciAoaSA9IDA7IGkgPCBwYXJ0cy5sZW5ndGg7IGkgKz0gMSkgewogICAgICBvdXQuc2V0KHBhcnRzW2ldLCBvZmZzZXQpOwogICAgICBvZmZzZXQgKz0gcGFydHNbaV0ubGVuZ3RoOwogICAgfQogICAgcmV0dXJuIG91dDsKICB9CgogIGZ1bmN0aW9uIGJ5dGVzRXF1YWxQcmVmaXgoYnl0ZXMsIHByZWZpeCkgewogICAgaWYgKCFieXRlcyB8fCBieXRlcy5sZW5ndGggPCBwcmVmaXgubGVuZ3RoKSB7CiAgICAgIHJldHVybiBmYWxzZTsKICAgIH0KICAgIGZvciAodmFyIGkgPSAwOyBpIDwgcHJlZml4Lmxlbmd0aDsgaSArPSAxKSB7CiAgICAgIGlmIChieXRlc1tpXSAhPT0gcHJlZml4W2ldKSB7CiAgICAgICAgcmV0dXJuIGZhbHNlOwogICAgICB9CiAgICB9CiAgICByZXR1cm4gdHJ1ZTsKICB9CgogIC8vIFNlYXJjaCBmb3IgYSBieXRlIHNlcXVlbmNlIHdpdGhpbiBieXRlczsgcmV0dXJucyBmaXJzdCBpbmRleCBvciAtMS4KICAvLyBTZWFyY2hlcyBmb3J3YXJkIHRvIHByZWZlciB0aGUgZWFybGllc3QgKG1vc3QgbGlrZWx5IGNvcnJlY3QpIG1hdGNoLgogIGZ1bmN0aW9uIGZpbmRCeXRlcyhieXRlcywgbWFya2VyKSB7CiAgICBpZiAoIWJ5dGVzIHx8ICFtYXJrZXIgfHwgbWFya2VyLmxlbmd0aCA9PT0gMCkgewogICAgICByZXR1cm4gLTE7CiAgICB9CiAgICBmb3IgKHZhciBpID0gMDsgaSA8PSBieXRlcy5sZW5ndGggLSBtYXJrZXIubGVuZ3RoOyBpICs9IDEpIHsKICAgICAgdmFyIG9rID0gdHJ1ZTsKICAgICAgZm9yICh2YXIgaiA9IDA7IGogPCBtYXJrZXIubGVuZ3RoOyBqICs9IDEpIHsKICAgICAgICBpZiAoYnl0ZXNbaSArIGpdICE9PSBtYXJrZXJbal0pIHsKICAgICAgICAgIG9rID0gZmFsc2U7CiAgICAgICAgICBicmVhazsKICAgICAgICB9CiAgICAgIH0KICAgICAgaWYgKG9rKSB7CiAgICAgICAgcmV0dXJuIGk7CiAgICAgIH0KICAgIH0KICAgIHJldHVybiAtMTsKICB9CgogIC8vIFRyeSB0byBwYXJzZSBieXRlcyBhcyBwcm90b2J1ZiBmaWVsZHMuIFJldHVybnMgZmllbGRzIGFycmF5IG9yIG51bGwgb24gZmFpbHVyZS4KICBmdW5jdGlvbiB0cnlQYXJzZUZpZWxkcyhieXRlcykgewogICAgdHJ5IHsKICAgICAgaWYgKCFieXRlcyB8fCBieXRlcy5sZW5ndGggPT09IDApIHsKICAgICAgICByZXR1cm4gbnVsbDsKICAgICAgfQogICAgICB2YXIgZmllbGRzID0gcGFyc2VGaWVsZHMoYnl0ZXMpOwogICAgICByZXR1cm4gZmllbGRzLmxlbmd0aCA+IDAgPyBmaWVsZHMgOiBudWxsOwogICAgfSBjYXRjaCAoZSkgewogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICB9CgogIGZ1bmN0aW9uIGJpbmFyeVN0cmluZ1RvQnl0ZXModmFsdWUpIHsKICAgIHZhciBvdXQgPSBuZXcgVWludDhBcnJheSh2YWx1ZS5sZW5ndGgpOwogICAgZm9yICh2YXIgaSA9IDA7IGkgPCB2YWx1ZS5sZW5ndGg7IGkgKz0gMSkgewogICAgICBvdXRbaV0gPSB2YWx1ZS5jaGFyQ29kZUF0KGkpICYgMHhmZjsKICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICBmdW5jdGlvbiBieXRlc1RvQmluYXJ5U3RyaW5nKGJ5dGVzKSB7CiAgICB2YXIgY2h1bmtTaXplID0gMHg4MDAwOwogICAgdmFyIGNodW5rcyA9IFtdOwogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBieXRlcy5sZW5ndGg7IGkgKz0gY2h1bmtTaXplKSB7CiAgICAgIHZhciBjaHVuayA9IGJ5dGVzLnN1YmFycmF5KGksIGkgKyBjaHVua1NpemUpOwogICAgICBjaHVua3MucHVzaChTdHJpbmcuZnJvbUNoYXJDb2RlLmFwcGx5KG51bGwsIEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGNodW5rKSkpOwogICAgfQogICAgcmV0dXJuIGNodW5rcy5qb2luKCIiKTsKICB9CgogIGZ1bmN0aW9uIGJ5dGVzVG9CYXNlNjQoYnl0ZXMpIHsKICAgIHZhciBhbHBoYWJldCA9ICJBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWmFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6MDEyMzQ1Njc4OSsvIjsKICAgIHZhciBvdXQgPSAiIjsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgYnl0ZXMubGVuZ3RoOyBpICs9IDMpIHsKICAgICAgdmFyIGIwID0gYnl0ZXNbaV07CiAgICAgIHZhciBiMSA9IGkgKyAxIDwgYnl0ZXMubGVuZ3RoID8gYnl0ZXNbaSArIDFdIDogMDsKICAgICAgdmFyIGIyID0gaSArIDIgPCBieXRlcy5sZW5ndGggPyBieXRlc1tpICsgMl0gOiAwOwogICAgICB2YXIgdHJpcGxldCA9IChiMCA8PCAxNikgfCAoYjEgPDwgOCkgfCBiMjsKICAgICAgb3V0ICs9IGFscGhhYmV0Wyh0cmlwbGV0ID4+IDE4KSAmIDB4M2ZdOwogICAgICBvdXQgKz0gYWxwaGFiZXRbKHRyaXBsZXQgPj4gMTIpICYgMHgzZl07CiAgICAgIG91dCArPSBpICsgMSA8IGJ5dGVzLmxlbmd0aCA/IGFscGhhYmV0Wyh0cmlwbGV0ID4+IDYpICYgMHgzZl0gOiAiPSI7CiAgICAgIG91dCArPSBpICsgMiA8IGJ5dGVzLmxlbmd0aCA/IGFscGhhYmV0W3RyaXBsZXQgJiAweDNmXSA6ICI9IjsKICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICBmdW5jdGlvbiBoZXhQcmV2aWV3KGJ5dGVzLCBsaW1pdCkgewogICAgaWYgKCFieXRlcykgewogICAgICByZXR1cm4gIjxub25lPiI7CiAgICB9CiAgICB2YXIgb3V0ID0gW107CiAgICB2YXIgbWF4ID0gTWF0aC5taW4oYnl0ZXMubGVuZ3RoLCBsaW1pdCB8fCAxNik7CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IG1heDsgaSArPSAxKSB7CiAgICAgIG91dC5wdXNoKCgiMCIgKyBieXRlc1tpXS50b1N0cmluZygxNikpLnNsaWNlKC0yKSk7CiAgICB9CiAgICByZXR1cm4gb3V0LmpvaW4oIiIpOwogIH0KCiAgZnVuY3Rpb24gYm9keVRvQnl0ZXMoYm9keSkgewogICAgaWYgKGJvZHkgPT0gbnVsbCkgewogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICAgIGlmIChib2R5IGluc3RhbmNlb2YgVWludDhBcnJheSkgewogICAgICByZXR1cm4gYm9keTsKICAgIH0KICAgIGlmICh0eXBlb2YgQXJyYXlCdWZmZXIgIT09ICJ1bmRlZmluZWQiICYmIGJvZHkgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikgewogICAgICByZXR1cm4gbmV3IFVpbnQ4QXJyYXkoYm9keSk7CiAgICB9CiAgICBpZiAodHlwZW9mIGJvZHkgPT09ICJzdHJpbmciKSB7CiAgICAgIHJldHVybiBiaW5hcnlTdHJpbmdUb0J5dGVzKGJvZHkpOwogICAgfQogICAgaWYgKHR5cGVvZiBib2R5ID09PSAib2JqZWN0IiAmJiB0eXBlb2YgYm9keS5sZW5ndGggPT09ICJudW1iZXIiKSB7CiAgICAgIHJldHVybiBuZXcgVWludDhBcnJheShib2R5KTsKICAgIH0KICAgIGlmICh0eXBlb2YgYm9keSA9PT0gIm9iamVjdCIgJiYgYm9keS5ieXRlcyAmJiB0eXBlb2YgYm9keS5ieXRlcy5sZW5ndGggPT09ICJudW1iZXIiKSB7CiAgICAgIHJldHVybiBuZXcgVWludDhBcnJheShib2R5LmJ5dGVzKTsKICAgIH0KICAgIGlmICh0eXBlb2YgYm9keSA9PT0gIm9iamVjdCIgJiYgYm9keS5kYXRhICYmIHR5cGVvZiBib2R5LmRhdGEubGVuZ3RoID09PSAibnVtYmVyIikgewogICAgICByZXR1cm4gbmV3IFVpbnQ4QXJyYXkoYm9keS5kYXRhKTsKICAgIH0KICAgIHJldHVybiBudWxsOwogIH0KCiAgZnVuY3Rpb24gbWVzc2FnZUJvZHlUb0J5dGVzKG1lc3NhZ2UpIHsKICAgIGlmICghbWVzc2FnZSkgewogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICAgIHJldHVybiAoCiAgICAgIGJvZHlUb0J5dGVzKG1lc3NhZ2UuYm9keUJ5dGVzKSB8fAogICAgICBib2R5VG9CeXRlcyhtZXNzYWdlLmJvZHkpIHx8CiAgICAgIGJvZHlUb0J5dGVzKG1lc3NhZ2UucmF3Qm9keSkgfHwKICAgICAgYm9keVRvQnl0ZXMobWVzc2FnZS5iaW5hcnlCb2R5KQogICAgKTsKICB9CgogIGZ1bmN0aW9uIHJlYWRVSW50MTZCRShieXRlcywgb2Zmc2V0KSB7CiAgICBpZiAob2Zmc2V0ICsgMiA+IGJ5dGVzLmxlbmd0aCkgewogICAgICB0aHJvdyBuZXcgRXJyb3IoInVpbnQxNiBvdXQgb2YgcmFuZ2UiKTsKICAgIH0KICAgIHJldHVybiAoYnl0ZXNbb2Zmc2V0XSA8PCA4KSB8IGJ5dGVzW29mZnNldCArIDFdOwogIH0KCiAgZnVuY3Rpb24gcmVhZFVJbnQzMkJFKGJ5dGVzLCBvZmZzZXQpIHsKICAgIGlmIChvZmZzZXQgKyA0ID4gYnl0ZXMubGVuZ3RoKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcigidWludDMyIG91dCBvZiByYW5nZSIpOwogICAgfQogICAgcmV0dXJuICgKICAgICAgKGJ5dGVzW29mZnNldF0gKiAweDEwMDAwMDApICsKICAgICAgKChieXRlc1tvZmZzZXQgKyAxXSA8PCAxNikgfCAoYnl0ZXNbb2Zmc2V0ICsgMl0gPDwgOCkgfCBieXRlc1tvZmZzZXQgKyAzXSkKICAgICkgPj4+IDA7CiAgfQoKICBmdW5jdGlvbiB3cml0ZVVJbnQxNkJFKHZhbHVlKSB7CiAgICBpZiAodmFsdWUgPCAwIHx8IHZhbHVlID4gMHhmZmZmKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcigidWludDE2IHZhbHVlIG91dCBvZiByYW5nZTogIiArIHZhbHVlKTsKICAgIH0KICAgIHJldHVybiBieXRlc0Zyb21BcnJheShbKHZhbHVlID4+IDgpICYgMHhmZiwgdmFsdWUgJiAweGZmXSk7CiAgfQoKICBmdW5jdGlvbiB3cml0ZVVJbnQzMkJFKHZhbHVlKSB7CiAgICByZXR1cm4gYnl0ZXNGcm9tQXJyYXkoWwogICAgICAodmFsdWUgPj4+IDI0KSAmIDB4ZmYsCiAgICAgICh2YWx1ZSA+Pj4gMTYpICYgMHhmZiwKICAgICAgKHZhbHVlID4+PiA4KSAmIDB4ZmYsCiAgICAgIHZhbHVlICYgMHhmZgogICAgXSk7CiAgfQoKICBmdW5jdGlvbiBhc2NpaUJ5dGVzKHZhbHVlKSB7CiAgICB2YXIgb3V0ID0gbmV3IFVpbnQ4QXJyYXkodmFsdWUubGVuZ3RoKTsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgdmFsdWUubGVuZ3RoOyBpICs9IDEpIHsKICAgICAgb3V0W2ldID0gdmFsdWUuY2hhckNvZGVBdChpKSAmIDB4N2Y7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgZnVuY3Rpb24gZW5jb2RlVmFyaW50VW5zaWduZWQodmFsdWUpIHsKICAgIHZhciB2ID0gdHlwZW9mIHZhbHVlID09PSAiYmlnaW50IiA/IHZhbHVlIDogQmlnSW50KHZhbHVlKTsKICAgIGlmICh2IDwgMG4pIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKCJuZWdhdGl2ZSB1bnNpZ25lZCB2YXJpbnQiKTsKICAgIH0KCiAgICB2YXIgb3V0ID0gW107CiAgICB3aGlsZSAodiA+PSAweDgwbikgewogICAgICBvdXQucHVzaChOdW1iZXIoKHYgJiAweDdmbikgfCAweDgwbikpOwogICAgICB2ID4+PSA3bjsKICAgIH0KICAgIG91dC5wdXNoKE51bWJlcih2KSk7CiAgICByZXR1cm4gYnl0ZXNGcm9tQXJyYXkob3V0KTsKICB9CgogIGZ1bmN0aW9uIGVuY29kZVZhcmludFNpZ25lZEludDY0KHZhbHVlKSB7CiAgICB2YXIgdiA9IHR5cGVvZiB2YWx1ZSA9PT0gImJpZ2ludCIgPyB2YWx1ZSA6IEJpZ0ludChNYXRoLnRydW5jKHZhbHVlKSk7CiAgICBpZiAodiA8IDBuKSB7CiAgICAgIHYgPSBCaWdJbnQuYXNVaW50Tig2NCwgdik7CiAgICB9CiAgICByZXR1cm4gZW5jb2RlVmFyaW50VW5zaWduZWQodik7CiAgfQoKICBmdW5jdGlvbiBkZWNvZGVWYXJpbnQoYnl0ZXMsIG9mZnNldCkgewogICAgdmFyIHJlc3VsdCA9IDBuOwogICAgdmFyIHNoaWZ0ID0gMG47CiAgICB2YXIgY3VycmVudCA9IG9mZnNldDsKCiAgICB3aGlsZSAoY3VycmVudCA8IGJ5dGVzLmxlbmd0aCkgewogICAgICB2YXIgYiA9IGJ5dGVzW2N1cnJlbnRdOwogICAgICBjdXJyZW50ICs9IDE7CiAgICAgIHJlc3VsdCB8PSBCaWdJbnQoYiAmIDB4N2YpIDw8IHNoaWZ0OwogICAgICBpZiAoKGIgJiAweDgwKSA9PT0gMCkgewogICAgICAgIHJldHVybiB7IHZhbHVlOiByZXN1bHQsIG9mZnNldDogY3VycmVudCB9OwogICAgICB9CiAgICAgIHNoaWZ0ICs9IDduOwogICAgICBpZiAoc2hpZnQgPiA3MG4pIHsKICAgICAgICB0aHJvdyBuZXcgRXJyb3IoInZhcmludCB0b28gbG9uZyIpOwogICAgICB9CiAgICB9CgogICAgdGhyb3cgbmV3IEVycm9yKCJ1bnRlcm1pbmF0ZWQgdmFyaW50Iik7CiAgfQoKICBmdW5jdGlvbiBtYWtlS2V5KGZpZWxkTnVtYmVyLCB3aXJlVHlwZSkgewogICAgcmV0dXJuIGVuY29kZVZhcmludFVuc2lnbmVkKChCaWdJbnQoZmllbGROdW1iZXIpIDw8IDNuKSB8IEJpZ0ludCh3aXJlVHlwZSkpOwogIH0KCiAgZnVuY3Rpb24gbWFrZVZhcmludEZpZWxkKGZpZWxkTnVtYmVyLCB2YWx1ZSkgewogICAgcmV0dXJuIGNvbmNhdEJ5dGVzKFttYWtlS2V5KGZpZWxkTnVtYmVyLCAwKSwgZW5jb2RlVmFyaW50U2lnbmVkSW50NjQodmFsdWUpXSk7CiAgfQoKICBmdW5jdGlvbiBtYWtlTGVuZ3RoRGVsaW1pdGVkRmllbGQoZmllbGROdW1iZXIsIHBheWxvYWQpIHsKICAgIHJldHVybiBjb25jYXRCeXRlcyhbbWFrZUtleShmaWVsZE51bWJlciwgMiksIGVuY29kZVZhcmludFVuc2lnbmVkKHBheWxvYWQubGVuZ3RoKSwgcGF5bG9hZF0pOwogIH0KCiAgZnVuY3Rpb24gcGFyc2VGaWVsZHMoYnl0ZXMpIHsKICAgIHZhciBmaWVsZHMgPSBbXTsKICAgIHZhciBvZmZzZXQgPSAwOwoKICAgIHdoaWxlIChvZmZzZXQgPCBieXRlcy5sZW5ndGgpIHsKICAgICAgdmFyIGtleVN0YXJ0ID0gb2Zmc2V0OwogICAgICB2YXIga2V5ID0gZGVjb2RlVmFyaW50KGJ5dGVzLCBvZmZzZXQpOwogICAgICBvZmZzZXQgPSBrZXkub2Zmc2V0OwoKICAgICAgdmFyIGZpZWxkTnVtYmVyID0gTnVtYmVyKGtleS52YWx1ZSA+PiAzbik7CiAgICAgIHZhciB3aXJlVHlwZSA9IE51bWJlcihrZXkudmFsdWUgJiAweDduKTsKICAgICAgaWYgKGZpZWxkTnVtYmVyID09PSAwKSB7CiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCJwcm90b2J1ZiBmaWVsZCBudW1iZXIgMCIpOwogICAgICB9CgogICAgICB2YXIgdmFsdWVTdGFydCA9IG9mZnNldDsKICAgICAgdmFyIHZhbHVlRW5kOwogICAgICBpZiAod2lyZVR5cGUgPT09IDApIHsKICAgICAgICB2YWx1ZUVuZCA9IGRlY29kZVZhcmludChieXRlcywgb2Zmc2V0KS5vZmZzZXQ7CiAgICAgIH0gZWxzZSBpZiAod2lyZVR5cGUgPT09IDEpIHsKICAgICAgICB2YWx1ZUVuZCA9IG9mZnNldCArIDg7CiAgICAgIH0gZWxzZSBpZiAod2lyZVR5cGUgPT09IDIpIHsKICAgICAgICB2YXIgbGVuZ3RoSW5mbyA9IGRlY29kZVZhcmludChieXRlcywgb2Zmc2V0KTsKICAgICAgICB2YXIgbGVuZ3RoID0gTnVtYmVyKGxlbmd0aEluZm8udmFsdWUpOwogICAgICAgIHZhbHVlU3RhcnQgPSBsZW5ndGhJbmZvLm9mZnNldDsKICAgICAgICB2YWx1ZUVuZCA9IHZhbHVlU3RhcnQgKyBsZW5ndGg7CiAgICAgIH0gZWxzZSBpZiAod2lyZVR5cGUgPT09IDUpIHsKICAgICAgICB2YWx1ZUVuZCA9IG9mZnNldCArIDQ7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCJ1bnN1cHBvcnRlZCBwcm90b2J1ZiB3aXJlIHR5cGU6ICIgKyB3aXJlVHlwZSk7CiAgICAgIH0KCiAgICAgIGlmICh2YWx1ZUVuZCA+IGJ5dGVzLmxlbmd0aCkgewogICAgICAgIHRocm93IG5ldyBFcnJvcigicHJvdG9idWYgZmllbGQgZXhjZWVkcyBidWZmZXIiKTsKICAgICAgfQoKICAgICAgZmllbGRzLnB1c2goewogICAgICAgIGZpZWxkTnVtYmVyOiBmaWVsZE51bWJlciwKICAgICAgICB3aXJlVHlwZTogd2lyZVR5cGUsCiAgICAgICAga2V5U3RhcnQ6IGtleVN0YXJ0LAogICAgICAgIHZhbHVlU3RhcnQ6IHZhbHVlU3RhcnQsCiAgICAgICAgdmFsdWVFbmQ6IHZhbHVlRW5kLAogICAgICAgIGVuZDogdmFsdWVFbmQsCiAgICAgICAgcmF3OiBieXRlcy5zbGljZShrZXlTdGFydCwgdmFsdWVFbmQpLAogICAgICAgIHZhbHVlQnl0ZXM6IGJ5dGVzLnNsaWNlKHZhbHVlU3RhcnQsIHZhbHVlRW5kKQogICAgICB9KTsKICAgICAgb2Zmc2V0ID0gdmFsdWVFbmQ7CiAgICB9CgogICAgcmV0dXJuIGZpZWxkczsKICB9CgogIGZ1bmN0aW9uIGZpcnN0RmllbGRCeU51bWJlcihmaWVsZHMsIGZpZWxkTnVtYmVyKSB7CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGZpZWxkcy5sZW5ndGg7IGkgKz0gMSkgewogICAgICBpZiAoZmllbGRzW2ldLmZpZWxkTnVtYmVyID09PSBmaWVsZE51bWJlcikgewogICAgICAgIHJldHVybiBmaWVsZHNbaV07CiAgICAgIH0KICAgIH0KICAgIHJldHVybiBudWxsOwogIH0KCiAgZnVuY3Rpb24gc2lnbmVkVmFyaW50RmllbGRWYWx1ZShmaWVsZCkgewogICAgaWYgKCFmaWVsZCB8fCBmaWVsZC53aXJlVHlwZSAhPT0gMCkgewogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICAgIHJldHVybiBCaWdJbnQuYXNJbnROKDY0LCBkZWNvZGVWYXJpbnQoZmllbGQudmFsdWVCeXRlcywgMCkudmFsdWUpOwogIH0KCiAgZnVuY3Rpb24gbG9jYXRpb25TdW1tYXJ5KGxvY2F0aW9uUGF5bG9hZCkgewogICAgdHJ5IHsKICAgICAgdmFyIGZpZWxkcyA9IHBhcnNlRmllbGRzKGxvY2F0aW9uUGF5bG9hZCk7CiAgICAgIHZhciBsYXQgPSBzaWduZWRWYXJpbnRGaWVsZFZhbHVlKGZpcnN0RmllbGRCeU51bWJlcihmaWVsZHMsIDEpKTsKICAgICAgdmFyIGxvbiA9IHNpZ25lZFZhcmludEZpZWxkVmFsdWUoZmlyc3RGaWVsZEJ5TnVtYmVyKGZpZWxkcywgMikpOwogICAgICBpZiAobGF0ID09IG51bGwgfHwgbG9uID09IG51bGwpIHsKICAgICAgICByZXR1cm4gIjxtaXNzaW5nPiI7CiAgICAgIH0KICAgICAgcmV0dXJuIChOdW1iZXIobGF0KSAvIDEwMDAwMDAwMCkudG9GaXhlZCg4KSArICIsIiArIChOdW1iZXIobG9uKSAvIDEwMDAwMDAwMCkudG9GaXhlZCg4KTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICByZXR1cm4gIjxwYXJzZS1mYWlsZWQ6IiArIGVyci5tZXNzYWdlICsgIj4iOwogICAgfQogIH0KCiAgZnVuY3Rpb24gcGF0Y2hlZFBheWxvYWRTdW1tYXJ5KHBheWxvYWQpIHsKICAgIHRyeSB7CiAgICAgIHZhciByb290RmllbGRzID0gcGFyc2VGaWVsZHMocGF5bG9hZCk7CiAgICAgIHZhciBwYXJ0cyA9IFtdOwogICAgICB2YXIgd2lmaSA9IGZpcnN0RmllbGRCeU51bWJlcihyb290RmllbGRzLCAyKTsKICAgICAgaWYgKHdpZmkgJiYgd2lmaS53aXJlVHlwZSA9PT0gMikgewogICAgICAgIHZhciB3aWZpTG9jYXRpb24gPSBmaXJzdEZpZWxkQnlOdW1iZXIocGFyc2VGaWVsZHMod2lmaS52YWx1ZUJ5dGVzKSwgMik7CiAgICAgICAgcGFydHMucHVzaCgiZmlyc3RXaWZpPSIgKyAod2lmaUxvY2F0aW9uID8gbG9jYXRpb25TdW1tYXJ5KHdpZmlMb2NhdGlvbi52YWx1ZUJ5dGVzKSA6ICI8bWlzc2luZz4iKSk7CiAgICAgIH0KICAgICAgdmFyIGNlbGwgPSBmaXJzdENlbGxSZXNwb25zZUZpZWxkKHJvb3RGaWVsZHMpOwogICAgICBpZiAoY2VsbCAmJiBjZWxsLndpcmVUeXBlID09PSAyKSB7CiAgICAgICAgdmFyIGNlbGxMb2NhdGlvbiA9IGZpcnN0RmllbGRCeU51bWJlcihwYXJzZUZpZWxkcyhjZWxsLnZhbHVlQnl0ZXMpLCA1KTsKICAgICAgICBwYXJ0cy5wdXNoKCJmaXJzdENlbGw9IiArIChjZWxsTG9jYXRpb24gPyBsb2NhdGlvblN1bW1hcnkoY2VsbExvY2F0aW9uLnZhbHVlQnl0ZXMpIDogIjxtaXNzaW5nPiIpKTsKICAgICAgfQogICAgICByZXR1cm4gcGFydHMubGVuZ3RoID8gcGFydHMuam9pbigiLCAiKSA6ICJubyB3aWZpL2NlbGwgbG9jYXRpb24gZmllbGRzIjsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICByZXR1cm4gInN1bW1hcnkgZmFpbGVkOiAiICsgZXJyLm1lc3NhZ2U7CiAgICB9CiAgfQoKICBmdW5jdGlvbiBpc0NlbGxSZXNwb25zZUZpZWxkKGZpZWxkTnVtYmVyKSB7CiAgICByZXR1cm4gQ0VMTF9SRVNQT05TRV9GSUVMRFNbZmllbGROdW1iZXJdID09PSB0cnVlOwogIH0KCiAgZnVuY3Rpb24gZmlyc3RDZWxsUmVzcG9uc2VGaWVsZChmaWVsZHMpIHsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZmllbGRzLmxlbmd0aDsgaSArPSAxKSB7CiAgICAgIGlmIChpc0NlbGxSZXNwb25zZUZpZWxkKGZpZWxkc1tpXS5maWVsZE51bWJlcikpIHsKICAgICAgICByZXR1cm4gZmllbGRzW2ldOwogICAgICB9CiAgICB9CiAgICByZXR1cm4gbnVsbDsKICB9CgogIGZ1bmN0aW9uIGNvb3JkVG9JbnQodmFsdWUpIHsKICAgIC8vIOS9v+eUqCBNYXRoLnRydW5jIOeyvuehruWMuemFjSBHbzogaW50NjQoY29vcmQgKiAxZTgpCiAgICByZXR1cm4gTWF0aC50cnVuYyhOdW1iZXIodmFsdWUpICogMTAwMDAwMDAwKTsKICB9CgogIGZ1bmN0aW9uIHBhcnNlQm9vbGVhbih2YWx1ZSwgZGVmYXVsdFZhbHVlKSB7CiAgICBpZiAodmFsdWUgPT09IHRydWUgfHwgdmFsdWUgPT09IGZhbHNlKSB7CiAgICAgIHJldHVybiB2YWx1ZTsKICAgIH0KICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICJzdHJpbmciKSB7CiAgICAgIHZhciBub3JtYWxpemVkID0gdmFsdWUudHJpbSgpLnRvTG93ZXJDYXNlKCk7CiAgICAgIGlmIChub3JtYWxpemVkID09PSAidHJ1ZSIgfHwgbm9ybWFsaXplZCA9PT0gIjEiIHx8IG5vcm1hbGl6ZWQgPT09ICJ5ZXMiIHx8IG5vcm1hbGl6ZWQgPT09ICJvbiIpIHsKICAgICAgICByZXR1cm4gdHJ1ZTsKICAgICAgfQogICAgICBpZiAobm9ybWFsaXplZCA9PT0gImZhbHNlIiB8fCBub3JtYWxpemVkID09PSAiMCIgfHwgbm9ybWFsaXplZCA9PT0gIm5vIiB8fCBub3JtYWxpemVkID09PSAib2ZmIikgewogICAgICAgIHJldHVybiBmYWxzZTsKICAgICAgfQogICAgfQogICAgcmV0dXJuIGRlZmF1bHRWYWx1ZTsKICB9CgogIGZ1bmN0aW9uIG5vcm1hbGl6ZUNvbmZpZyhpbnB1dCkgewogICAgdmFyIGNmZyA9IHt9OwogICAgdmFyIGtleTsKICAgIGZvciAoa2V5IGluIERFRkFVTFRfQ09ORklHKSB7CiAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoREVGQVVMVF9DT05GSUcsIGtleSkpIHsKICAgICAgICBjZmdba2V5XSA9IERFRkFVTFRfQ09ORklHW2tleV07CiAgICAgIH0KICAgIH0KICAgIGlucHV0ID0gaW5wdXQgfHwge307CiAgICBmb3IgKGtleSBpbiBpbnB1dCkgewogICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGlucHV0LCBrZXkpKSB7CiAgICAgICAgY2ZnW2tleV0gPSBpbnB1dFtrZXldOwogICAgICB9CiAgICB9CgogICAgY2ZnLmVuYWJsZWQgPSBwYXJzZUJvb2xlYW4oY2ZnLmVuYWJsZWQsIHRydWUpOwogICAgY2ZnLmZhaWxPcGVuID0gcGFyc2VCb29sZWFuKGNmZy5mYWlsT3BlbiwgdHJ1ZSk7CiAgICB2YXIgbW9kZSA9IFN0cmluZyhjZmcubW9kZSB8fCAicmVzcG9uc2UiKS50b0xvd2VyQ2FzZSgpOwogICAgY2ZnLm1vZGUgPSBtb2RlID09PSAicmVxdWVzdCIgfHwgbW9kZSA9PT0gInByZXBhcmUiIHx8IG1vZGUgPT09ICJwcm9iZSIgfHwgbW9kZSA9PT0gImluc3BlY3QiID8gbW9kZSA6ICJyZXNwb25zZSI7CiAgICBjZmcubGF0aXR1ZGUgPSBOdW1iZXIoY2ZnLmxhdGl0dWRlKTsKICAgIGNmZy5sb25naXR1ZGUgPSBOdW1iZXIoY2ZnLmxvbmdpdHVkZSk7CiAgICBjZmcuaG9yaXpvbnRhbEFjY3VyYWN5ID0gTWF0aC50cnVuYyhOdW1iZXIoY2ZnLmhvcml6b250YWxBY2N1cmFjeSkpOwogICAgY2ZnLnZlcnRpY2FsQWNjdXJhY3kgPSBNYXRoLnRydW5jKE51bWJlcihjZmcudmVydGljYWxBY2N1cmFjeSkpOwogICAgY2ZnLmFsdGl0dWRlID0gTWF0aC50cnVuYyhOdW1iZXIoY2ZnLmFsdGl0dWRlKSk7CiAgICBjZmcudW5rbm93blZhbHVlNCA9IE1hdGgudHJ1bmMoTnVtYmVyKGNmZy51bmtub3duVmFsdWU0KSk7CiAgICBjZmcubW90aW9uQWN0aXZpdHlUeXBlID0gTWF0aC50cnVuYyhOdW1iZXIoY2ZnLm1vdGlvbkFjdGl2aXR5VHlwZSkpOwogICAgY2ZnLm1vdGlvbkFjdGl2aXR5Q29uZmlkZW5jZSA9IE1hdGgudHJ1bmMoTnVtYmVyKGNmZy5tb3Rpb25BY3Rpdml0eUNvbmZpZGVuY2UpKTsKICAgIGNmZy5kdW1wUmF3ID0gY2ZnLmR1bXBSYXcgPT09IHRydWUgfHwgU3RyaW5nKGNmZy5kdW1wUmF3KS50b0xvd2VyQ2FzZSgpID09PSAidHJ1ZSI7CiAgICBjZmcuZHVtcEhlYWRlcnMgPSBjZmcuZHVtcEhlYWRlcnMgPT09IHRydWUgfHwgU3RyaW5nKGNmZy5kdW1wSGVhZGVycykudG9Mb3dlckNhc2UoKSA9PT0gInRydWUiOwogICAgY2ZnLnByZXBhcmVIZWFkZXJzID0gY2ZnLnByZXBhcmVIZWFkZXJzID09PSB0cnVlIHx8IFN0cmluZyhjZmcucHJlcGFyZUhlYWRlcnMpLnRvTG93ZXJDYXNlKCkgPT09ICJ0cnVlIjsKICAgIGNmZy5yYXdMaW1pdCA9IE1hdGgudHJ1bmMoTnVtYmVyKGNmZy5yYXdMaW1pdCB8fCAwKSk7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShjZmcucmF3TGltaXQpIHx8IGNmZy5yYXdMaW1pdCA8IDApIHsKICAgICAgY2ZnLnJhd0xpbWl0ID0gMDsKICAgIH0KICAgIGNmZy5yYW5kb21SYWRpdXMgPSBOdW1iZXIoY2ZnLnJhbmRvbVJhZGl1cyk7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShjZmcucmFuZG9tUmFkaXVzKSB8fCBjZmcucmFuZG9tUmFkaXVzIDwgMCkgewogICAgICBjZmcucmFuZG9tUmFkaXVzID0gMDsKICAgIH0KCiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShjZmcubGF0aXR1ZGUpIHx8IGNmZy5sYXRpdHVkZSA8IC05MCB8fCBjZmcubGF0aXR1ZGUgPiA5MCkgewogICAgICB0aHJvdyBuZXcgRXJyb3IoImludmFsaWQgbGF0aXR1ZGUiKTsKICAgIH0KICAgIGlmICghTnVtYmVyLmlzRmluaXRlKGNmZy5sb25naXR1ZGUpIHx8IGNmZy5sb25naXR1ZGUgPCAtMTgwIHx8IGNmZy5sb25naXR1ZGUgPiAxODApIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKCJpbnZhbGlkIGxvbmdpdHVkZSIpOwogICAgfQogICAgLy8gQXBwbHkgdGhlIHJhbmRvbSBvZmZzZXQgbGFzdCwgb25jZSBwZXIgcmVzcG9uc2UsIHNvIGV2ZXJ5IHBhdGNoZWQgV2lGaS9jZWxsCiAgICAvLyBsb2NhdGlvbiBpbiB0aGlzIHJlc3BvbnNlIHNoYXJlcyB0aGUgc2FtZSBqaXR0ZXJlZCBwb2ludC4gbm9ybWFsaXplQ29uZmlnIGlzIGNhbGxlZAogICAgLy8gYWdhaW4gb24gYW4gYWxyZWFkeS1ub3JtYWxpemVkIGNvbmZpZyAoc3Bvb2ZBcHBsZVJlc3BvbnNlIC8gc3Bvb2ZBcnBjUmVxdWVzdCksIHNvCiAgICAvLyBza2lwIHRoZSBqaXR0ZXIgd2hlbiBpdCB3YXMgYWxyZWFkeSBhcHBsaWVkIOKAlCBvdGhlcndpc2UgdGhlIG9mZnNldCBpcyBzdGFja2VkIHR3aWNlLgogICAgaWYgKGNmZy5yYW5kb21SYWRpdXMgPiAwICYmIGNmZy5qaXR0ZXJBcHBsaWVkICE9PSB0cnVlKSB7CiAgICAgIHZhciBqaXR0ZXJlZCA9IGFwcGx5UmFuZG9tUmFkaXVzKGNmZy5sYXRpdHVkZSwgY2ZnLmxvbmdpdHVkZSwgY2ZnLnJhbmRvbVJhZGl1cyk7CiAgICAgIGNmZy5sYXRpdHVkZSA9IGppdHRlcmVkLmxhdGl0dWRlOwogICAgICBjZmcubG9uZ2l0dWRlID0gaml0dGVyZWQubG9uZ2l0dWRlOwogICAgICBjZmcucmFuZG9tRGlzdGFuY2UgPSBqaXR0ZXJlZC5kaXN0YW5jZTsKICAgICAgY2ZnLmppdHRlckFwcGxpZWQgPSB0cnVlOwogICAgfQogICAgcmV0dXJuIGNmZzsKICB9CgogIC8vIFJhbmRvbSBwZXJ0dXJiYXRpb24gKFl1OTE5MSB2MS4xICLmibDliqjljYrlvoQiKTogb2Zmc2V0IHRoZSBwb2ludCBieSBhIHJhbmRvbSBkaXN0YW5jZSwKICAvLyB1bmlmb3JtIG92ZXIgYSBkaXNjIG9mIHRoZSBnaXZlbiByYWRpdXMgaW4gbWV0cmVzIChkaXN0YW5jZSA9IHNxcnQocmFuZCkqUiksIHVzaW5nIHRoZQogIC8vIHNwaGVyaWNhbCBkZXN0aW5hdGlvbi1wb2ludCBmb3JtdWxhIHNvIHJlcGVhdGVkIHBvc2l0aW9uaW5nIG5ldmVyIHJldHVybnMgaWRlbnRpY2FsCiAgLy8gY29vcmRpbmF0ZXMuIE1pcnJvcnMgZGlzdC93bG9jLmpzIGluIFl1OTE5MS93bG9jIGV4YWN0bHkuCiAgZnVuY3Rpb24gYXBwbHlSYW5kb21SYWRpdXMobGF0LCBsb24sIHJhZGl1c01ldGVycykgewogICAgdmFyIHIgPSBOdW1iZXIocmFkaXVzTWV0ZXJzKTsKICAgIGlmICghTnVtYmVyLmlzRmluaXRlKHIpIHx8IHIgPD0gMCkgewogICAgICByZXR1cm4geyBsYXRpdHVkZTogbGF0LCBsb25naXR1ZGU6IGxvbiwgZGlzdGFuY2U6IDAgfTsKICAgIH0KICAgIHZhciBkaXN0YW5jZSA9IE1hdGguc3FydChNYXRoLnJhbmRvbSgpKSAqIHI7CiAgICB2YXIgYmVhcmluZyA9IDIgKiBNYXRoLnJhbmRvbSgpICogTWF0aC5QSTsKICAgIHZhciBhbmd1bGFyID0gZGlzdGFuY2UgLyA2Mzc4MTM3OwogICAgdmFyIGxhdFJhZCA9IChsYXQgKiBNYXRoLlBJKSAvIDE4MDsKICAgIHZhciBsb25SYWQgPSAobG9uICogTWF0aC5QSSkgLyAxODA7CiAgICB2YXIgbmV3TGF0ID0gTWF0aC5hc2luKAogICAgICBNYXRoLnNpbihsYXRSYWQpICogTWF0aC5jb3MoYW5ndWxhcikgKwogICAgICAgIE1hdGguY29zKGxhdFJhZCkgKiBNYXRoLnNpbihhbmd1bGFyKSAqIE1hdGguY29zKGJlYXJpbmcpCiAgICApOwogICAgdmFyIG5ld0xvbiA9CiAgICAgICgobG9uUmFkICsKICAgICAgICBNYXRoLmF0YW4yKAogICAgICAgICAgTWF0aC5zaW4oYmVhcmluZykgKiBNYXRoLnNpbihhbmd1bGFyKSAqIE1hdGguY29zKGxhdFJhZCksCiAgICAgICAgICBNYXRoLmNvcyhhbmd1bGFyKSAtIE1hdGguc2luKGxhdFJhZCkgKiBNYXRoLnNpbihuZXdMYXQpCiAgICAgICAgKSArCiAgICAgICAgMyAqIE1hdGguUEkpICUKICAgICAgICAoMiAqIE1hdGguUEkpKSAtCiAgICAgIE1hdGguUEk7CiAgICByZXR1cm4gewogICAgICBsYXRpdHVkZTogTnVtYmVyKCgobmV3TGF0ICogMTgwKSAvIE1hdGguUEkpLnRvRml4ZWQoOCkpLAogICAgICBsb25naXR1ZGU6IE51bWJlcigoKG5ld0xvbiAqIDE4MCkgLyBNYXRoLlBJKS50b0ZpeGVkKDgpKSwKICAgICAgZGlzdGFuY2U6IGRpc3RhbmNlCiAgICB9OwogIH0KCiAgZnVuY3Rpb24gcGF0Y2hMb2NhdGlvbihsb2NhdGlvblBheWxvYWQsIGNvbmZpZykgewogICAgdmFyIHBhcnRzID0gW107CiAgICB2YXIgZmllbGRzID0gbG9jYXRpb25QYXlsb2FkLmxlbmd0aCA/IHBhcnNlRmllbGRzKGxvY2F0aW9uUGF5bG9hZCkgOiBbXTsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZmllbGRzLmxlbmd0aDsgaSArPSAxKSB7CiAgICAgIGlmICghTE9DQVRJT05fUkVQTEFDRURfRklFTERTW2ZpZWxkc1tpXS5maWVsZE51bWJlcl0pIHsKICAgICAgICBwYXJ0cy5wdXNoKGZpZWxkc1tpXS5yYXcpOwogICAgICB9CiAgICB9CgogICAgcGFydHMucHVzaChtYWtlVmFyaW50RmllbGQoMSwgY29vcmRUb0ludChjb25maWcubGF0aXR1ZGUpKSk7CiAgICBwYXJ0cy5wdXNoKG1ha2VWYXJpbnRGaWVsZCgyLCBjb29yZFRvSW50KGNvbmZpZy5sb25naXR1ZGUpKSk7CiAgICBwYXJ0cy5wdXNoKG1ha2VWYXJpbnRGaWVsZCgzLCBjb25maWcuaG9yaXpvbnRhbEFjY3VyYWN5KSk7CiAgICBwYXJ0cy5wdXNoKG1ha2VWYXJpbnRGaWVsZCg0LCBjb25maWcudW5rbm93blZhbHVlNCkpOwogICAgcGFydHMucHVzaChtYWtlVmFyaW50RmllbGQoNSwgY29uZmlnLmFsdGl0dWRlKSk7CiAgICBwYXJ0cy5wdXNoKG1ha2VWYXJpbnRGaWVsZCg2LCBjb25maWcudmVydGljYWxBY2N1cmFjeSkpOwogICAgcGFydHMucHVzaChtYWtlVmFyaW50RmllbGQoMTEsIGNvbmZpZy5tb3Rpb25BY3Rpdml0eVR5cGUpKTsKICAgIHBhcnRzLnB1c2gobWFrZVZhcmludEZpZWxkKDEyLCBjb25maWcubW90aW9uQWN0aXZpdHlDb25maWRlbmNlKSk7CiAgICByZXR1cm4gY29uY2F0Qnl0ZXMocGFydHMpOwogIH0KCiAgZnVuY3Rpb24gcGF0Y2hXaWZpRGV2aWNlKHdpZmlQYXlsb2FkLCBjb25maWcpIHsKICAgIHZhciBmaWVsZHMgPSBwYXJzZUZpZWxkcyh3aWZpUGF5bG9hZCk7CiAgICB2YXIgcGFydHMgPSBbXTsKICAgIHZhciBwYXRjaGVkTG9jYXRpb24gPSBmYWxzZTsKCiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGZpZWxkcy5sZW5ndGg7IGkgKz0gMSkgewogICAgICB2YXIgZmllbGQgPSBmaWVsZHNbaV07CiAgICAgIGlmIChmaWVsZC5maWVsZE51bWJlciA9PT0gMiAmJiBmaWVsZC53aXJlVHlwZSA9PT0gMikgewogICAgICAgIHBhcnRzLnB1c2gobWFrZUxlbmd0aERlbGltaXRlZEZpZWxkKDIsIHBhdGNoTG9jYXRpb24oZmllbGQudmFsdWVCeXRlcywgY29uZmlnKSkpOwogICAgICAgIHBhdGNoZWRMb2NhdGlvbiA9IHRydWU7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgcGFydHMucHVzaChmaWVsZC5yYXcpOwogICAgICB9CiAgICB9CgogICAgaWYgKCFwYXRjaGVkTG9jYXRpb24pIHsKICAgICAgcGFydHMucHVzaChtYWtlTGVuZ3RoRGVsaW1pdGVkRmllbGQoMiwgcGF0Y2hMb2NhdGlvbihieXRlc0Zyb21BcnJheShbXSksIGNvbmZpZykpKTsKICAgIH0KCiAgICByZXR1cm4gY29uY2F0Qnl0ZXMocGFydHMpOwogIH0KCiAgZnVuY3Rpb24gcGF0Y2hDZWxsVG93ZXIoY2VsbFBheWxvYWQsIGNvbmZpZykgewogICAgdmFyIGZpZWxkcyA9IHBhcnNlRmllbGRzKGNlbGxQYXlsb2FkKTsKICAgIHZhciBwYXJ0cyA9IFtdOwogICAgdmFyIHBhdGNoZWRMb2NhdGlvbiA9IGZhbHNlOwoKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZmllbGRzLmxlbmd0aDsgaSArPSAxKSB7CiAgICAgIHZhciBmaWVsZCA9IGZpZWxkc1tpXTsKICAgICAgaWYgKGZpZWxkLmZpZWxkTnVtYmVyID09PSA1ICYmIGZpZWxkLndpcmVUeXBlID09PSAyKSB7CiAgICAgICAgcGFydHMucHVzaChtYWtlTGVuZ3RoRGVsaW1pdGVkRmllbGQoNSwgcGF0Y2hMb2NhdGlvbihmaWVsZC52YWx1ZUJ5dGVzLCBjb25maWcpKSk7CiAgICAgICAgcGF0Y2hlZExvY2F0aW9uID0gdHJ1ZTsKICAgICAgfSBlbHNlIHsKICAgICAgICBwYXJ0cy5wdXNoKGZpZWxkLnJhdyk7CiAgICAgIH0KICAgIH0KCiAgICBpZiAoIXBhdGNoZWRMb2NhdGlvbikgewogICAgICBwYXJ0cy5wdXNoKG1ha2VMZW5ndGhEZWxpbWl0ZWRGaWVsZCg1LCBwYXRjaExvY2F0aW9uKGJ5dGVzRnJvbUFycmF5KFtdKSwgY29uZmlnKSkpOwogICAgfQoKICAgIHJldHVybiBjb25jYXRCeXRlcyhwYXJ0cyk7CiAgfQoKICBmdW5jdGlvbiBwYXRjaEFwcGxlV0xvY1BheWxvYWQocGF5bG9hZCwgY29uZmlnKSB7CiAgICB2YXIgZmllbGRzID0gcGFyc2VGaWVsZHMocGF5bG9hZCk7CiAgICB2YXIgcGFydHMgPSBbXTsKICAgIHZhciB3aWZpQ291bnQgPSAwOwogICAgdmFyIGNlbGxDb3VudCA9IDA7CgogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBmaWVsZHMubGVuZ3RoOyBpICs9IDEpIHsKICAgICAgdmFyIGZpZWxkID0gZmllbGRzW2ldOwogICAgICBpZiAoZmllbGQuZmllbGROdW1iZXIgPT09IDIgJiYgZmllbGQud2lyZVR5cGUgPT09IDIpIHsKICAgICAgICBwYXJ0cy5wdXNoKG1ha2VMZW5ndGhEZWxpbWl0ZWRGaWVsZCgyLCBwYXRjaFdpZmlEZXZpY2UoZmllbGQudmFsdWVCeXRlcywgY29uZmlnKSkpOwogICAgICAgIHdpZmlDb3VudCArPSAxOwogICAgICB9IGVsc2UgaWYgKGlzQ2VsbFJlc3BvbnNlRmllbGQoZmllbGQuZmllbGROdW1iZXIpICYmIGZpZWxkLndpcmVUeXBlID09PSAyKSB7CiAgICAgICAgcGFydHMucHVzaChtYWtlTGVuZ3RoRGVsaW1pdGVkRmllbGQoZmllbGQuZmllbGROdW1iZXIsIHBhdGNoQ2VsbFRvd2VyKGZpZWxkLnZhbHVlQnl0ZXMsIGNvbmZpZykpKTsKICAgICAgICBjZWxsQ291bnQgKz0gMTsKICAgICAgfSBlbHNlIGlmICghUk9PVF9EUk9QX0ZJRUxEU1tmaWVsZC5maWVsZE51bWJlcl0pIHsKICAgICAgICBwYXJ0cy5wdXNoKGZpZWxkLnJhdyk7CiAgICAgIH0KICAgIH0KCiAgICByZXR1cm4geyBwYXlsb2FkOiBjb25jYXRCeXRlcyhwYXJ0cyksIHdpZmlDb3VudDogd2lmaUNvdW50LCBjZWxsQ291bnQ6IGNlbGxDb3VudCB9OwogIH0KCiAgZnVuY3Rpb24gcmVhZFBhc2NhbFN0cmluZyhieXRlcywgc3RhdGUpIHsKICAgIHZhciBsZW5ndGggPSByZWFkVUludDE2QkUoYnl0ZXMsIHN0YXRlLm9mZnNldCk7CiAgICBzdGF0ZS5vZmZzZXQgKz0gMjsKICAgIGlmIChzdGF0ZS5vZmZzZXQgKyBsZW5ndGggPiBieXRlcy5sZW5ndGgpIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKCJBUlBDIHBhc2NhbCBzdHJpbmcgZXhjZWVkcyBidWZmZXIiKTsKICAgIH0KCiAgICB2YXIgY2hhcnMgPSBbXTsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGVuZ3RoOyBpICs9IDEpIHsKICAgICAgY2hhcnMucHVzaChTdHJpbmcuZnJvbUNoYXJDb2RlKGJ5dGVzW3N0YXRlLm9mZnNldCArIGldKSk7CiAgICB9CiAgICBzdGF0ZS5vZmZzZXQgKz0gbGVuZ3RoOwogICAgcmV0dXJuIGNoYXJzLmpvaW4oIiIpOwogIH0KCiAgZnVuY3Rpb24gd3JpdGVQYXNjYWxTdHJpbmcodmFsdWUpIHsKICAgIHZhciBieXRlcyA9IGFzY2lpQnl0ZXModmFsdWUpOwogICAgcmV0dXJuIGNvbmNhdEJ5dGVzKFt3cml0ZVVJbnQxNkJFKGJ5dGVzLmxlbmd0aCksIGJ5dGVzXSk7CiAgfQoKICBmdW5jdGlvbiBwYXJzZUFycGMoYnl0ZXMpIHsKICAgIHZhciBzdGF0ZSA9IHsgb2Zmc2V0OiAwIH07CiAgICB2YXIgdmVyc2lvbiA9IHJlYWRVSW50MTZCRShieXRlcywgc3RhdGUub2Zmc2V0KTsKICAgIHN0YXRlLm9mZnNldCArPSAyOwogICAgdmFyIGxvY2FsZSA9IHJlYWRQYXNjYWxTdHJpbmcoYnl0ZXMsIHN0YXRlKTsKICAgIHZhciBhcHBJZGVudGlmaWVyID0gcmVhZFBhc2NhbFN0cmluZyhieXRlcywgc3RhdGUpOwogICAgdmFyIG9zVmVyc2lvbiA9IHJlYWRQYXNjYWxTdHJpbmcoYnl0ZXMsIHN0YXRlKTsKICAgIHZhciBmdW5jdGlvbklkID0gcmVhZFVJbnQzMkJFKGJ5dGVzLCBzdGF0ZS5vZmZzZXQpOwogICAgc3RhdGUub2Zmc2V0ICs9IDQ7CiAgICB2YXIgcGF5bG9hZExlbmd0aCA9IHJlYWRVSW50MzJCRShieXRlcywgc3RhdGUub2Zmc2V0KTsKICAgIHN0YXRlLm9mZnNldCArPSA0OwoKICAgIGlmIChzdGF0ZS5vZmZzZXQgKyBwYXlsb2FkTGVuZ3RoID4gYnl0ZXMubGVuZ3RoKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcigiQVJQQyBwYXlsb2FkIGV4Y2VlZHMgYnVmZmVyIik7CiAgICB9CgogICAgcmV0dXJuIHsKICAgICAgdmVyc2lvbjogdmVyc2lvbiwKICAgICAgbG9jYWxlOiBsb2NhbGUsCiAgICAgIGFwcElkZW50aWZpZXI6IGFwcElkZW50aWZpZXIsCiAgICAgIG9zVmVyc2lvbjogb3NWZXJzaW9uLAogICAgICBmdW5jdGlvbklkOiBmdW5jdGlvbklkLAogICAgICBwYXlsb2FkOiBieXRlcy5zbGljZShzdGF0ZS5vZmZzZXQsIHN0YXRlLm9mZnNldCArIHBheWxvYWRMZW5ndGgpCiAgICB9OwogIH0KCiAgZnVuY3Rpb24gc2VyaWFsaXplQXJwYyhhcnBjKSB7CiAgICByZXR1cm4gY29uY2F0Qnl0ZXMoWwogICAgICB3cml0ZVVJbnQxNkJFKGFycGMudmVyc2lvbiksCiAgICAgIHdyaXRlUGFzY2FsU3RyaW5nKGFycGMubG9jYWxlKSwKICAgICAgd3JpdGVQYXNjYWxTdHJpbmcoYXJwYy5hcHBJZGVudGlmaWVyKSwKICAgICAgd3JpdGVQYXNjYWxTdHJpbmcoYXJwYy5vc1ZlcnNpb24pLAogICAgICB3cml0ZVVJbnQzMkJFKGFycGMuZnVuY3Rpb25JZCksCiAgICAgIHdyaXRlVUludDMyQkUoYXJwYy5wYXlsb2FkLmxlbmd0aCksCiAgICAgIGFycGMucGF5bG9hZAogICAgXSk7CiAgfQoKICBmdW5jdGlvbiBidWlsZEFwcGxlV0xvY1Jlc3BvbnNlKHBheWxvYWQsIHByZWZpeCkgewogICAgcmV0dXJuIGNvbmNhdEJ5dGVzKFtwcmVmaXggfHwgQVBQTEVfV0xPQ19QUkVGSVgsIHdyaXRlVUludDE2QkUocGF5bG9hZC5sZW5ndGgpLCBwYXlsb2FkXSk7CiAgfQoKICBmdW5jdGlvbiBleHRyYWN0UHJlZml4ZWRBcHBsZVdMb2NQYXlsb2FkKHJlc3BvbnNlQnl0ZXMpIHsKICAgIGlmICghcmVzcG9uc2VCeXRlcyB8fCByZXNwb25zZUJ5dGVzLmxlbmd0aCA8IDEwKSB7CiAgICAgIHJldHVybiBudWxsOwogICAgfQogICAgaWYgKHJlc3BvbnNlQnl0ZXNbMF0gIT09IDB4MDAgfHwgcmVzcG9uc2VCeXRlc1sxXSAhPT0gMHgwMSkgewogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICAgIGlmIChyZXNwb25zZUJ5dGVzWzZdICE9PSAweDAwIHx8IHJlc3BvbnNlQnl0ZXNbN10gIT09IDB4MDApIHsKICAgICAgcmV0dXJuIG51bGw7CiAgICB9CgogICAgdmFyIHBheWxvYWRMZW5ndGggPSByZWFkVUludDE2QkUocmVzcG9uc2VCeXRlcywgOCk7CiAgICB2YXIgcGF5bG9hZE9mZnNldCA9IDEwOwogICAgaWYgKHBheWxvYWRMZW5ndGggPD0gMCB8fCBwYXlsb2FkT2Zmc2V0ICsgcGF5bG9hZExlbmd0aCA+IHJlc3BvbnNlQnl0ZXMubGVuZ3RoKSB7CiAgICAgIHJldHVybiBudWxsOwogICAgfQoKICAgIHZhciBwYXlsb2FkID0gcmVzcG9uc2VCeXRlcy5zbGljZShwYXlsb2FkT2Zmc2V0LCBwYXlsb2FkT2Zmc2V0ICsgcGF5bG9hZExlbmd0aCk7CiAgICBpZiAodHJ5UGFyc2VGaWVsZHMocGF5bG9hZCkgPT09IG51bGwpIHsKICAgICAgcmV0dXJuIG51bGw7CiAgICB9CgogICAgcmV0dXJuIHsKICAgICAga2luZDogInN5bnRoZXRpYyIsCiAgICAgIHBheWxvYWQ6IHBheWxvYWQsCiAgICAgIHByZWZpeDogcmVzcG9uc2VCeXRlcy5zbGljZSgwLCA4KSwKICAgICAgc3VmZml4OiByZXNwb25zZUJ5dGVzLnNsaWNlKHBheWxvYWRPZmZzZXQgKyBwYXlsb2FkTGVuZ3RoKQogICAgfTsKICB9CgogIC8vIEV4dHJhY3QgdGhlIEFwcGxlV0xvYyBwcm90b2J1ZiBwYXlsb2FkIGZyb20gYSAvY2xscy93bG9jIHJlc3BvbnNlIGJvZHkuCiAgLy8gUmV0dXJucyBhIHR5cGVkIHJlc3VsdDogeyBraW5kLCBwYXlsb2FkLCAuLi4gfSBzbyB0aGUgY2FsbGVyIGNhbiB3cml0ZSBiYWNrCiAgLy8gaW4gdGhlIGNvcnJlY3QgZm9ybWF0LgogIC8vCiAgLy8gU3VwcG9ydGVkIHNoYXBlczoKICAvLyAgICJhcnBjIiAgICAgIOKAkyBGdWxsIEFSUEMgZW52ZWxvcGUgKHNhbWUgZm9ybWF0IGFzIHJlcXVlc3RzKS4gVGhlIHJlYWwgQXBwbGUKICAvLyAgICAgICAgICAgICAgICAgcmVzcG9uc2UgdXNlcyB0aGlzLiBDb250YWlucyBhcnBjIG1ldGFkYXRhIGZvciB3cml0ZS1iYWNrLgogIC8vICAgInN5bnRoZXRpYyIg4oCTIE91ciBvd24gc3Bvb2ZlZCByZXNwb25zZTogQVBQTEVfV0xPQ19QUkVGSVggKDggYnl0ZXMpICsgdWludDE2IGxlbi4KICAvLyAgICJtYXJrZXIiICAgIOKAkyBGYWxsYmFjazogbWFya2VyIHNlYXJjaCAwMCAwMCAwMCAwMSAwMCAwMCArIHVpbnQxNiBsZW4uCiAgLy8gICAgICAgICAgICAgICAgIEtlZXBzIHRoZSBwcmVmaXgvc3VmZml4IGJ5dGVzIGZvciB3cml0ZS1iYWNrLgogIC8vICAgImJhcmUiICAgICAg4oCTIEJhcmUgcHJvdG9idWYgcGF5bG9hZCAoZmllbGQgdGFnIDB4MTIgPSB3aWZpIGRldmljZSwgd2lyZSB0eXBlIDIpLgogIGZ1bmN0aW9uIGV4dHJhY3RBcHBsZVdMb2NQYXlsb2FkKHJlc3BvbnNlQnl0ZXMpIHsKICAgIGlmICghcmVzcG9uc2VCeXRlcyB8fCByZXNwb25zZUJ5dGVzLmxlbmd0aCA8IDIpIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKCJBcHBsZSBXTG9jIHJlc3BvbnNlIHRvbyBzaG9ydCIpOwogICAgfQoKICAgIC8vIFNoYXBlIDE6IHByZWZpeGVkIFdMb2MgcmVzcG9uc2UuIFRoZSBvcmlnaW5hbCBHbyBpbXBsZW1lbnRhdGlvbiBlbWl0cwogICAgLy8gMDAwMTAwMDAwMDAxMDAwMCwgd2hpbGUgQXBwbGUncyBsaXZlIHJlc3BvbnNlcyBtYXkgdXNlIDAwMDEwMDAwMDAwMzAwMDAuCiAgICB2YXIgcHJlZml4ZWQgPSBleHRyYWN0UHJlZml4ZWRBcHBsZVdMb2NQYXlsb2FkKHJlc3BvbnNlQnl0ZXMpOwogICAgaWYgKHByZWZpeGVkKSB7CiAgICAgIHJldHVybiBwcmVmaXhlZDsKICAgIH0KCiAgICAvLyBTaGFwZSAyOiBBUlBDIGVudmVsb3BlIOKAkyB0cnkgdGhlIHByb3BlciBzdHJ1Y3R1cmVkIHBhcnNlciBmaXJzdC4KICAgIC8vIFRoZSBBcHBsZSAvY2xscy93bG9jIHJlc3BvbnNlIHVzZXMgdGhlIHNhbWUgQVJQQyBmcmFtaW5nIGFzIHRoZSByZXF1ZXN0LgogICAgdHJ5IHsKICAgICAgdmFyIGFycGMgPSBwYXJzZUFycGMocmVzcG9uc2VCeXRlcyk7CiAgICAgIGlmIChhcnBjLnBheWxvYWQubGVuZ3RoID4gMCAmJiB0cnlQYXJzZUZpZWxkcyhhcnBjLnBheWxvYWQpICE9PSBudWxsKSB7CiAgICAgICAgcmV0dXJuIHsKICAgICAgICAgIGtpbmQ6ICJhcnBjIiwKICAgICAgICAgIHBheWxvYWQ6IGFycGMucGF5bG9hZCwKICAgICAgICAgIGFycGM6IGFycGMKICAgICAgICB9OwogICAgICB9CiAgICB9IGNhdGNoIChlKSB7CiAgICAgIC8vIEFSUEMgcGFyc2UgZmFpbGVkIOKAkyBjb250aW51ZSB3aXRoIGZhbGxiYWNrIHN0cmF0ZWdpZXMuCiAgICB9CgogICAgLy8gU2hhcGUgMzogbWFya2VyIHNlYXJjaCBmYWxsYmFjay4gVGhlIEFSUEMgZnVuY3Rpb25JZCAoMDAgMDAgMDAgMDEpIG1heSBiZQogICAgLy8gZm9sbG93ZWQgYnkgdWludDE2L3VpbnQzMiBwYXlsb2FkIGxlbmd0aC4gVHJ5IHRvIGZpbmQgYW5kIHZhbGlkYXRlLgogICAgdmFyIG1hcmtlcklkeCA9IGZpbmRCeXRlcyhyZXNwb25zZUJ5dGVzLCBBUFBMRV9XTE9DX01BUktFUik7CiAgICBpZiAobWFya2VySWR4ID49IDApIHsKICAgICAgdmFyIGxlbk9mZnNldCA9IG1hcmtlcklkeCArIEFQUExFX1dMT0NfTUFSS0VSLmxlbmd0aDsKICAgICAgaWYgKGxlbk9mZnNldCArIDIgPD0gcmVzcG9uc2VCeXRlcy5sZW5ndGgpIHsKICAgICAgICB2YXIgcmVhbExlbiA9IHJlYWRVSW50MTZCRShyZXNwb25zZUJ5dGVzLCBsZW5PZmZzZXQpOwogICAgICAgIHZhciByZWFsUGF5bG9hZE9mZnNldCA9IGxlbk9mZnNldCArIDI7CiAgICAgICAgaWYgKHJlYWxMZW4gPiAwICYmIHJlYWxQYXlsb2FkT2Zmc2V0ICsgcmVhbExlbiA8PSByZXNwb25zZUJ5dGVzLmxlbmd0aCkgewogICAgICAgICAgdmFyIGNhbmRpZGF0ZVBheWxvYWQgPSByZXNwb25zZUJ5dGVzLnNsaWNlKHJlYWxQYXlsb2FkT2Zmc2V0LCByZWFsUGF5bG9hZE9mZnNldCArIHJlYWxMZW4pOwogICAgICAgICAgLy8gT25seSBhY2NlcHQgaWYgdGhlIGNhbmRpZGF0ZSBwYXJzZXMgYXMgdmFsaWQgcHJvdG9idWYuCiAgICAgICAgICBpZiAodHJ5UGFyc2VGaWVsZHMoY2FuZGlkYXRlUGF5bG9hZCkgIT09IG51bGwpIHsKICAgICAgICAgICAgcmV0dXJuIHsKICAgICAgICAgICAgICBraW5kOiAibWFya2VyIiwKICAgICAgICAgICAgICBwYXlsb2FkOiBjYW5kaWRhdGVQYXlsb2FkLAogICAgICAgICAgICAgIHByZWZpeDogcmVzcG9uc2VCeXRlcy5zbGljZSgwLCBtYXJrZXJJZHgpLAogICAgICAgICAgICAgIG1hcmtlckFuZExlbjogcmVzcG9uc2VCeXRlcy5zbGljZShtYXJrZXJJZHgsIHJlYWxQYXlsb2FkT2Zmc2V0KSwKICAgICAgICAgICAgICBzdWZmaXg6IHJlc3BvbnNlQnl0ZXMuc2xpY2UocmVhbFBheWxvYWRPZmZzZXQgKyByZWFsTGVuKQogICAgICAgICAgICB9OwogICAgICAgICAgfQogICAgICAgIH0KICAgICAgfQogICAgfQoKICAgIC8vIFNoYXBlIDQ6IGJhcmUgcHJvdG9idWYgcGF5bG9hZCAoYmVzdCBlZmZvcnQpLgogICAgaWYgKGxvb2tzTGlrZUFwcGxlV0xvY1BheWxvYWQocmVzcG9uc2VCeXRlcykpIHsKICAgICAgcmV0dXJuIHsKICAgICAgICBraW5kOiAiYmFyZSIsCiAgICAgICAgcGF5bG9hZDogcmVzcG9uc2VCeXRlcwogICAgICB9OwogICAgfQoKICAgIHRocm93IG5ldyBFcnJvcigibWlzc2luZyBBcHBsZSBXTG9jIHJlc3BvbnNlIHByZWZpeCIpOwogIH0KCiAgLy8gSGV1cmlzdGljOiBhIHZhbGlkIEFwcGxlV0xvYyBwYXlsb2FkIHN0YXJ0cyB3aXRoIGEgcHJvdG9idWYgdGFnIHdob3NlIHdpcmUgdHlwZQogIC8vIGlzIDAgb3IgMiBhbmQgZmllbGQgbnVtYmVyIGlzID4gMC4gRmllbGQgMiAod2lmaSkgdGFnIGlzIDB4MTIuCiAgZnVuY3Rpb24gbG9va3NMaWtlQXBwbGVXTG9jUGF5bG9hZChieXRlcykgewogICAgaWYgKCFieXRlcyB8fCBieXRlcy5sZW5ndGggPT09IDApIHsKICAgICAgcmV0dXJuIGZhbHNlOwogICAgfQogICAgdmFyIHRhZyA9IGJ5dGVzWzBdOwogICAgdmFyIGZpZWxkTnVtYmVyID0gdGFnID4+IDM7CiAgICB2YXIgd2lyZVR5cGUgPSB0YWcgJiAweDc7CiAgICByZXR1cm4gZmllbGROdW1iZXIgPiAwICYmICh3aXJlVHlwZSA9PT0gMCB8fCB3aXJlVHlwZSA9PT0gMik7CiAgfQoKICBmdW5jdGlvbiBzcG9vZkFycGNSZXF1ZXN0KHJlcXVlc3RCeXRlcywgY29uZmlnSW5wdXQpIHsKICAgIHZhciBjb25maWcgPSBub3JtYWxpemVDb25maWcoY29uZmlnSW5wdXQpOwogICAgdmFyIGFycGMgPSBwYXJzZUFycGMocmVxdWVzdEJ5dGVzKTsKICAgIHZhciBwYXRjaGVkID0gcGF0Y2hBcHBsZVdMb2NQYXlsb2FkKGFycGMucGF5bG9hZCwgY29uZmlnKTsKICAgIHJldHVybiB7CiAgICAgIHJlc3BvbnNlOiBidWlsZEFwcGxlV0xvY1Jlc3BvbnNlKHBhdGNoZWQucGF5bG9hZCksCiAgICAgIHBheWxvYWQ6IHBhdGNoZWQucGF5bG9hZCwKICAgICAgd2lmaUNvdW50OiBwYXRjaGVkLndpZmlDb3VudCwKICAgICAgY2VsbENvdW50OiBwYXRjaGVkLmNlbGxDb3VudCwKICAgICAgYXJwYzogYXJwYwogICAgfTsKICB9CgogIGZ1bmN0aW9uIHNwb29mQXBwbGVSZXNwb25zZShyZXNwb25zZUJ5dGVzLCBjb25maWdJbnB1dCkgewogICAgdmFyIGNvbmZpZyA9IG5vcm1hbGl6ZUNvbmZpZyhjb25maWdJbnB1dCk7CiAgICB2YXIgZXh0cmFjdGlvbiA9IGV4dHJhY3RBcHBsZVdMb2NQYXlsb2FkKHJlc3BvbnNlQnl0ZXMpOwogICAgdmFyIHBhdGNoZWQgPSBwYXRjaEFwcGxlV0xvY1BheWxvYWQoZXh0cmFjdGlvbi5wYXlsb2FkLCBjb25maWcpOwogICAgdmFyIHJlc3BvbnNlOwoKICAgIGlmIChleHRyYWN0aW9uLmtpbmQgPT09ICJhcnBjIikgewogICAgICAvLyBXcml0ZSBiYWNrIGluIEFSUEMgZm9ybWF0LCBwcmVzZXJ2aW5nIHRoZSBvcmlnaW5hbCBlbnZlbG9wZSBtZXRhZGF0YS4KICAgICAgdmFyIGFycGNPdXQgPSB7CiAgICAgICAgdmVyc2lvbjogZXh0cmFjdGlvbi5hcnBjLnZlcnNpb24sCiAgICAgICAgbG9jYWxlOiBleHRyYWN0aW9uLmFycGMubG9jYWxlLAogICAgICAgIGFwcElkZW50aWZpZXI6IGV4dHJhY3Rpb24uYXJwYy5hcHBJZGVudGlmaWVyLAogICAgICAgIG9zVmVyc2lvbjogZXh0cmFjdGlvbi5hcnBjLm9zVmVyc2lvbiwKICAgICAgICBmdW5jdGlvbklkOiBleHRyYWN0aW9uLmFycGMuZnVuY3Rpb25JZCwKICAgICAgICBwYXlsb2FkOiBwYXRjaGVkLnBheWxvYWQKICAgICAgfTsKICAgICAgcmVzcG9uc2UgPSBzZXJpYWxpemVBcnBjKGFycGNPdXQpOwogICAgfSBlbHNlIGlmIChleHRyYWN0aW9uLmtpbmQgPT09ICJtYXJrZXIiKSB7CiAgICAgIC8vIFJlYnVpbGQ6IG9yaWdpbmFsIHByZWZpeCArIG1hcmtlciBieXRlcyArIG5ldyB1aW50MTYgbGVuICsgcGF0Y2hlZCBwYXlsb2FkICsgc3VmZml4LgogICAgICB2YXIgbmV3TGVuQnl0ZXMgPSB3cml0ZVVJbnQxNkJFKHBhdGNoZWQucGF5bG9hZC5sZW5ndGgpOwogICAgICByZXNwb25zZSA9IGNvbmNhdEJ5dGVzKFsKICAgICAgICBleHRyYWN0aW9uLnByZWZpeCwKICAgICAgICBleHRyYWN0aW9uLm1hcmtlckFuZExlbi5zbGljZSgwLCBBUFBMRV9XTE9DX01BUktFUi5sZW5ndGgpLAogICAgICAgIG5ld0xlbkJ5dGVzLAogICAgICAgIHBhdGNoZWQucGF5bG9hZCwKICAgICAgICBleHRyYWN0aW9uLnN1ZmZpeAogICAgICBdKTsKICAgIH0gZWxzZSB7CiAgICAgIC8vIHN5bnRoZXRpYyAvIGJhcmUg4oCTIHVzZSB0aGUgc2ltcGxlIHByZWZpeCBmb3JtYXQuCiAgICAgIHJlc3BvbnNlID0gYnVpbGRBcHBsZVdMb2NSZXNwb25zZShwYXRjaGVkLnBheWxvYWQsIGV4dHJhY3Rpb24ucHJlZml4KTsKICAgIH0KCiAgICByZXR1cm4gewogICAgICByZXNwb25zZTogcmVzcG9uc2UsCiAgICAgIHBheWxvYWQ6IHBhdGNoZWQucGF5bG9hZCwKICAgICAgd2lmaUNvdW50OiBwYXRjaGVkLndpZmlDb3VudCwKICAgICAgY2VsbENvdW50OiBwYXRjaGVkLmNlbGxDb3VudCwKICAgICAga2luZDogZXh0cmFjdGlvbi5raW5kLAogICAgICBwcmVmaXg6IGV4dHJhY3Rpb24ucHJlZml4ID8gaGV4UHJldmlldyhleHRyYWN0aW9uLnByZWZpeCwgOCkgOiAiIgogICAgfTsKICB9CgogIGZ1bmN0aW9uIHBhcnNlQXJndW1lbnRTdHJpbmcoYXJndW1lbnQpIHsKICAgIHZhciByZXN1bHQgPSB7fTsKICAgIGlmICghYXJndW1lbnQgfHwgdHlwZW9mIGFyZ3VtZW50ICE9PSAic3RyaW5nIikgewogICAgICByZXR1cm4gcmVzdWx0OwogICAgfQoKICAgIHZhciB0YWlsS2V5cyA9IFsKICAgICAgImRlYnVnIiwKICAgICAgIm1vZGUiLAogICAgICAiZW5hYmxlZCIsCiAgICAgICJsYXRpdHVkZSIsCiAgICAgICJsb25naXR1ZGUiLAogICAgICAiYWx0aXR1ZGUiLAogICAgICAiYWRkcmVzcyIsCiAgICAgICJjb25maWdIb3N0IiwKICAgICAgImNvbmZpZ1Rva2VuIiwKICAgICAgImhvcml6b250YWxBY2N1cmFjeSIsCiAgICAgICJ2ZXJ0aWNhbEFjY3VyYWN5IiwKICAgICAgInJhbmRvbVJhZGl1cyIsCiAgICAgICJ1bmtub3duVmFsdWU0IiwKICAgICAgIm1vdGlvbkFjdGl2aXR5VHlwZSIsCiAgICAgICJtb3Rpb25BY3Rpdml0eUNvbmZpZGVuY2UiLAogICAgICAiZmFpbE9wZW4iLAogICAgICAiZHVtcFJhdyIsCiAgICAgICJkdW1wSGVhZGVycyIsCiAgICAgICJwcmVwYXJlSGVhZGVycyIsCiAgICAgICJyYXdMaW1pdCIKICAgIF07CiAgICB2YXIgY29uZmlnVXJsS2V5ID0gImNvbmZpZ1VybD0iOwogICAgdmFyIGNvbmZpZ1VybElkeCA9IGFyZ3VtZW50LmluZGV4T2YoY29uZmlnVXJsS2V5KTsKICAgIGlmIChjb25maWdVcmxJZHggPj0gMCkgewogICAgICB2YXIgdmFsdWVTdGFydCA9IGNvbmZpZ1VybElkeCArIGNvbmZpZ1VybEtleS5sZW5ndGg7CiAgICAgIHZhciB0YWlsID0gYXJndW1lbnQuc2xpY2UodmFsdWVTdGFydCk7CiAgICAgIHZhciBlbmQgPSAtMTsKICAgICAgdmFyIGk7CiAgICAgIGZvciAoaSA9IDA7IGkgPCB0YWlsS2V5cy5sZW5ndGg7IGkgKz0gMSkgewogICAgICAgIHZhciBtYXJrZXIgPSAiJiIgKyB0YWlsS2V5c1tpXSArICI9IjsKICAgICAgICB2YXIgcG9zID0gdGFpbC5pbmRleE9mKG1hcmtlcik7CiAgICAgICAgaWYgKHBvcyA+PSAwICYmIChlbmQgPCAwIHx8IHBvcyA8IGVuZCkpIHsKICAgICAgICAgIGVuZCA9IHBvczsKICAgICAgICB9CiAgICAgIH0KICAgICAgdmFyIGNvbmZpZ1VybFZhbHVlID0gZW5kID49IDAgPyB0YWlsLnNsaWNlKDAsIGVuZCkgOiB0YWlsOwogICAgICB0cnkgewogICAgICAgIHJlc3VsdC5jb25maWdVcmwgPSBkZWNvZGVVUklDb21wb25lbnQoY29uZmlnVXJsVmFsdWUpOwogICAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgICByZXN1bHQuY29uZmlnVXJsID0gY29uZmlnVXJsVmFsdWU7CiAgICAgIH0KICAgICAgYXJndW1lbnQgPSBhcmd1bWVudC5zbGljZSgwLCBjb25maWdVcmxJZHgpICsgKGVuZCA+PSAwID8gdGFpbC5zbGljZShlbmQgKyAxKSA6ICIiKTsKICAgIH0KCiAgICB2YXIgcGFpcnMgPSBhcmd1bWVudC5zcGxpdCgvWyY7XS8pOwogICAgZm9yICh2YXIgaiA9IDA7IGogPCBwYWlycy5sZW5ndGg7IGogKz0gMSkgewogICAgICB2YXIgcGFydCA9IHBhaXJzW2pdOwogICAgICBpZiAoIXBhcnQpIHsKICAgICAgICBjb250aW51ZTsKICAgICAgfQogICAgICB2YXIgZXEgPSBwYXJ0LmluZGV4T2YoIj0iKTsKICAgICAgdmFyIGtleSA9IGVxID49IDAgPyBwYXJ0LnNsaWNlKDAsIGVxKSA6IHBhcnQ7CiAgICAgIHZhciB2YWx1ZSA9IGVxID49IDAgPyBwYXJ0LnNsaWNlKGVxICsgMSkgOiAidHJ1ZSI7CiAgICAgIHRyeSB7CiAgICAgICAgcmVzdWx0W2RlY29kZVVSSUNvbXBvbmVudChrZXkpXSA9IGRlY29kZVVSSUNvbXBvbmVudCh2YWx1ZSk7CiAgICAgIH0gY2F0Y2ggKGVycjIpIHsKICAgICAgICByZXN1bHRba2V5XSA9IHZhbHVlOwogICAgICB9CiAgICB9CiAgICByZXR1cm4gcmVzdWx0OwogIH0KCiAgZnVuY3Rpb24gcmVzb2x2ZUNvbmZpZ1VybChhcmdzKSB7CiAgICBhcmdzID0gYXJncyB8fCB7fTsKICAgIHZhciBkaXJlY3QgPSBTdHJpbmcoYXJncy5jb25maWdVcmwgfHwgYXJncy5jZmcgfHwgYXJncy51cmwgfHwgIiIpLnRyaW0oKTsKICAgIGlmIChkaXJlY3QpIHsKICAgICAgcmV0dXJuIGRpcmVjdDsKICAgIH0KICAgIHZhciBob3N0ID0gU3RyaW5nKGFyZ3MuY29uZmlnSG9zdCB8fCAiIikudHJpbSgpLnJlcGxhY2UoL1wvKyQvLCAiIik7CiAgICB2YXIgdG9rZW4gPSBTdHJpbmcoYXJncy5jb25maWdUb2tlbiB8fCAiIikudHJpbSgpOwogICAgaWYgKGhvc3QgJiYgdG9rZW4pIHsKICAgICAgcmV0dXJuIGhvc3QgKyAiL2xvYy5qc29uP3Rva2VuPSIgKyBlbmNvZGVVUklDb21wb25lbnQodG9rZW4pOwogICAgfQogICAgcmV0dXJuICIiOwogIH0KCiAgZnVuY3Rpb24gaXNQbGFjZWhvbGRlclZhbHVlKHZhbHVlKSB7CiAgICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSAic3RyaW5nIiAmJiAvXlx7W159XStcfSQvLnRlc3QodmFsdWUudHJpbSgpKTsKICB9CgogIGZ1bmN0aW9uIHJlYWRQbHVnaW5TdG9yZUFyZyhuYW1lKSB7CiAgICBpZiAodHlwZW9mICRwZXJzaXN0ZW50U3RvcmUgPT09ICJ1bmRlZmluZWQiIHx8ICEkcGVyc2lzdGVudFN0b3JlLnJlYWQpIHsKICAgICAgcmV0dXJuIG51bGw7CiAgICB9CiAgICB0cnkgewogICAgICB2YXIgdmFsdWUgPSAkcGVyc2lzdGVudFN0b3JlLnJlYWQobmFtZSk7CiAgICAgIGlmICh2YWx1ZSA9PSBudWxsIHx8IHZhbHVlID09PSAiIikgewogICAgICAgIHJldHVybiBudWxsOwogICAgICB9CiAgICAgIHJldHVybiBTdHJpbmcodmFsdWUpOwogICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgIHJldHVybiBudWxsOwogICAgfQogIH0KCiAgZnVuY3Rpb24gZW5yaWNoQXJnc0Zyb21QbHVnaW5TdG9yZShhcmdzKSB7CiAgICB2YXIga2V5cyA9IFsKICAgICAgImVuYWJsZWQiLAogICAgICAibGF0aXR1ZGUiLAogICAgICAibG9uZ2l0dWRlIiwKICAgICAgImFsdGl0dWRlIiwKICAgICAgImhvcml6b250YWxBY2N1cmFjeSIsCiAgICAgICJ2ZXJ0aWNhbEFjY3VyYWN5IiwKICAgICAgInJhbmRvbVJhZGl1cyIsCiAgICAgICJhZGRyZXNzIiwKICAgICAgImNvbmZpZ0hvc3QiLAogICAgICAiY29uZmlnVG9rZW4iLAogICAgICAiY29uZmlnVXJsIiwKICAgICAgImRlYnVnIgogICAgXTsKICAgIHZhciBpOwogICAgYXJncyA9IGFyZ3MgfHwge307CiAgICBmb3IgKGkgPSAwOyBpIDwga2V5cy5sZW5ndGg7IGkgKz0gMSkgewogICAgICB2YXIga2V5ID0ga2V5c1tpXTsKICAgICAgdmFyIGN1cnJlbnQgPSBhcmdzW2tleV07CiAgICAgIGlmIChjdXJyZW50ID09IG51bGwgfHwgY3VycmVudCA9PT0gIiIgfHwgaXNQbGFjZWhvbGRlclZhbHVlKGN1cnJlbnQpKSB7CiAgICAgICAgdmFyIHN0b3JlZCA9IHJlYWRQbHVnaW5TdG9yZUFyZyhrZXkpOwogICAgICAgIGlmIChzdG9yZWQgIT0gbnVsbCAmJiAhaXNQbGFjZWhvbGRlclZhbHVlKHN0b3JlZCkpIHsKICAgICAgICAgIGFyZ3Nba2V5XSA9IHN0b3JlZDsKICAgICAgICB9CiAgICAgIH0KICAgIH0KICAgIHJldHVybiBhcmdzOwogIH0KCiAgZnVuY3Rpb24gcmVhZFNjcmlwdEFyZ3VtZW50cygpIHsKICAgIHZhciBvdXQgPSB7fTsKICAgIGlmICh0eXBlb2YgJGFyZ3VtZW50ICE9PSAidW5kZWZpbmVkIiAmJiAkYXJndW1lbnQgIT0gbnVsbCkgewogICAgICBpZiAodHlwZW9mICRhcmd1bWVudCA9PT0gInN0cmluZyIpIHsKICAgICAgICBvdXQgPSBwYXJzZUFyZ3VtZW50U3RyaW5nKCRhcmd1bWVudCk7CiAgICAgIH0gZWxzZSBpZiAodHlwZW9mICRhcmd1bWVudCA9PT0gIm9iamVjdCIpIHsKICAgICAgICB2YXIga2V5OwogICAgICAgIGZvciAoa2V5IGluICRhcmd1bWVudCkgewogICAgICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbCgkYXJndW1lbnQsIGtleSkpIHsKICAgICAgICAgICAgdmFyIHZhbHVlID0gJGFyZ3VtZW50W2tleV07CiAgICAgICAgICAgIG91dFtrZXldID0gdmFsdWUgPT0gbnVsbCA/ICIiIDogU3RyaW5nKHZhbHVlKTsKICAgICAgICAgIH0KICAgICAgICB9CiAgICAgIH0gZWxzZSB7CiAgICAgICAgb3V0ID0gcGFyc2VBcmd1bWVudFN0cmluZyhTdHJpbmcoJGFyZ3VtZW50KSk7CiAgICAgIH0KICAgIH0KICAgIHJldHVybiBlbnJpY2hBcmdzRnJvbVBsdWdpblN0b3JlKG91dCk7CiAgfQoKICBmdW5jdGlvbiBsb2dTY3JpcHRBcmd1bWVudHMoZGVidWcpIHsKICAgIGlmICghZGVidWcpIHsKICAgICAgcmV0dXJuOwogICAgfQogICAgdmFyIGFyZ3MgPSByZWFkU2NyaXB0QXJndW1lbnRzKCk7CiAgICB2YXIgcmF3ID0KICAgICAgdHlwZW9mICRhcmd1bWVudCA9PT0gInVuZGVmaW5lZCIgfHwgJGFyZ3VtZW50ID09IG51bGwKICAgICAgICA/ICI8bm9uZT4iCiAgICAgICAgOiB0eXBlb2YgJGFyZ3VtZW50ID09PSAib2JqZWN0IgogICAgICAgICAgPyBKU09OLnN0cmluZ2lmeSgkYXJndW1lbnQpCiAgICAgICAgICA6IFN0cmluZygkYXJndW1lbnQpOwogICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgJGFyZ3VtZW50IHJhdzogIiArIHJhdyk7CiAgICBjb25zb2xlLmxvZygKICAgICAgIkxvY2F0aW9uIHNwb29mZXIgYXJncyBwYXJzZWQ6IGxhdD0iICsKICAgICAgICBhcmdzLmxhdGl0dWRlICsKICAgICAgICAiLCBsbmc9IiArCiAgICAgICAgYXJncy5sb25naXR1ZGUgKwogICAgICAgICIsIGNvbmZpZ1VybD0iICsKICAgICAgICAocmVzb2x2ZUNvbmZpZ1VybChhcmdzKSB8fCAiPG5vbmU+IikKICAgICk7CiAgfQoKICBmdW5jdGlvbiBkZXRlY3RSdW50aW1lKCkgewogICAgaWYgKHR5cGVvZiAkZW52aXJvbm1lbnQgIT09ICJ1bmRlZmluZWQiICYmICRlbnZpcm9ubWVudCAmJiAkZW52aXJvbm1lbnQucHJvZHVjdCkgewogICAgICByZXR1cm4gU3RyaW5nKCRlbnZpcm9ubWVudC5wcm9kdWN0KTsKICAgIH0KICAgIGlmICh0eXBlb2YgJGxvb24gIT09ICJ1bmRlZmluZWQiKSB7CiAgICAgIHJldHVybiAiTG9vbiI7CiAgICB9CiAgICByZXR1cm4gIlVua25vd24iOwogIH0KCiAgZnVuY3Rpb24gaXNMb29uUnVudGltZSgpIHsKICAgIHJldHVybiBkZXRlY3RSdW50aW1lKCkgPT09ICJMb29uIjsKICB9CgogIGZ1bmN0aW9uIGlzR3ppcEJ5dGVzKGJ5dGVzKSB7CiAgICByZXR1cm4gYnl0ZXMgJiYgYnl0ZXMubGVuZ3RoID49IDIgJiYgYnl0ZXNbMF0gPT09IDB4MWYgJiYgYnl0ZXNbMV0gPT09IDB4OGI7CiAgfQoKICBmdW5jdGlvbiByZWFkR2VvY29kZUNhY2hlKCkgewogICAgaWYgKHR5cGVvZiAkcGVyc2lzdGVudFN0b3JlID09PSAidW5kZWZpbmVkIiB8fCAhJHBlcnNpc3RlbnRTdG9yZS5yZWFkKSB7CiAgICAgIHJldHVybiBudWxsOwogICAgfQogICAgdHJ5IHsKICAgICAgdmFyIHJhdyA9ICRwZXJzaXN0ZW50U3RvcmUucmVhZCgibG9jYXRpb25fc3Bvb2Zlcl9nZW9jb2RlIik7CiAgICAgIHJldHVybiByYXcgPyBKU09OLnBhcnNlKHJhdykgOiBudWxsOwogICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgIHJldHVybiBudWxsOwogICAgfQogIH0KCiAgZnVuY3Rpb24gd3JpdGVHZW9jb2RlQ2FjaGUoZW50cnkpIHsKICAgIGlmICh0eXBlb2YgJHBlcnNpc3RlbnRTdG9yZSA9PT0gInVuZGVmaW5lZCIgfHwgISRwZXJzaXN0ZW50U3RvcmUud3JpdGUpIHsKICAgICAgcmV0dXJuOwogICAgfQogICAgdHJ5IHsKICAgICAgJHBlcnNpc3RlbnRTdG9yZS53cml0ZSgibG9jYXRpb25fc3Bvb2Zlcl9nZW9jb2RlIiwgSlNPTi5zdHJpbmdpZnkoZW50cnkpKTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICAvLyBpZ25vcmUgY2FjaGUgd3JpdGUgZmFpbHVyZXMKICAgIH0KICB9CgogIGZ1bmN0aW9uIGZldGNoRWxldmF0aW9uKGxhdCwgbG5nLCBjYWxsYmFjaykgewogICAgaWYgKHR5cGVvZiAkaHR0cENsaWVudCA9PT0gInVuZGVmaW5lZCIgfHwgISRodHRwQ2xpZW50LmdldCkgewogICAgICBjYWxsYmFjayhudWxsKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgdmFyIHVybCA9CiAgICAgICJodHRwczovL2FwaS5vcGVuLW1ldGVvLmNvbS92MS9lbGV2YXRpb24/bGF0aXR1ZGU9IiArCiAgICAgIGVuY29kZVVSSUNvbXBvbmVudChTdHJpbmcobGF0KSkgKwogICAgICAiJmxvbmdpdHVkZT0iICsKICAgICAgZW5jb2RlVVJJQ29tcG9uZW50KFN0cmluZyhsbmcpKTsKICAgICRodHRwQ2xpZW50LmdldCh7IHVybDogdXJsLCB0aW1lb3V0OiA0MDAwIH0sIGZ1bmN0aW9uIChlcnJvciwgcmVzcG9uc2UsIGJvZHkpIHsKICAgICAgaWYgKGVycm9yIHx8ICFib2R5KSB7CiAgICAgICAgY2FsbGJhY2sobnVsbCk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIHRyeSB7CiAgICAgICAgdmFyIGRhdGEgPSBKU09OLnBhcnNlKGJvZHkpOwogICAgICAgIGlmIChkYXRhICYmIGRhdGEuZWxldmF0aW9uICYmIGRhdGEuZWxldmF0aW9uLmxlbmd0aCkgewogICAgICAgICAgY2FsbGJhY2soTWF0aC5yb3VuZChOdW1iZXIoZGF0YS5lbGV2YXRpb25bMF0pKSk7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQogICAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgICAvLyBpZ25vcmUgcGFyc2UgZmFpbHVyZXMKICAgICAgfQogICAgICBjYWxsYmFjayhudWxsKTsKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gZ2VvY29kZUFkZHJlc3MoYWRkcmVzcywgZGVidWcsIGNhbGxiYWNrKSB7CiAgICB2YXIgcXVlcnkgPSBTdHJpbmcoYWRkcmVzcyB8fCAiIikudHJpbSgpOwogICAgaWYgKCFxdWVyeSkgewogICAgICBjYWxsYmFjayhudWxsKTsKICAgICAgcmV0dXJuOwogICAgfQoKICAgIHZhciBjYWNoZWQgPSByZWFkR2VvY29kZUNhY2hlKCk7CiAgICBpZiAoY2FjaGVkICYmIGNhY2hlZC5hZGRyZXNzID09PSBxdWVyeSAmJiBOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKGNhY2hlZC5sYXRpdHVkZSkpICYmIE51bWJlci5pc0Zpbml0ZShOdW1iZXIoY2FjaGVkLmxvbmdpdHVkZSkpKSB7CiAgICAgIGlmIChkZWJ1ZykgewogICAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIGdlb2NvZGUgY2FjaGUgaGl0OiAiICsgcXVlcnkgKyAiIC0+ICIgKyBjYWNoZWQubGF0aXR1ZGUgKyAiLCIgKyBjYWNoZWQubG9uZ2l0dWRlKTsKICAgICAgfQogICAgICBjYWxsYmFjayhjYWNoZWQpOwogICAgICByZXR1cm47CiAgICB9CgogICAgaWYgKHR5cGVvZiAkaHR0cENsaWVudCA9PT0gInVuZGVmaW5lZCIgfHwgISRodHRwQ2xpZW50LmdldCkgewogICAgICBpZiAoZGVidWcpIHsKICAgICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBnZW9jb2RlIHNraXBwZWQ6ICRodHRwQ2xpZW50IHVuYXZhaWxhYmxlIik7CiAgICAgIH0KICAgICAgY2FsbGJhY2sobnVsbCk7CiAgICAgIHJldHVybjsKICAgIH0KCiAgICB2YXIgdXJsID0KICAgICAgImh0dHBzOi8vbm9taW5hdGltLm9wZW5zdHJlZXRtYXAub3JnL3NlYXJjaD9mb3JtYXQ9anNvbiZsaW1pdD0xJmFkZHJlc3NkZXRhaWxzPTAmcT0iICsKICAgICAgZW5jb2RlVVJJQ29tcG9uZW50KHF1ZXJ5KTsKICAgICRodHRwQ2xpZW50LmdldCgKICAgICAgewogICAgICAgIHVybDogdXJsLAogICAgICAgIHRpbWVvdXQ6IDgwMDAsCiAgICAgICAgaGVhZGVyczogeyAiVXNlci1BZ2VudCI6ICJpb3MtbG9jYXRpb24tc3Bvb2Zlci8xLjAgKExvb24gcGx1Z2luKSIgfQogICAgICB9LAogICAgICBmdW5jdGlvbiAoZXJyb3IsIHJlc3BvbnNlLCBib2R5KSB7CiAgICAgICAgaWYgKGVycm9yIHx8ICFib2R5KSB7CiAgICAgICAgICBpZiAoZGVidWcpIHsKICAgICAgICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgZ2VvY29kZSBmYWlsZWQ6ICIgKyAoZXJyb3IgfHwgImVtcHR5IGJvZHkiKSk7CiAgICAgICAgICB9CiAgICAgICAgICBjYWxsYmFjayhudWxsKTsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgICAgdHJ5IHsKICAgICAgICAgIHZhciByZXN1bHRzID0gSlNPTi5wYXJzZShib2R5KTsKICAgICAgICAgIGlmICghcmVzdWx0cyB8fCAhcmVzdWx0cy5sZW5ndGgpIHsKICAgICAgICAgICAgaWYgKGRlYnVnKSB7CiAgICAgICAgICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgZ2VvY29kZSBubyByZXN1bHQgZm9yOiAiICsgcXVlcnkpOwogICAgICAgICAgICB9CiAgICAgICAgICAgIGNhbGxiYWNrKG51bGwpOwogICAgICAgICAgICByZXR1cm47CiAgICAgICAgICB9CiAgICAgICAgICB2YXIgaGl0ID0gcmVzdWx0c1swXTsKICAgICAgICAgIHZhciBsYXQgPSBOdW1iZXIoaGl0LmxhdCk7CiAgICAgICAgICB2YXIgbG5nID0gTnVtYmVyKGhpdC5sb24pOwogICAgICAgICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUobGF0KSB8fCAhTnVtYmVyLmlzRmluaXRlKGxuZykpIHsKICAgICAgICAgICAgY2FsbGJhY2sobnVsbCk7CiAgICAgICAgICAgIHJldHVybjsKICAgICAgICAgIH0KICAgICAgICAgIHZhciBlbnRyeSA9IHsKICAgICAgICAgICAgYWRkcmVzczogcXVlcnksCiAgICAgICAgICAgIGxhdGl0dWRlOiBsYXQsCiAgICAgICAgICAgIGxvbmdpdHVkZTogbG5nLAogICAgICAgICAgICBkaXNwbGF5TmFtZTogaGl0LmRpc3BsYXlfbmFtZSB8fCBxdWVyeQogICAgICAgICAgfTsKICAgICAgICAgIGZldGNoRWxldmF0aW9uKGxhdCwgbG5nLCBmdW5jdGlvbiAoYWx0aXR1ZGUpIHsKICAgICAgICAgICAgaWYgKGFsdGl0dWRlICE9IG51bGwpIHsKICAgICAgICAgICAgICBlbnRyeS5hbHRpdHVkZSA9IGFsdGl0dWRlOwogICAgICAgICAgICB9CiAgICAgICAgICAgIHdyaXRlR2VvY29kZUNhY2hlKGVudHJ5KTsKICAgICAgICAgICAgaWYgKGRlYnVnKSB7CiAgICAgICAgICAgICAgY29uc29sZS5sb2coCiAgICAgICAgICAgICAgICAiTG9jYXRpb24gc3Bvb2ZlciBnZW9jb2RlIHJlc29sdmVkOiAiICsKICAgICAgICAgICAgICAgICAgcXVlcnkgKwogICAgICAgICAgICAgICAgICAiIC0+ICIgKwogICAgICAgICAgICAgICAgICBsYXQgKwogICAgICAgICAgICAgICAgICAiLCIgKwogICAgICAgICAgICAgICAgICBsbmcgKwogICAgICAgICAgICAgICAgICAoYWx0aXR1ZGUgIT0gbnVsbCA/ICIsIGFsdD0iICsgYWx0aXR1ZGUgOiAiIikKICAgICAgICAgICAgICApOwogICAgICAgICAgICB9CiAgICAgICAgICAgIGNhbGxiYWNrKGVudHJ5KTsKICAgICAgICAgIH0pOwogICAgICAgIH0gY2F0Y2ggKGVycikgewogICAgICAgICAgaWYgKGRlYnVnKSB7CiAgICAgICAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIGdlb2NvZGUgcGFyc2UgZmFpbGVkOiAiICsgZXJyLm1lc3NhZ2UpOwogICAgICAgICAgfQogICAgICAgICAgY2FsbGJhY2sobnVsbCk7CiAgICAgICAgfQogICAgICB9CiAgICApOwogIH0KCiAgZnVuY3Rpb24gbWVyZ2VDb25maWcoYmFzZSwgZXh0cmEpIHsKICAgIHZhciBvdXQgPSB7fTsKICAgIHZhciBrZXk7CiAgICBmb3IgKGtleSBpbiBiYXNlKSB7CiAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoYmFzZSwga2V5KSkgewogICAgICAgIG91dFtrZXldID0gYmFzZVtrZXldOwogICAgICB9CiAgICB9CiAgICBleHRyYSA9IGV4dHJhIHx8IHt9OwogICAgZm9yIChrZXkgaW4gZXh0cmEpIHsKICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChleHRyYSwga2V5KSkgewogICAgICAgIG91dFtrZXldID0gZXh0cmFba2V5XTsKICAgICAgfQogICAgfQogICAgcmV0dXJuIG91dDsKICB9CgogIGZ1bmN0aW9uIGRlY29kZUJhc2U2NCh2YWx1ZSkgewogICAgaWYgKHR5cGVvZiBhdG9iID09PSAiZnVuY3Rpb24iKSB7CiAgICAgIHJldHVybiBhdG9iKHZhbHVlKTsKICAgIH0KICAgIGlmICh0eXBlb2YgQnVmZmVyICE9PSAidW5kZWZpbmVkIikgewogICAgICByZXR1cm4gQnVmZmVyLmZyb20odmFsdWUsICJiYXNlNjQiKS50b1N0cmluZygidXRmOCIpOwogICAgfQogICAgdGhyb3cgbmV3IEVycm9yKCJiYXNlNjQgZGVjb2RlciB1bmF2YWlsYWJsZSIpOwogIH0KCiAgZnVuY3Rpb24gY29uZmlnRnJvbUFyZ3MoYXJncykgewogICAgdmFyIGNmZyA9IHt9OwogICAgdmFyIHNjYWxhcktleXMgPSBbCiAgICAgICJlbmFibGVkIiwKICAgICAgIm1vZGUiLAogICAgICAibGF0aXR1ZGUiLAogICAgICAibG9uZ2l0dWRlIiwKICAgICAgImFkZHJlc3MiLAogICAgICAiaG9yaXpvbnRhbEFjY3VyYWN5IiwKICAgICAgInZlcnRpY2FsQWNjdXJhY3kiLAogICAgICAicmFuZG9tUmFkaXVzIiwKICAgICAgImFsdGl0dWRlIiwKICAgICAgInVua25vd25WYWx1ZTQiLAogICAgICAibW90aW9uQWN0aXZpdHlUeXBlIiwKICAgICAgIm1vdGlvbkFjdGl2aXR5Q29uZmlkZW5jZSIsCiAgICAgICJmYWlsT3BlbiIsCiAgICAgICJkZWJ1ZyIsCiAgICAgICJkdW1wUmF3IiwKICAgICAgImR1bXBIZWFkZXJzIiwKICAgICAgInByZXBhcmVIZWFkZXJzIiwKICAgICAgInJhd0xpbWl0IgogICAgXTsKCiAgICBpZiAoYXJncy5jb25maWcpIHsKICAgICAgY2ZnID0gbWVyZ2VDb25maWcoY2ZnLCBKU09OLnBhcnNlKGFyZ3MuY29uZmlnKSk7CiAgICB9CiAgICBpZiAoYXJncy5jb25maWdCYXNlNjQpIHsKICAgICAgY2ZnID0gbWVyZ2VDb25maWcoY2ZnLCBKU09OLnBhcnNlKGRlY29kZUJhc2U2NChhcmdzLmNvbmZpZ0Jhc2U2NCkpKTsKICAgIH0KICAgIGZvciAodmFyIGkgPSAwOyBpIDwgc2NhbGFyS2V5cy5sZW5ndGg7IGkgKz0gMSkgewogICAgICB2YXIga2V5ID0gc2NhbGFyS2V5c1tpXTsKICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChhcmdzLCBrZXkpKSB7CiAgICAgICAgY2ZnW2tleV0gPSBhcmdzW2tleV07CiAgICAgIH0KICAgIH0KICAgIHJldHVybiBjZmc7CiAgfQoKICBmdW5jdGlvbiByZWFkUmVtb3RlQ29uZmlnQ2FjaGUodXJsKSB7CiAgICBpZiAoIXVybCB8fCB0eXBlb2YgJHBlcnNpc3RlbnRTdG9yZSA9PT0gInVuZGVmaW5lZCIgfHwgISRwZXJzaXN0ZW50U3RvcmUucmVhZCkgewogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICAgIHRyeSB7CiAgICAgIHZhciByYXcgPSAkcGVyc2lzdGVudFN0b3JlLnJlYWQoImxvY2F0aW9uX3Nwb29mZXJfcmVtb3RlX2NmZyIpOwogICAgICBpZiAoIXJhdykgewogICAgICAgIHJldHVybiBudWxsOwogICAgICB9CiAgICAgIHZhciBlbnRyeSA9IEpTT04ucGFyc2UocmF3KTsKICAgICAgaWYgKCFlbnRyeSB8fCBlbnRyeS51cmwgIT09IHVybCB8fCAhZW50cnkuZGF0YSkgewogICAgICAgIHJldHVybiBudWxsOwogICAgICB9CiAgICAgIGlmIChEYXRlLm5vdygpIC0gZW50cnkudHMgPiAzMDAwMDApIHsKICAgICAgICByZXR1cm4gbnVsbDsKICAgICAgfQogICAgICByZXR1cm4gZW50cnkuZGF0YTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICB9CgogIGZ1bmN0aW9uIHdyaXRlUmVtb3RlQ29uZmlnQ2FjaGUodXJsLCBkYXRhKSB7CiAgICBpZiAoIXVybCB8fCB0eXBlb2YgJHBlcnNpc3RlbnRTdG9yZSA9PT0gInVuZGVmaW5lZCIgfHwgISRwZXJzaXN0ZW50U3RvcmUud3JpdGUpIHsKICAgICAgcmV0dXJuOwogICAgfQogICAgdHJ5IHsKICAgICAgJHBlcnNpc3RlbnRTdG9yZS53cml0ZSgKICAgICAgICAibG9jYXRpb25fc3Bvb2Zlcl9yZW1vdGVfY2ZnIiwKICAgICAgICBKU09OLnN0cmluZ2lmeSh7IHVybDogdXJsLCBkYXRhOiBkYXRhLCB0czogRGF0ZS5ub3coKSB9KQogICAgICApOwogICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgIC8vIGlnbm9yZSBjYWNoZSB3cml0ZSBmYWlsdXJlcwogICAgfQogIH0KCiAgZnVuY3Rpb24gZmV0Y2hSZW1vdGVDb25maWcodXJsLCB0aW1lb3V0LCBkZWJ1ZywgY2FsbGJhY2spIHsKICAgIGlmICghdXJsIHx8IHR5cGVvZiAkaHR0cENsaWVudCA9PT0gInVuZGVmaW5lZCIgfHwgISRodHRwQ2xpZW50LmdldCkgewogICAgICBjYWxsYmFjayhudWxsLCAiaHR0cCBjbGllbnQgdW5hdmFpbGFibGUiKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgJGh0dHBDbGllbnQuZ2V0KHsgdXJsOiB1cmwsIHRpbWVvdXQ6IHRpbWVvdXQgfHwgMzAwMCB9LCBmdW5jdGlvbiAoZXJyb3IsIHJlc3BvbnNlLCBib2R5KSB7CiAgICAgIGlmIChlcnJvciB8fCAhYm9keSkgewogICAgICAgIGNhbGxiYWNrKG51bGwsIGVycm9yIHx8ICJlbXB0eSBib2R5Iik7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIHRyeSB7CiAgICAgICAgY2FsbGJhY2soSlNPTi5wYXJzZShib2R5KSwgbnVsbCk7CiAgICAgIH0gY2F0Y2ggKGVycikgewogICAgICAgIGNhbGxiYWNrKG51bGwsIGVyci5tZXNzYWdlKTsKICAgICAgfQogICAgfSk7CiAgfQoKICBmdW5jdGlvbiByZWZyZXNoUmVtb3RlQ29uZmlnQ2FjaGUodXJsLCBkZWJ1ZykgewogICAgZmV0Y2hSZW1vdGVDb25maWcodXJsLCA1MDAwLCBkZWJ1ZywgZnVuY3Rpb24gKGRhdGEsIGVycikgewogICAgICBpZiAoZGF0YSkgewogICAgICAgIHdyaXRlUmVtb3RlQ29uZmlnQ2FjaGUodXJsLCBkYXRhKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgaWYgKGRlYnVnKSB7CiAgICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcmVtb3RlIGNvbmZpZyByZWZyZXNoIGZhaWxlZDogIiArIGVycik7CiAgICAgIH0KICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gYXBwbHlBZGRyZXNzRnJvbUNhY2hlKGNmZywgYWRkcmVzcywgZGVidWcpIHsKICAgIGlmICghYWRkcmVzcykgewogICAgICByZXR1cm47CiAgICB9CiAgICB2YXIgY2FjaGVkID0gcmVhZEdlb2NvZGVDYWNoZSgpOwogICAgaWYgKGNhY2hlZCAmJiBjYWNoZWQuYWRkcmVzcyA9PT0gYWRkcmVzcyAmJiBOdW1iZXIuaXNGaW5pdGUoTnVtYmVyKGNhY2hlZC5sYXRpdHVkZSkpICYmIE51bWJlci5pc0Zpbml0ZShOdW1iZXIoY2FjaGVkLmxvbmdpdHVkZSkpKSB7CiAgICAgIGNmZy5sYXRpdHVkZSA9IGNhY2hlZC5sYXRpdHVkZTsKICAgICAgY2ZnLmxvbmdpdHVkZSA9IGNhY2hlZC5sb25naXR1ZGU7CiAgICAgIGlmIChjYWNoZWQuYWx0aXR1ZGUgIT0gbnVsbCkgewogICAgICAgIGNmZy5hbHRpdHVkZSA9IGNhY2hlZC5hbHRpdHVkZTsKICAgICAgfQogICAgICBpZiAoZGVidWcpIHsKICAgICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBnZW9jb2RlIGNhY2hlIGhpdDogIiArIGFkZHJlc3MpOwogICAgICB9CiAgICAgIHJldHVybjsKICAgIH0KICAgIGlmIChkZWJ1ZykgewogICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBnZW9jb2RlIGNhY2hlIG1pc3M6ICIgKyBhZGRyZXNzICsgIiAodXNlIG1hbnVhbCBsYXQvbG5nIHVudGlsIGNyb24gcmVmcmVzaGVzKSIpOwogICAgfQogIH0KCiAgZnVuY3Rpb24gbG9hZFJ1bnRpbWVDb25maWdTeW5jKCkgewogICAgdmFyIGFyZ3MgPSByZWFkU2NyaXB0QXJndW1lbnRzKCk7CiAgICB2YXIgY2ZnID0gbWVyZ2VDb25maWcoREVGQVVMVF9DT05GSUcsIGNvbmZpZ0Zyb21BcmdzKGFyZ3MpKTsKICAgIHZhciBjb25maWdVcmwgPSByZXNvbHZlQ29uZmlnVXJsKGFyZ3MpOwogICAgdmFyIGRlYnVnID0gcGFyc2VCb29sZWFuKGNmZy5kZWJ1ZywgZmFsc2UpOwogICAgdmFyIGFkZHJlc3MgPSBTdHJpbmcoYXJncy5hZGRyZXNzIHx8ICIiKS50cmltKCk7CgogICAgYXBwbHlBZGRyZXNzRnJvbUNhY2hlKGNmZywgYWRkcmVzcywgZGVidWcpOwoKICAgIGlmIChjb25maWdVcmwpIHsKICAgICAgdmFyIHJlbW90ZUNmZyA9IHJlYWRSZW1vdGVDb25maWdDYWNoZShjb25maWdVcmwpOwogICAgICBpZiAocmVtb3RlQ2ZnKSB7CiAgICAgICAgY2ZnID0gbWVyZ2VDb25maWcoY2ZnLCByZW1vdGVDZmcpOwogICAgICAgIGlmIChkZWJ1ZykgewogICAgICAgICAgY29uc29sZS5sb2coCiAgICAgICAgICAgICJMb2NhdGlvbiBzcG9vZmVyIHJlbW90ZSBjb25maWcgY2FjaGUgaGl0IC0+ICIgKwogICAgICAgICAgICAgIHJlbW90ZUNmZy5sYXRpdHVkZSArCiAgICAgICAgICAgICAgIiwiICsKICAgICAgICAgICAgICByZW1vdGVDZmcubG9uZ2l0dWRlCiAgICAgICAgICApOwogICAgICAgIH0KICAgICAgfQogICAgfQoKICAgIHJldHVybiB7IGNmZzogY2ZnLCBjb25maWdVcmw6IGNvbmZpZ1VybCwgZGVidWc6IGRlYnVnIH07CiAgfQoKICBmdW5jdGlvbiBsb2FkUnVudGltZUNvbmZpZyhjYWxsYmFjaykgewogICAgdmFyIGxvYWRlZCA9IGxvYWRSdW50aW1lQ29uZmlnU3luYygpOwogICAgdmFyIGNmZyA9IGxvYWRlZC5jZmc7CiAgICB2YXIgY29uZmlnVXJsID0gbG9hZGVkLmNvbmZpZ1VybDsKICAgIHZhciBkZWJ1ZyA9IGxvYWRlZC5kZWJ1ZzsKCiAgICBmdW5jdGlvbiBmaW5pc2goKSB7CiAgICAgIHRyeSB7CiAgICAgICAgY2FsbGJhY2sobm9ybWFsaXplQ29uZmlnKGNmZykpOwogICAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgICBpZiAoZGVidWcpIHsKICAgICAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIGNvbmZpZyBpbnZhbGlkOiAiICsgZXJyLm1lc3NhZ2UgKyAiIHwgY2ZnIGxhdC9sbmc9IiArIGNmZy5sYXRpdHVkZSArICIsIiArIGNmZy5sb25naXR1ZGUpOwogICAgICAgIH0KICAgICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShOdW1iZXIoY2ZnLmxhdGl0dWRlKSkgfHwgIU51bWJlci5pc0Zpbml0ZShOdW1iZXIoY2ZnLmxvbmdpdHVkZSkpKSB7CiAgICAgICAgICBjZmcubGF0aXR1ZGUgPSBERUZBVUxUX0NPTkZJRy5sYXRpdHVkZTsKICAgICAgICAgIGNmZy5sb25naXR1ZGUgPSBERUZBVUxUX0NPTkZJRy5sb25naXR1ZGU7CiAgICAgICAgfQogICAgICAgIGNhbGxiYWNrKG5vcm1hbGl6ZUNvbmZpZyhjZmcpKTsKICAgICAgfQogICAgfQoKICAgIGxvZ1NjcmlwdEFyZ3VtZW50cyhkZWJ1Zyk7CgogICAgaWYgKCFjb25maWdVcmwpIHsKICAgICAgZmluaXNoKCk7CiAgICAgIHJldHVybjsKICAgIH0KCiAgICBpZiAocmVhZFJlbW90ZUNvbmZpZ0NhY2hlKGNvbmZpZ1VybCkpIHsKICAgICAgcmVmcmVzaFJlbW90ZUNvbmZpZ0NhY2hlKGNvbmZpZ1VybCwgZGVidWcpOwogICAgICBmaW5pc2goKTsKICAgICAgcmV0dXJuOwogICAgfQoKICAgIGlmIChkZWJ1ZykgewogICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciByZW1vdGUgY29uZmlnIGZldGNoaW5nOiAiICsgY29uZmlnVXJsKTsKICAgIH0KICAgIGZldGNoUmVtb3RlQ29uZmlnKGNvbmZpZ1VybCwgMzAwMCwgZGVidWcsIGZ1bmN0aW9uIChkYXRhLCBlcnIpIHsKICAgICAgaWYgKGRhdGEpIHsKICAgICAgICB3cml0ZVJlbW90ZUNvbmZpZ0NhY2hlKGNvbmZpZ1VybCwgZGF0YSk7CiAgICAgICAgY2ZnID0gbWVyZ2VDb25maWcoY2ZnLCBkYXRhKTsKICAgICAgICBpZiAoZGVidWcpIHsKICAgICAgICAgIGNvbnNvbGUubG9nKAogICAgICAgICAgICAiTG9jYXRpb24gc3Bvb2ZlciByZW1vdGUgY29uZmlnIGxvYWRlZCAtPiAiICsgZGF0YS5sYXRpdHVkZSArICIsIiArIGRhdGEubG9uZ2l0dWRlCiAgICAgICAgICApOwogICAgICAgIH0KICAgICAgfSBlbHNlIGlmIChkZWJ1ZykgewogICAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIHJlbW90ZSBjb25maWcgZmV0Y2ggZmFpbGVkOiAiICsgZXJyICsgIiAodXNpbmcgbWFudWFsIGxhdC9sbmcpIik7CiAgICAgIH0KICAgICAgZmluaXNoKCk7CiAgICB9KTsKICB9CgogIGZ1bmN0aW9uIHJ1bk1haW50ZW5hbmNlQ3JvbigpIHsKICAgIHZhciBhcmdzID0gcmVhZFNjcmlwdEFyZ3VtZW50cygpOwogICAgdmFyIGRlYnVnID0gcGFyc2VCb29sZWFuKGFyZ3MuZGVidWcsIGZhbHNlKTsKICAgIHZhciBwZW5kaW5nID0gMDsKCiAgICBmdW5jdGlvbiBtYXliZURvbmUoKSB7CiAgICAgIHBlbmRpbmcgLT0gMTsKICAgICAgaWYgKHBlbmRpbmcgPD0gMCkgewogICAgICAgICRkb25lKHt9KTsKICAgICAgfQogICAgfQoKICAgIHZhciBjb25maWdVcmwgPSByZXNvbHZlQ29uZmlnVXJsKGFyZ3MpOwogICAgaWYgKGNvbmZpZ1VybCkgewogICAgICBwZW5kaW5nICs9IDE7CiAgICAgIGZldGNoUmVtb3RlQ29uZmlnKGNvbmZpZ1VybCwgODAwMCwgZGVidWcsIGZ1bmN0aW9uIChkYXRhLCBlcnIpIHsKICAgICAgICBpZiAoZGF0YSkgewogICAgICAgICAgd3JpdGVSZW1vdGVDb25maWdDYWNoZShjb25maWdVcmwsIGRhdGEpOwogICAgICAgICAgaWYgKGRlYnVnKSB7CiAgICAgICAgICAgIGNvbnNvbGUubG9nKAogICAgICAgICAgICAgICJMb2NhdGlvbiBzcG9vZmVyIGNvbmZpZyBjcm9uIGNhY2hlZCAtPiAiICsgZGF0YS5sYXRpdHVkZSArICIsIiArIGRhdGEubG9uZ2l0dWRlCiAgICAgICAgICAgICk7CiAgICAgICAgICB9CiAgICAgICAgfSBlbHNlIGlmIChkZWJ1ZykgewogICAgICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgY29uZmlnIGNyb24gZmFpbGVkOiAiICsgZXJyKTsKICAgICAgICB9CiAgICAgICAgbWF5YmVEb25lKCk7CiAgICAgIH0pOwogICAgfQoKICAgIHZhciBhZGRyZXNzID0gU3RyaW5nKGFyZ3MuYWRkcmVzcyB8fCAiIikudHJpbSgpOwogICAgaWYgKGFkZHJlc3MpIHsKICAgICAgcGVuZGluZyArPSAxOwogICAgICBnZW9jb2RlQWRkcmVzcyhhZGRyZXNzLCBkZWJ1ZywgZnVuY3Rpb24gKCkgewogICAgICAgIG1heWJlRG9uZSgpOwogICAgICB9KTsKICAgIH0KCiAgICBpZiAocGVuZGluZyA9PT0gMCkgewogICAgICAkZG9uZSh7fSk7CiAgICB9CiAgfQoKICBmdW5jdGlvbiBydW5HZW9jb2RlQ3JvbigpIHsKICAgIHJ1bk1haW50ZW5hbmNlQ3JvbigpOwogIH0KCiAgZnVuY3Rpb24gaGVhZGVyc1dpdGhCaW5hcnlCb2R5KHNvdXJjZUhlYWRlcnMsIGxlbmd0aCkgewogICAgdmFyIGhlYWRlcnMgPSB7fTsKICAgIHZhciBrZXk7CiAgICBzb3VyY2VIZWFkZXJzID0gc291cmNlSGVhZGVycyB8fCB7fTsKICAgIGZvciAoa2V5IGluIHNvdXJjZUhlYWRlcnMpIHsKICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChzb3VyY2VIZWFkZXJzLCBrZXkpKSB7CiAgICAgICAgdmFyIGxvd2VyID0ga2V5LnRvTG93ZXJDYXNlKCk7CiAgICAgICAgaWYgKGxvd2VyICE9PSAiY29udGVudC1sZW5ndGgiICYmIGxvd2VyICE9PSAiY29udGVudC1lbmNvZGluZyIgJiYgbG93ZXIgIT09ICJ0cmFuc2Zlci1lbmNvZGluZyIpIHsKICAgICAgICAgIGhlYWRlcnNba2V5XSA9IHNvdXJjZUhlYWRlcnNba2V5XTsKICAgICAgICB9CiAgICAgIH0KICAgIH0KICAgIGhlYWRlcnNbIkNvbnRlbnQtVHlwZSJdID0gImFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbSI7CiAgICBoZWFkZXJzWyJDb250ZW50LUxlbmd0aCJdID0gU3RyaW5nKGxlbmd0aCk7CiAgICByZXR1cm4gaGVhZGVyczsKICB9CgogIGZ1bmN0aW9uIHNldEhlYWRlcihoZWFkZXJzLCBuYW1lLCB2YWx1ZSkgewogICAgaGVhZGVycyA9IGhlYWRlcnMgfHwge307CiAgICB2YXIgbG93ZXIgPSBuYW1lLnRvTG93ZXJDYXNlKCk7CiAgICB2YXIgZXhpc3RpbmdLZXkgPSBudWxsOwogICAgZm9yICh2YXIga2V5IGluIGhlYWRlcnMpIHsKICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChoZWFkZXJzLCBrZXkpICYmIGtleS50b0xvd2VyQ2FzZSgpID09PSBsb3dlcikgewogICAgICAgIGV4aXN0aW5nS2V5ID0ga2V5OwogICAgICAgIGJyZWFrOwogICAgICB9CiAgICB9CiAgICBoZWFkZXJzW2V4aXN0aW5nS2V5IHx8IG5hbWVdID0gdmFsdWU7CiAgICByZXR1cm4gaGVhZGVyczsKICB9CgogIGZ1bmN0aW9uIHByZXBhcmVSZXF1ZXN0SGVhZGVycyhoZWFkZXJzKSB7CiAgICByZXR1cm4gc2V0SGVhZGVyKGhlYWRlcnMgfHwge30sICJBY2NlcHQtRW5jb2RpbmciLCAiaWRlbnRpdHkiKTsKICB9CgogIGZ1bmN0aW9uIGRvbmVQcmVwYXJlZFJlcXVlc3RQYXNzVGhyb3VnaCgpIHsKICAgIHZhciBoZWFkZXJzID0gcHJlcGFyZVJlcXVlc3RIZWFkZXJzKCh0eXBlb2YgJHJlcXVlc3QgIT09ICJ1bmRlZmluZWQiICYmICRyZXF1ZXN0LmhlYWRlcnMpIHx8IHt9KTsKICAgICRkb25lKHsKICAgICAgaGVhZGVyczogaGVhZGVycwogICAgfSk7CiAgfQoKICAvLyBEZWNvZGUgYW4gSFRUUCByZXNwb25zZSBib2R5IHRoYXQgbWF5IGJlIGd6aXAvZGVmbGF0ZS9iciBlbmNvZGVkLgogIC8vIFNoYWRvd3JvY2tldC9TdXJnZSBleHBvc2UgJHV0aWxzLnVuZ3ppcDsgTG9vbiBmYWxscyBiYWNrIHRvIERlY29tcHJlc3Npb25TdHJlYW0uCiAgZnVuY3Rpb24gZGVjb21wcmVzc0JvZHkoYm9keSwgY29udGVudEVuY29kaW5nKSB7CiAgICBpZiAoYm9keSA9PSBudWxsKSB7CiAgICAgIHJldHVybiBib2R5OwogICAgfQogICAgdmFyIGVuYyA9IGNvbnRlbnRFbmNvZGluZyA/IFN0cmluZyhjb250ZW50RW5jb2RpbmcpLnRvTG93ZXJDYXNlKCkgOiAiIjsKICAgIGlmIChlbmMgPT09ICJpZGVudGl0eSIgfHwgZW5jID09PSAiIikgewogICAgICByZXR1cm4gYm9keTsKICAgIH0KICAgIHRyeSB7CiAgICAgIGlmIChlbmMuaW5kZXhPZigiZ3ppcCIpID49IDAgJiYgdHlwZW9mICR1dGlscyAhPT0gInVuZGVmaW5lZCIgJiYgJHV0aWxzLnVuZ3ppcCkgewogICAgICAgIHJldHVybiAkdXRpbHMudW5nemlwKGJvZHkpOwogICAgICB9CiAgICAgIGlmIChlbmMuaW5kZXhPZigiZGVmbGF0ZSIpID49IDAgJiYgdHlwZW9mICR1dGlscyAhPT0gInVuZGVmaW5lZCIgJiYgJHV0aWxzLmluZmxhdGUpIHsKICAgICAgICByZXR1cm4gJHV0aWxzLmluZmxhdGUoYm9keSk7CiAgICAgIH0KICAgICAgaWYgKGVuYy5pbmRleE9mKCJiciIpID49IDAgJiYgdHlwZW9mICR1dGlscyAhPT0gInVuZGVmaW5lZCIgJiYgJHV0aWxzLmJyb3RsaURlY29tcHJlc3MpIHsKICAgICAgICByZXR1cm4gJHV0aWxzLmJyb3RsaURlY29tcHJlc3MoYm9keSk7CiAgICAgIH0KICAgIH0gY2F0Y2ggKGVycikgewogICAgICBpZiAodHlwZW9mIGNvbnNvbGUgIT09ICJ1bmRlZmluZWQiKSB7CiAgICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgZGVjb21wcmVzcyBmYWlsZWQgKCIgKyBlbmMgKyAiKTogIiArIGVyci5tZXNzYWdlKTsKICAgICAgfQogICAgfQogICAgcmV0dXJuIGJvZHk7CiAgfQoKICBmdW5jdGlvbiBwcmVwYXJlUmVzcG9uc2VCb2R5U3luYyhjb25maWcpIHsKICAgIHZhciByZXNwSGVhZGVycyA9ICgkcmVzcG9uc2UgJiYgJHJlc3BvbnNlLmhlYWRlcnMpIHx8IHt9OwogICAgdmFyIGNvbnRlbnRFbmNvZGluZyA9IGhlYWRlclZhbHVlKHJlc3BIZWFkZXJzLCAiQ29udGVudC1FbmNvZGluZyIpOwogICAgdmFyIHJhd1Jlc3BCb2R5ID0gJHJlc3BvbnNlICYmICgkcmVzcG9uc2UuYm9keSAhPSBudWxsID8gJHJlc3BvbnNlLmJvZHkgOiAkcmVzcG9uc2UuYm9keUJ5dGVzKTsKICAgIGxvZ0h0dHBEdW1wKCJyZXNwb25zZS13aXJlLW9yaWdpbmFsIiwgJHJlc3BvbnNlLCBjb25maWcpOwogICAgbG9nUmF3RHVtcCgicmVzcG9uc2Utd2lyZS1vcmlnaW5hbCIsIGJvZHlUb0J5dGVzKHJhd1Jlc3BCb2R5KSwgY29uZmlnKTsKCiAgICB2YXIgYnl0ZXMgPSBib2R5VG9CeXRlcyhyYXdSZXNwQm9keSk7CiAgICBpZiAoIWJ5dGVzIHx8IGJ5dGVzLmxlbmd0aCA8IDIpIHsKICAgICAgcmV0dXJuOwogICAgfQoKICAgIGlmIChpc0d6aXBCeXRlcyhieXRlcykgfHwgKGNvbnRlbnRFbmNvZGluZyAmJiBTdHJpbmcoY29udGVudEVuY29kaW5nKS50b0xvd2VyQ2FzZSgpLmluZGV4T2YoImd6aXAiKSA+PSAwKSkgewogICAgICB2YXIgZGVjb2RlZCA9IGJvZHlUb0J5dGVzKGRlY29tcHJlc3NCb2R5KHJhd1Jlc3BCb2R5LCBjb250ZW50RW5jb2RpbmcgfHwgImd6aXAiKSk7CiAgICAgIGlmIChkZWNvZGVkICYmIGRlY29kZWQubGVuZ3RoID4gMiAmJiAhaXNHemlwQnl0ZXMoZGVjb2RlZCkpIHsKICAgICAgICAkcmVzcG9uc2UuYm9keSA9IGRlY29kZWQ7CiAgICAgICAgaWYgKGNvbmZpZy5kZWJ1ZykgewogICAgICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgZGVjb21wcmVzc2VkIGJvZHk6ICIgKyBieXRlcy5sZW5ndGggKyAiIC0+ICIgKyBkZWNvZGVkLmxlbmd0aCArICIgYnl0ZXMiKTsKICAgICAgICB9CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIGlmIChjb25maWcuZGVidWcpIHsKICAgICAgICBjb25zb2xlLmxvZygKICAgICAgICAgICJMb2NhdGlvbiBzcG9vZmVyIGd6aXAgYm9keSBzdGlsbCBjb21wcmVzc2VkIChsZW49IiArCiAgICAgICAgICAgIGJ5dGVzLmxlbmd0aCArCiAgICAgICAgICAgICIpOyBlbnN1cmUgaHR0cC1yZXF1ZXN0IHByZXBhcmUgc2NyaXB0IGlzIGVuYWJsZWQiCiAgICAgICAgKTsKICAgICAgfQogICAgICByZXR1cm47CiAgICB9CgogICAgaWYgKGNvbnRlbnRFbmNvZGluZykgewogICAgICB2YXIgcGxhaW4gPSBib2R5VG9CeXRlcyhkZWNvbXByZXNzQm9keShyYXdSZXNwQm9keSwgY29udGVudEVuY29kaW5nKSk7CiAgICAgIGlmIChwbGFpbikgewogICAgICAgICRyZXNwb25zZS5ib2R5ID0gcGxhaW47CiAgICAgIH0KICAgIH0KICB9CgogIGZ1bmN0aW9uIGhlYWRlclZhbHVlKGhlYWRlcnMsIG5hbWUpIHsKICAgIGlmICghaGVhZGVycykgewogICAgICByZXR1cm4gdW5kZWZpbmVkOwogICAgfQogICAgdmFyIGxvd2VyID0gbmFtZS50b0xvd2VyQ2FzZSgpOwogICAgZm9yICh2YXIga2V5IGluIGhlYWRlcnMpIHsKICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChoZWFkZXJzLCBrZXkpICYmIGtleS50b0xvd2VyQ2FzZSgpID09PSBsb3dlcikgewogICAgICAgIHJldHVybiBoZWFkZXJzW2tleV07CiAgICAgIH0KICAgIH0KICAgIHJldHVybiB1bmRlZmluZWQ7CiAgfQoKICBmdW5jdGlvbiBkb25lUGFzc1Rocm91Z2goKSB7CiAgICAkZG9uZSh7fSk7CiAgfQoKICBmdW5jdGlvbiB2YWx1ZVR5cGUodmFsdWUpIHsKICAgIGlmICh2YWx1ZSA9PSBudWxsKSB7CiAgICAgIHJldHVybiBTdHJpbmcodmFsdWUpOwogICAgfQogICAgaWYgKHZhbHVlIGluc3RhbmNlb2YgVWludDhBcnJheSkgewogICAgICByZXR1cm4gIlVpbnQ4QXJyYXkiOwogICAgfQogICAgaWYgKHR5cGVvZiBBcnJheUJ1ZmZlciAhPT0gInVuZGVmaW5lZCIgJiYgdmFsdWUgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikgewogICAgICByZXR1cm4gIkFycmF5QnVmZmVyIjsKICAgIH0KICAgIHJldHVybiB0eXBlb2YgdmFsdWU7CiAgfQoKICBmdW5jdGlvbiB2YWx1ZUxlbmd0aCh2YWx1ZSkgewogICAgaWYgKHZhbHVlID09IG51bGwpIHsKICAgICAgcmV0dXJuIDA7CiAgICB9CiAgICBpZiAodHlwZW9mIHZhbHVlID09PSAic3RyaW5nIiB8fCB0eXBlb2YgdmFsdWUubGVuZ3RoID09PSAibnVtYmVyIikgewogICAgICByZXR1cm4gdmFsdWUubGVuZ3RoOwogICAgfQogICAgaWYgKHR5cGVvZiBBcnJheUJ1ZmZlciAhPT0gInVuZGVmaW5lZCIgJiYgdmFsdWUgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikgewogICAgICByZXR1cm4gdmFsdWUuYnl0ZUxlbmd0aDsKICAgIH0KICAgIHJldHVybiAwOwogIH0KCiAgZnVuY3Rpb24gb2JqZWN0S2V5cyh2YWx1ZSkgewogICAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09ICJvYmplY3QiKSB7CiAgICAgIHJldHVybiAiIjsKICAgIH0KICAgIHZhciBrZXlzID0gW107CiAgICBmb3IgKHZhciBrZXkgaW4gdmFsdWUpIHsKICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbCh2YWx1ZSwga2V5KSkgewogICAgICAgIGtleXMucHVzaChrZXkpOwogICAgICB9CiAgICB9CiAgICByZXR1cm4ga2V5cy5qb2luKCIsIik7CiAgfQoKICBmdW5jdGlvbiBmaWVsZEhpc3RvZ3JhbShmaWVsZHMpIHsKICAgIHZhciBjb3VudHMgPSB7fTsKICAgIHZhciBvcmRlciA9IFtdOwogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBmaWVsZHMubGVuZ3RoOyBpICs9IDEpIHsKICAgICAgdmFyIGtleSA9IFN0cmluZyhmaWVsZHNbaV0uZmllbGROdW1iZXIpICsgIi8iICsgU3RyaW5nKGZpZWxkc1tpXS53aXJlVHlwZSk7CiAgICAgIGlmICghY291bnRzW2tleV0pIHsKICAgICAgICBjb3VudHNba2V5XSA9IDA7CiAgICAgICAgb3JkZXIucHVzaChrZXkpOwogICAgICB9CiAgICAgIGNvdW50c1trZXldICs9IDE7CiAgICB9CiAgICB2YXIgcGFydHMgPSBbXTsKICAgIGZvciAodmFyIGogPSAwOyBqIDwgb3JkZXIubGVuZ3RoOyBqICs9IDEpIHsKICAgICAgcGFydHMucHVzaChvcmRlcltqXSArICJ4IiArIGNvdW50c1tvcmRlcltqXV0pOwogICAgfQogICAgcmV0dXJuIHBhcnRzLmpvaW4oIiwiKTsKICB9CgogIGZ1bmN0aW9uIGNvdW50RmllbGRzKGZpZWxkcywgZmllbGROdW1iZXIpIHsKICAgIHZhciBjb3VudCA9IDA7CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGZpZWxkcy5sZW5ndGg7IGkgKz0gMSkgewogICAgICBpZiAoZmllbGRzW2ldLmZpZWxkTnVtYmVyID09PSBmaWVsZE51bWJlcikgewogICAgICAgIGNvdW50ICs9IDE7CiAgICAgIH0KICAgIH0KICAgIHJldHVybiBjb3VudDsKICB9CgogIGZ1bmN0aW9uIGNvdW50Q2VsbFJlc3BvbnNlRmllbGRzKGZpZWxkcykgewogICAgdmFyIGNvdW50ID0gMDsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZmllbGRzLmxlbmd0aDsgaSArPSAxKSB7CiAgICAgIGlmIChpc0NlbGxSZXNwb25zZUZpZWxkKGZpZWxkc1tpXS5maWVsZE51bWJlcikpIHsKICAgICAgICBjb3VudCArPSAxOwogICAgICB9CiAgICB9CiAgICByZXR1cm4gY291bnQ7CiAgfQoKICBmdW5jdGlvbiBhcHBsZVdMb2NQYXlsb2FkSW5zcGVjdChwYXlsb2FkKSB7CiAgICB0cnkgewogICAgICB2YXIgZmllbGRzID0gcGFyc2VGaWVsZHMocGF5bG9hZCk7CiAgICAgIHZhciBwYXJ0cyA9IFsKICAgICAgICAicGF5bG9hZExlbj0iICsgcGF5bG9hZC5sZW5ndGgsCiAgICAgICAgImZpZWxkcz0iICsgZmllbGRIaXN0b2dyYW0oZmllbGRzKSwKICAgICAgICAid2lmaT0iICsgY291bnRGaWVsZHMoZmllbGRzLCAyKSwKICAgICAgICAiY2VsbFJlc3A9IiArIGNvdW50Q2VsbFJlc3BvbnNlRmllbGRzKGZpZWxkcyksCiAgICAgICAgImNlbGxSZXE9IiArIGNvdW50RmllbGRzKGZpZWxkcywgMjUpLAogICAgICAgICJoYXNDb3VudHM9IiArIChjb3VudEZpZWxkcyhmaWVsZHMsIDMpICsgIi8iICsgY291bnRGaWVsZHMoZmllbGRzLCA0KSksCiAgICAgICAgImRldmljZVR5cGU9IiArIGNvdW50RmllbGRzKGZpZWxkcywgMzMpLAogICAgICAgIHBhdGNoZWRQYXlsb2FkU3VtbWFyeShwYXlsb2FkKQogICAgICBdOwogICAgICByZXR1cm4gcGFydHMuam9pbigiLCAiKTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICByZXR1cm4gInBheWxvYWQgcGFyc2UgZmFpbGVkOiAiICsgZXJyLm1lc3NhZ2U7CiAgICB9CiAgfQoKICBmdW5jdGlvbiBsb2dSYXdEdW1wKGxhYmVsLCBieXRlcywgY29uZmlnKSB7CiAgICBpZiAoIWNvbmZpZy5kdW1wUmF3IHx8ICFieXRlcykgewogICAgICByZXR1cm47CiAgICB9CiAgICB2YXIgbGltaXQgPSBjb25maWcucmF3TGltaXQgfHwgMDsKICAgIHZhciBlbWl0dGVkID0gbGltaXQgPiAwICYmIGJ5dGVzLmxlbmd0aCA+IGxpbWl0ID8gYnl0ZXMuc2xpY2UoMCwgbGltaXQpIDogYnl0ZXM7CiAgICB2YXIgZW5jb2RlZCA9IGJ5dGVzVG9CYXNlNjQoZW1pdHRlZCk7CiAgICB2YXIgY2h1bmtTaXplID0gMzAwMDsKICAgIHZhciBjaHVua3MgPSBNYXRoLm1heCgxLCBNYXRoLmNlaWwoZW5jb2RlZC5sZW5ndGggLyBjaHVua1NpemUpKTsKICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIHJhdyAiICsgbGFiZWwgKyAiIGJhc2U2NCBiZWdpbjogbGVuPSIgKyBieXRlcy5sZW5ndGggKyAiLCBlbWl0dGVkPSIgKyBlbWl0dGVkLmxlbmd0aCArICIsIGNodW5rcz0iICsgY2h1bmtzICsgIiwgdHJ1bmNhdGVkPSIgKyAoZW1pdHRlZC5sZW5ndGggIT09IGJ5dGVzLmxlbmd0aCkpOwogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBlbmNvZGVkLmxlbmd0aDsgaSArPSBjaHVua1NpemUpIHsKICAgICAgdmFyIGNodW5rSW5kZXggPSBNYXRoLmZsb29yKGkgLyBjaHVua1NpemUpICsgMTsKICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcmF3ICIgKyBsYWJlbCArICIgYmFzZTY0IGNodW5rICIgKyBjaHVua0luZGV4ICsgIi8iICsgY2h1bmtzICsgIjogIiArIGVuY29kZWQuc2xpY2UoaSwgaSArIGNodW5rU2l6ZSkpOwogICAgfQogICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcmF3ICIgKyBsYWJlbCArICIgYmFzZTY0IGVuZCIpOwogIH0KCiAgZnVuY3Rpb24ganNvblN0cmluZyh2YWx1ZSkgewogICAgdHJ5IHsKICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHZhbHVlIHx8IHt9KTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICByZXR1cm4gIjxqc29uLWZhaWxlZDoiICsgZXJyLm1lc3NhZ2UgKyAiPiI7CiAgICB9CiAgfQoKICBmdW5jdGlvbiBsb2dIdHRwRHVtcChsYWJlbCwgbWVzc2FnZSwgY29uZmlnKSB7CiAgICBpZiAoIWNvbmZpZy5kdW1wSGVhZGVycyAmJiAhY29uZmlnLmR1bXBSYXcpIHsKICAgICAgcmV0dXJuOwogICAgfQogICAgbWVzc2FnZSA9IG1lc3NhZ2UgfHwge307CiAgICB2YXIgcmVxdWVzdCA9IHR5cGVvZiAkcmVxdWVzdCAhPT0gInVuZGVmaW5lZCIgPyAkcmVxdWVzdCA6IHt9OwogICAgdmFyIG1ldGhvZCA9IG1lc3NhZ2UubWV0aG9kIHx8IHJlcXVlc3QubWV0aG9kIHx8ICI8bm9uZT4iOwogICAgdmFyIHVybCA9IG1lc3NhZ2UudXJsIHx8IHJlcXVlc3QudXJsIHx8ICI8bm9uZT4iOwogICAgdmFyIHN0YXR1cyA9IG1lc3NhZ2Uuc3RhdHVzIHx8IG1lc3NhZ2Uuc3RhdHVzQ29kZSB8fCAiPG5vbmU+IjsKICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIHJhdyAiICsgbGFiZWwgKyAiIG1ldGE6IG1ldGhvZD0iICsgbWV0aG9kICsgIiwgdXJsPSIgKyB1cmwgKyAiLCBzdGF0dXM9IiArIHN0YXR1cyk7CiAgICBpZiAoY29uZmlnLmR1bXBIZWFkZXJzKSB7CiAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIHJhdyAiICsgbGFiZWwgKyAiIGhlYWRlcnM6ICIgKyBqc29uU3RyaW5nKG1lc3NhZ2UuaGVhZGVycyB8fCB7fSkpOwogICAgfQogIH0KCiAgZnVuY3Rpb24gaW5zcGVjdFJlc3BvbnNlQnl0ZXMoYnl0ZXMsIGNvbmZpZykgewogICAgaWYgKCFieXRlcykgewogICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBpbnNwZWN0IHJlc3BvbnNlIGJvZHkgdW5hdmFpbGFibGUiKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgaW5zcGVjdCByZXNwb25zZSBib2R5OiBsZW49IiArIGJ5dGVzLmxlbmd0aCArICIsIGhlYWQ9IiArIGhleFByZXZpZXcoYnl0ZXMsIDQ4KSk7CiAgICBsb2dSYXdEdW1wKCJyZXNwb25zZSIsIGJ5dGVzLCBjb25maWcpOwogICAgdHJ5IHsKICAgICAgdmFyIGV4dHJhY3Rpb24gPSBleHRyYWN0QXBwbGVXTG9jUGF5bG9hZChieXRlcyk7CiAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIGluc3BlY3QgcmVzcG9uc2UgZXh0cmFjdGlvbjoga2luZD0iICsgZXh0cmFjdGlvbi5raW5kICsgIiwgcHJlZml4PSIgKyAoZXh0cmFjdGlvbi5wcmVmaXggPyBoZXhQcmV2aWV3KGV4dHJhY3Rpb24ucHJlZml4LCA4KSA6ICI8bm9uZT4iKSArICIsIHBheWxvYWRMZW49IiArIGV4dHJhY3Rpb24ucGF5bG9hZC5sZW5ndGggKyAiLCBzdWZmaXhMZW49IiArIChleHRyYWN0aW9uLnN1ZmZpeCA/IGV4dHJhY3Rpb24uc3VmZml4Lmxlbmd0aCA6IDApKTsKICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgaW5zcGVjdCByZXNwb25zZSBwYXlsb2FkOiAiICsgYXBwbGVXTG9jUGF5bG9hZEluc3BlY3QoZXh0cmFjdGlvbi5wYXlsb2FkKSk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgaW5zcGVjdCByZXNwb25zZSBleHRyYWN0aW9uIGZhaWxlZDogIiArIGVyci5tZXNzYWdlKTsKICAgICAgdmFyIGRpcmVjdEZpZWxkcyA9IHRyeVBhcnNlRmllbGRzKGJ5dGVzKTsKICAgICAgaWYgKGRpcmVjdEZpZWxkcykgewogICAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIGluc3BlY3QgcmVzcG9uc2UgZGlyZWN0IGZpZWxkczogIiArIGZpZWxkSGlzdG9ncmFtKGRpcmVjdEZpZWxkcykpOwogICAgICB9CiAgICB9CiAgfQoKICBmdW5jdGlvbiBpbnNwZWN0UmVxdWVzdEJ5dGVzKGJ5dGVzLCBjb25maWcpIHsKICAgIGlmICghYnl0ZXMpIHsKICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgaW5zcGVjdCByZXF1ZXN0IGJvZHkgdW5hdmFpbGFibGUiKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgaW5zcGVjdCByZXF1ZXN0IGJvZHk6IGxlbj0iICsgYnl0ZXMubGVuZ3RoICsgIiwgaGVhZD0iICsgaGV4UHJldmlldyhieXRlcywgNDgpKTsKICAgIGxvZ1Jhd0R1bXAoInJlcXVlc3QiLCBieXRlcywgY29uZmlnKTsKICAgIHRyeSB7CiAgICAgIHZhciBhcnBjID0gcGFyc2VBcnBjKGJ5dGVzKTsKICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgaW5zcGVjdCByZXF1ZXN0IGFycGM6IHZlcnNpb249IiArIGFycGMudmVyc2lvbiArICIsIGZ1bmN0aW9uSWQ9IiArIGFycGMuZnVuY3Rpb25JZCArICIsIGxvY2FsZT0iICsgYXJwYy5sb2NhbGUgKyAiLCBhcHA9IiArIGFycGMuYXBwSWRlbnRpZmllciArICIsIG9zPSIgKyBhcnBjLm9zVmVyc2lvbiArICIsIHBheWxvYWRMZW49IiArIGFycGMucGF5bG9hZC5sZW5ndGgpOwogICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBpbnNwZWN0IHJlcXVlc3QgcGF5bG9hZDogIiArIGFwcGxlV0xvY1BheWxvYWRJbnNwZWN0KGFycGMucGF5bG9hZCkpOwogICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIGluc3BlY3QgcmVxdWVzdCBhcnBjIGZhaWxlZDogIiArIGVyci5tZXNzYWdlKTsKICAgICAgdmFyIGRpcmVjdEZpZWxkcyA9IHRyeVBhcnNlRmllbGRzKGJ5dGVzKTsKICAgICAgaWYgKGRpcmVjdEZpZWxkcykgewogICAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIGluc3BlY3QgcmVxdWVzdCBkaXJlY3QgZmllbGRzOiAiICsgZmllbGRIaXN0b2dyYW0oZGlyZWN0RmllbGRzKSk7CiAgICAgIH0KICAgIH0KICB9CgogIGZ1bmN0aW9uIGRvbmVJbnNwZWN0KGNvbmZpZywgaGFzUmVzcG9uc2UpIHsKICAgIGlmIChoYXNSZXNwb25zZSkgewogICAgICBsb2dIdHRwRHVtcCgicmVzcG9uc2UiLCAkcmVzcG9uc2UsIGNvbmZpZyk7CiAgICAgIGluc3BlY3RSZXNwb25zZUJ5dGVzKG1lc3NhZ2VCb2R5VG9CeXRlcygkcmVzcG9uc2UpLCBjb25maWcpOwogICAgfSBlbHNlIHsKICAgICAgbG9nSHR0cER1bXAoInJlcXVlc3QiLCAkcmVxdWVzdCwgY29uZmlnKTsKICAgICAgaW5zcGVjdFJlcXVlc3RCeXRlcyhtZXNzYWdlQm9keVRvQnl0ZXMoJHJlcXVlc3QpLCBjb25maWcpOwogICAgICBpZiAoY29uZmlnLnByZXBhcmVIZWFkZXJzKSB7CiAgICAgICAgZG9uZVByZXBhcmVkUmVxdWVzdFBhc3NUaHJvdWdoKCk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICB9CiAgICBkb25lUGFzc1Rocm91Z2goKTsKICB9CgogIGZ1bmN0aW9uIGRvbmVSZXNwb25zZVByb2JlKGNvbmZpZykgewogICAgdmFyIHJlc3BvbnNlID0gdHlwZW9mICRyZXNwb25zZSAhPT0gInVuZGVmaW5lZCIgPyAkcmVzcG9uc2UgOiB7fTsKICAgIHZhciBoZWFkZXJzID0gcmVzcG9uc2UuaGVhZGVycyB8fCB7fTsKICAgIGlmIChjb25maWcuZGVidWcpIHsKICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcHJvYmUgcmVzcG9uc2Uga2V5czogIiArIG9iamVjdEtleXMocmVzcG9uc2UpKTsKICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcHJvYmUgaGVhZGVyczogc3RhdHVzPSIgKyAocmVzcG9uc2Uuc3RhdHVzIHx8IHJlc3BvbnNlLnN0YXR1c0NvZGUgfHwgIjxub25lPiIpICsgIiwgY29udGVudC1sZW5ndGg9IiArIChoZWFkZXJWYWx1ZShoZWFkZXJzLCAiQ29udGVudC1MZW5ndGgiKSB8fCAiPG5vbmU+IikgKyAiLCBjb250ZW50LXR5cGU9IiArIChoZWFkZXJWYWx1ZShoZWFkZXJzLCAiQ29udGVudC1UeXBlIikgfHwgIjxub25lPiIpICsgIiwgY29udGVudC1lbmNvZGluZz0iICsgKGhlYWRlclZhbHVlKGhlYWRlcnMsICJDb250ZW50LUVuY29kaW5nIikgfHwgIm5vbmUiKSk7CiAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIHByb2JlIGJvZHkgc2xvdHM6IGJvZHk9IiArIHZhbHVlVHlwZShyZXNwb25zZS5ib2R5KSArICIvIiArIHZhbHVlTGVuZ3RoKHJlc3BvbnNlLmJvZHkpICsgIiwgYm9keUJ5dGVzPSIgKyB2YWx1ZVR5cGUocmVzcG9uc2UuYm9keUJ5dGVzKSArICIvIiArIHZhbHVlTGVuZ3RoKHJlc3BvbnNlLmJvZHlCeXRlcykgKyAiLCByYXdCb2R5PSIgKyB2YWx1ZVR5cGUocmVzcG9uc2UucmF3Qm9keSkgKyAiLyIgKyB2YWx1ZUxlbmd0aChyZXNwb25zZS5yYXdCb2R5KSArICIsIGJpbmFyeUJvZHk9IiArIHZhbHVlVHlwZShyZXNwb25zZS5iaW5hcnlCb2R5KSArICIvIiArIHZhbHVlTGVuZ3RoKHJlc3BvbnNlLmJpbmFyeUJvZHkpKTsKICAgICAgdmFyIGJ5dGVzID0gbWVzc2FnZUJvZHlUb0J5dGVzKHJlc3BvbnNlKTsKICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcHJvYmUgc2VsZWN0ZWQgYm9keTogIiArIChieXRlcyA/IGJ5dGVzLmxlbmd0aCA6IDApICsgIiBieXRlcywgaGVhZD0iICsgKGJ5dGVzID8gaGV4UHJldmlldyhieXRlcywgMzIpIDogIjxub25lPiIpKTsKICAgIH0KICAgIGRvbmVQYXNzVGhyb3VnaCgpOwogIH0KCiAgZnVuY3Rpb24gZG9uZVN5bnRoZXRpY1Jlc3BvbnNlKGJ5dGVzLCBpbmZvKSB7CiAgICB2YXIgaGVhZGVycyA9IGhlYWRlcnNXaXRoQmluYXJ5Qm9keSh7fSwgYnl0ZXMubGVuZ3RoKTsKICAgIGlmIChpbmZvICYmIGluZm8uZGVidWcpIHsKICAgICAgaGVhZGVyc1siWC1Mb2NhdGlvbi1TcG9vZmVyLVdpZmktQ291bnQiXSA9IFN0cmluZyhpbmZvLndpZmlDb3VudCk7CiAgICAgIGhlYWRlcnNbIlgtTG9jYXRpb24tU3Bvb2Zlci1DZWxsLUNvdW50Il0gPSBTdHJpbmcoaW5mby5jZWxsQ291bnQgfHwgMCk7CiAgICB9CiAgICBpZiAoaXNMb29uUnVudGltZSgpKSB7CiAgICAgICRkb25lKHsKICAgICAgICBzdGF0dXM6IDIwMCwKICAgICAgICBoZWFkZXJzOiBoZWFkZXJzLAogICAgICAgIGJvZHk6IGJ5dGVzCiAgICAgIH0pOwogICAgICByZXR1cm47CiAgICB9CiAgICAkZG9uZSh7CiAgICAgIHJlc3BvbnNlOiB7CiAgICAgICAgc3RhdHVzOiAyMDAsCiAgICAgICAgaGVhZGVyczogaGVhZGVycywKICAgICAgICBib2R5OiBieXRlcwogICAgICB9CiAgICB9KTsKICB9CgogIGZ1bmN0aW9uIGRvbmVSZXdyaXRlUmVzcG9uc2UoYnl0ZXMsIGluZm8pIHsKICAgIHZhciBzb3VyY2VIZWFkZXJzID0gdHlwZW9mICRyZXNwb25zZSAhPT0gInVuZGVmaW5lZCIgPyAkcmVzcG9uc2UuaGVhZGVycyA6IHt9OwogICAgdmFyIGhlYWRlcnMgPSBoZWFkZXJzV2l0aEJpbmFyeUJvZHkoc291cmNlSGVhZGVycywgYnl0ZXMubGVuZ3RoKTsKICAgIGlmIChpbmZvICYmIGluZm8uZGVidWcpIHsKICAgICAgaGVhZGVyc1siWC1Mb2NhdGlvbi1TcG9vZmVyLVdpZmktQ291bnQiXSA9IFN0cmluZyhpbmZvLndpZmlDb3VudCk7CiAgICAgIGhlYWRlcnNbIlgtTG9jYXRpb24tU3Bvb2Zlci1DZWxsLUNvdW50Il0gPSBTdHJpbmcoaW5mby5jZWxsQ291bnQgfHwgMCk7CiAgICB9CiAgICBpZiAoaW5mbyAmJiBpbmZvLnRhcmdldExhdCAhPSBudWxsICYmIGluZm8udGFyZ2V0TG5nICE9IG51bGwpIHsKICAgICAgaGVhZGVyc1siWC1Mb2NhdGlvbi1TcG9vZmVyLVRhcmdldCJdID0gU3RyaW5nKGluZm8udGFyZ2V0TGF0KSArICIsIiArIFN0cmluZyhpbmZvLnRhcmdldExuZyk7CiAgICB9CiAgICBpZiAoaXNMb29uUnVudGltZSgpKSB7CiAgICAgICRkb25lKHsKICAgICAgICBzdGF0dXM6ICgkcmVzcG9uc2UgJiYgJHJlc3BvbnNlLnN0YXR1cykgfHwgMjAwLAogICAgICAgIGhlYWRlcnM6IGhlYWRlcnMsCiAgICAgICAgYm9keTogYnl0ZXMKICAgICAgfSk7CiAgICAgIHJldHVybjsKICAgIH0KICAgICRkb25lKHsKICAgICAgaGVhZGVyczogaGVhZGVycywKICAgICAgYm9keTogYnl0ZXMKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gY29udGludWVSZXNwb25zZVJld3JpdGUoY29uZmlnKSB7CiAgICB2YXIgcmVzcG9uc2VCb2R5ID0gbWVzc2FnZUJvZHlUb0J5dGVzKCRyZXNwb25zZSk7CiAgICBpZiAoIXJlc3BvbnNlQm9keSB8fCByZXNwb25zZUJvZHkubGVuZ3RoIDwgMikgewogICAgICBpZiAoY29uZmlnLmRlYnVnKSB7CiAgICAgICAgY29uc29sZS5sb2coCiAgICAgICAgICAiTG9jYXRpb24gc3Bvb2ZlciByZXNwb25zZSBib2R5IHRvbyBzaG9ydDogIiArCiAgICAgICAgICAgIChyZXNwb25zZUJvZHkgPyByZXNwb25zZUJvZHkubGVuZ3RoIDogMCkgKwogICAgICAgICAgICAiIGJ5dGVzLCBoZWFkPSIgKwogICAgICAgICAgICAocmVzcG9uc2VCb2R5ID8gaGV4UHJldmlldyhyZXNwb25zZUJvZHkpIDogIjxub25lPiIpCiAgICAgICAgKTsKICAgICAgfQogICAgICBkb25lUGFzc1Rocm91Z2goKTsKICAgICAgcmV0dXJuOwogICAgfQogICAgaWYgKGNvbmZpZy5kZWJ1ZykgewogICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciByZXNwb25zZSBib2R5OiAiICsgcmVzcG9uc2VCb2R5Lmxlbmd0aCArICIgYnl0ZXMsIGhlYWQ9IiArIGhleFByZXZpZXcocmVzcG9uc2VCb2R5LCAzMikpOwogICAgICBpZiAoaXNMb29uUnVudGltZSgpKSB7CiAgICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcnVudGltZTogTG9vbiIpOwogICAgICB9CiAgICB9CiAgICBsb2dIdHRwRHVtcCgicmVzcG9uc2Utb3JpZ2luYWwiLCAkcmVzcG9uc2UsIGNvbmZpZyk7CiAgICBsb2dSYXdEdW1wKCJyZXNwb25zZS1vcmlnaW5hbCIsIHJlc3BvbnNlQm9keSwgY29uZmlnKTsKICAgIHZhciByZXNwb25zZVJlc3VsdCA9IHNwb29mQXBwbGVSZXNwb25zZShyZXNwb25zZUJvZHksIGNvbmZpZyk7CiAgICBpZiAoY29uZmlnLmRlYnVnKSB7CiAgICAgIGNvbnNvbGUubG9nKAogICAgICAgICJMb2NhdGlvbiBzcG9vZmVyIHBhdGNoZWQgIiArCiAgICAgICAgICByZXNwb25zZVJlc3VsdC53aWZpQ291bnQgKwogICAgICAgICAgIiB3aWZpIGRldmljZXMsICIgKwogICAgICAgICAgcmVzcG9uc2VSZXN1bHQuY2VsbENvdW50ICsKICAgICAgICAgICIgY2VsbCB0b3dlcnMsIGtpbmQ9IiArCiAgICAgICAgICByZXNwb25zZVJlc3VsdC5raW5kICsKICAgICAgICAgICIsIHByZWZpeD0iICsKICAgICAgICAgIChyZXNwb25zZVJlc3VsdC5wcmVmaXggfHwgIjxub25lPiIpICsKICAgICAgICAgICIsIHJlc3BvbnNlPSIgKwogICAgICAgICAgcmVzcG9uc2VSZXN1bHQucmVzcG9uc2UubGVuZ3RoICsKICAgICAgICAgICIgYnl0ZXMiCiAgICAgICk7CiAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIHBhdGNoZWQgbG9jYXRpb25zOiAiICsgcGF0Y2hlZFBheWxvYWRTdW1tYXJ5KHJlc3BvbnNlUmVzdWx0LnBheWxvYWQpKTsKICAgIH0KICAgIGxvZ1Jhd0R1bXAoInJlc3BvbnNlLXBhdGNoZWQiLCByZXNwb25zZVJlc3VsdC5yZXNwb25zZSwgY29uZmlnKTsKICAgIGRvbmVSZXdyaXRlUmVzcG9uc2UocmVzcG9uc2VSZXN1bHQucmVzcG9uc2UsIHsKICAgICAgd2lmaUNvdW50OiByZXNwb25zZVJlc3VsdC53aWZpQ291bnQsCiAgICAgIGNlbGxDb3VudDogcmVzcG9uc2VSZXN1bHQuY2VsbENvdW50LAogICAgICBkZWJ1ZzogY29uZmlnLmRlYnVnLAogICAgICB0YXJnZXRMYXQ6IGNvbmZpZy5sYXRpdHVkZSwKICAgICAgdGFyZ2V0TG5nOiBjb25maWcubG9uZ2l0dWRlCiAgICB9KTsKICB9CgogIGZ1bmN0aW9uIHByZXBhcmVSZXNwb25zZUJvZHkoY29uZmlnKSB7CiAgICBwcmVwYXJlUmVzcG9uc2VCb2R5U3luYyhjb25maWcpOwogIH0KCiAgZnVuY3Rpb24gcnVuU2hhZG93cm9ja2V0KCkgewogICAgdmFyIGhhc1JlcXVlc3QgPSB0eXBlb2YgJHJlcXVlc3QgIT09ICJ1bmRlZmluZWQiICYmICRyZXF1ZXN0ICE9IG51bGw7CiAgICB2YXIgaGFzUmVzcG9uc2UgPSB0eXBlb2YgJHJlc3BvbnNlICE9PSAidW5kZWZpbmVkIiAmJiAkcmVzcG9uc2UgIT0gbnVsbDsKCiAgICBpZiAoIWhhc1JlcXVlc3QgJiYgIWhhc1Jlc3BvbnNlKSB7CiAgICAgIHJ1bk1haW50ZW5hbmNlQ3JvbigpOwogICAgICByZXR1cm47CiAgICB9CgogICAgaWYgKGhhc1JlcXVlc3QgJiYgIWhhc1Jlc3BvbnNlKSB7CiAgICAgIHZhciBwcmVwQXJncyA9IHJlYWRTY3JpcHRBcmd1bWVudHMoKTsKICAgICAgaWYgKHBhcnNlQm9vbGVhbihwcmVwQXJncy5kZWJ1ZywgZmFsc2UpKSB7CiAgICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcHJlcGFyZSAtPiBBY2NlcHQtRW5jb2Rpbmc6IGlkZW50aXR5Iik7CiAgICAgIH0KICAgICAgZG9uZVByZXBhcmVkUmVxdWVzdFBhc3NUaHJvdWdoKCk7CiAgICAgIHJldHVybjsKICAgIH0KCiAgICBsb2FkUnVudGltZUNvbmZpZyhmdW5jdGlvbiAoY29uZmlnKSB7CiAgICAgIHRyeSB7CiAgICAgICAgaWYgKCFjb25maWcuZW5hYmxlZCkgewogICAgICAgICAgZG9uZVBhc3NUaHJvdWdoKCk7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQoKICAgICAgICBpZiAoY29uZmlnLm1vZGUgPT09ICJpbnNwZWN0IikgewogICAgICAgICAgZG9uZUluc3BlY3QoY29uZmlnLCBoYXNSZXNwb25zZSk7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQoKICAgICAgICBpZiAoaGFzUmVzcG9uc2UpIHsKICAgICAgICAgIGlmIChjb25maWcuZGVidWcpIHsKICAgICAgICAgICAgY29uc29sZS5sb2coCiAgICAgICAgICAgICAgIkxvY2F0aW9uIHNwb29mZXIgaW50ZXJjZXB0IC0+IGxhdD0iICsKICAgICAgICAgICAgICAgIGNvbmZpZy5sYXRpdHVkZSArCiAgICAgICAgICAgICAgICAiLCBsbmc9IiArCiAgICAgICAgICAgICAgICBjb25maWcubG9uZ2l0dWRlICsKICAgICAgICAgICAgICAgICIsIHVybD0iICsKICAgICAgICAgICAgICAgICgoJHJlcXVlc3QgJiYgJHJlcXVlc3QudXJsKSB8fCAiPG5vbmU+IikKICAgICAgICAgICAgKTsKICAgICAgICAgIH0KICAgICAgICAgIGlmIChjb25maWcubW9kZSA9PT0gInByb2JlIikgewogICAgICAgICAgICBkb25lUmVzcG9uc2VQcm9iZShjb25maWcpOwogICAgICAgICAgICByZXR1cm47CiAgICAgICAgICB9CiAgICAgICAgICBpZiAoY29uZmlnLm1vZGUgIT09ICJyZXNwb25zZSIpIHsKICAgICAgICAgICAgZG9uZVBhc3NUaHJvdWdoKCk7CiAgICAgICAgICAgIHJldHVybjsKICAgICAgICAgIH0KICAgICAgICAgIHByZXBhcmVSZXNwb25zZUJvZHkoY29uZmlnKTsKICAgICAgICAgIGNvbnRpbnVlUmVzcG9uc2VSZXdyaXRlKGNvbmZpZyk7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQoKICAgICAgICBpZiAoY29uZmlnLm1vZGUgIT09ICJyZXF1ZXN0IikgewogICAgICAgICAgZG9uZVBhc3NUaHJvdWdoKCk7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQogICAgICAgIHZhciByZXF1ZXN0Qm9keSA9IG1lc3NhZ2VCb2R5VG9CeXRlcygkcmVxdWVzdCk7CiAgICAgICAgaWYgKGNvbmZpZy5kZWJ1ZykgewogICAgICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcmVxdWVzdCBtb2RlIGJvZHkgbGVuZ3RoOiAiICsgKHJlcXVlc3RCb2R5ID8gcmVxdWVzdEJvZHkubGVuZ3RoIDogMCkpOwogICAgICAgIH0KICAgICAgICBpZiAoIXJlcXVlc3RCb2R5KSB7CiAgICAgICAgICBpZiAoY29uZmlnLmRlYnVnKSB7CiAgICAgICAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIHJlcXVlc3QgYm9keSB1bmF2YWlsYWJsZSIpOwogICAgICAgICAgfQogICAgICAgICAgZG9uZVBhc3NUaHJvdWdoKCk7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQogICAgICAgIGlmIChyZXF1ZXN0Qm9keS5sZW5ndGggPCAyKSB7CiAgICAgICAgICBpZiAoY29uZmlnLmRlYnVnKSB7CiAgICAgICAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIHJlcXVlc3QgYm9keSB0b28gc2hvcnQ6ICIgKyByZXF1ZXN0Qm9keS5sZW5ndGggKyAiIGJ5dGVzLCBoZWFkPSIgKyBoZXhQcmV2aWV3KHJlcXVlc3RCb2R5KSk7CiAgICAgICAgICB9CiAgICAgICAgICBkb25lUGFzc1Rocm91Z2goKTsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgICAgbG9nSHR0cER1bXAoInJlcXVlc3Qtb3JpZ2luYWwiLCAkcmVxdWVzdCwgY29uZmlnKTsKICAgICAgICBsb2dSYXdEdW1wKCJyZXF1ZXN0LW9yaWdpbmFsIiwgcmVxdWVzdEJvZHksIGNvbmZpZyk7CiAgICAgICAgdmFyIHJlcXVlc3RSZXN1bHQgPSBzcG9vZkFycGNSZXF1ZXN0KHJlcXVlc3RCb2R5LCBjb25maWcpOwogICAgICAgIGlmIChjb25maWcuZGVidWcpIHsKICAgICAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIHJlcXVlc3Qgc3ludGhldGljIHJlc3BvbnNlOiBwYXRjaGVkICIgKyByZXF1ZXN0UmVzdWx0LndpZmlDb3VudCArICIgd2lmaSBkZXZpY2VzLCAiICsgcmVxdWVzdFJlc3VsdC5jZWxsQ291bnQgKyAiIGNlbGwgdG93ZXJzLCByZXNwb25zZT0iICsgcmVxdWVzdFJlc3VsdC5yZXNwb25zZS5sZW5ndGggKyAiIGJ5dGVzIik7CiAgICAgICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBwYXRjaGVkIGxvY2F0aW9uczogIiArIHBhdGNoZWRQYXlsb2FkU3VtbWFyeShyZXF1ZXN0UmVzdWx0LnBheWxvYWQpKTsKICAgICAgICB9CiAgICAgICAgbG9nUmF3RHVtcCgicmVxdWVzdC1zeW50aGV0aWMtcmVzcG9uc2UiLCByZXF1ZXN0UmVzdWx0LnJlc3BvbnNlLCBjb25maWcpOwogICAgICAgIGRvbmVTeW50aGV0aWNSZXNwb25zZShyZXF1ZXN0UmVzdWx0LnJlc3BvbnNlLCB7CiAgICAgICAgICB3aWZpQ291bnQ6IHJlcXVlc3RSZXN1bHQud2lmaUNvdW50LAogICAgICAgICAgY2VsbENvdW50OiByZXF1ZXN0UmVzdWx0LmNlbGxDb3VudCwKICAgICAgICAgIGRlYnVnOiBjb25maWcuZGVidWcKICAgICAgICB9KTsKICAgICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgICAgaWYgKGNvbmZpZy5kZWJ1ZykgewogICAgICAgICAgdmFyIGRpYWdCb2R5ID0gaGFzUmVzcG9uc2UgPyBtZXNzYWdlQm9keVRvQnl0ZXMoJHJlc3BvbnNlKSA6IG1lc3NhZ2VCb2R5VG9CeXRlcygkcmVxdWVzdCk7CiAgICAgICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBmYWlsZWQ6ICIgKyBlcnIubWVzc2FnZSArICIgfCBib2R5TGVuPSIgKyAoZGlhZ0JvZHkgPyBkaWFnQm9keS5sZW5ndGggOiAwKSArICIgaGVhZD0iICsgKGRpYWdCb2R5ID8gaGV4UHJldmlldyhkaWFnQm9keSwgMzIpIDogIjxub25lPiIpKTsKICAgICAgICB9CiAgICAgICAgaWYgKGNvbmZpZy5mYWlsT3BlbiAhPT0gZmFsc2UpIHsKICAgICAgICAgIGRvbmVQYXNzVGhyb3VnaCgpOwogICAgICAgICAgcmV0dXJuOwogICAgICAgIH0KICAgICAgICAkZG9uZSh7CiAgICAgICAgICByZXNwb25zZTogewogICAgICAgICAgICBzdGF0dXM6ICJIVFRQLzEuMSA1MDAgSW50ZXJuYWwgU2VydmVyIEVycm9yIiwKICAgICAgICAgICAgaGVhZGVyczogeyAiQ29udGVudC1UeXBlIjogInRleHQvcGxhaW4iIH0sCiAgICAgICAgICAgIGJvZHk6ICJsb2NhdGlvbiBzcG9vZmVyIGZhaWxlZDogIiArIGVyci5tZXNzYWdlCiAgICAgICAgICB9CiAgICAgICAgfSk7CiAgICAgIH0KICAgIH0pOwogIH0KCiAgdmFyIGFwaSA9IHsKICAgIERFRkFVTFRfQ09ORklHOiBERUZBVUxUX0NPTkZJRywKICAgIEFQUExFX1dMT0NfUFJFRklYOiBBUFBMRV9XTE9DX1BSRUZJWCwKICAgIEFQUExFX1dMT0NfTUFSS0VSOiBBUFBMRV9XTE9DX01BUktFUiwKICAgIGJvZHlUb0J5dGVzOiBib2R5VG9CeXRlcywKICAgIG1lc3NhZ2VCb2R5VG9CeXRlczogbWVzc2FnZUJvZHlUb0J5dGVzLAogICAgaGV4UHJldmlldzogaGV4UHJldmlldywKICAgIGJ5dGVzVG9CaW5hcnlTdHJpbmc6IGJ5dGVzVG9CaW5hcnlTdHJpbmcsCiAgICBieXRlc1RvQmFzZTY0OiBieXRlc1RvQmFzZTY0LAogICAgYmluYXJ5U3RyaW5nVG9CeXRlczogYmluYXJ5U3RyaW5nVG9CeXRlcywKICAgIGNvbmNhdEJ5dGVzOiBjb25jYXRCeXRlcywKICAgIHJlYWRVSW50MTZCRTogcmVhZFVJbnQxNkJFLAogICAgd3JpdGVVSW50MTZCRTogd3JpdGVVSW50MTZCRSwKICAgIGVuY29kZVZhcmludFVuc2lnbmVkOiBlbmNvZGVWYXJpbnRVbnNpZ25lZCwKICAgIGVuY29kZVZhcmludFNpZ25lZEludDY0OiBlbmNvZGVWYXJpbnRTaWduZWRJbnQ2NCwKICAgIGRlY29kZVZhcmludDogZGVjb2RlVmFyaW50LAogICAgbWFrZVZhcmludEZpZWxkOiBtYWtlVmFyaW50RmllbGQsCiAgICBtYWtlTGVuZ3RoRGVsaW1pdGVkRmllbGQ6IG1ha2VMZW5ndGhEZWxpbWl0ZWRGaWVsZCwKICAgIHBhcnNlRmllbGRzOiBwYXJzZUZpZWxkcywKICAgIHRyeVBhcnNlRmllbGRzOiB0cnlQYXJzZUZpZWxkcywKICAgIGZpcnN0RmllbGRCeU51bWJlcjogZmlyc3RGaWVsZEJ5TnVtYmVyLAogICAgbG9jYXRpb25TdW1tYXJ5OiBsb2NhdGlvblN1bW1hcnksCiAgICBwYXRjaGVkUGF5bG9hZFN1bW1hcnk6IHBhdGNoZWRQYXlsb2FkU3VtbWFyeSwKICAgIGNvb3JkVG9JbnQ6IGNvb3JkVG9JbnQsCiAgICBub3JtYWxpemVDb25maWc6IG5vcm1hbGl6ZUNvbmZpZywKICAgIHBhdGNoTG9jYXRpb246IHBhdGNoTG9jYXRpb24sCiAgICBwYXRjaFdpZmlEZXZpY2U6IHBhdGNoV2lmaURldmljZSwKICAgIHBhdGNoQ2VsbFRvd2VyOiBwYXRjaENlbGxUb3dlciwKICAgIHBhdGNoQXBwbGVXTG9jUGF5bG9hZDogcGF0Y2hBcHBsZVdMb2NQYXlsb2FkLAogICAgcGFyc2VBcnBjOiBwYXJzZUFycGMsCiAgICBzZXJpYWxpemVBcnBjOiBzZXJpYWxpemVBcnBjLAogICAgYnVpbGRBcHBsZVdMb2NSZXNwb25zZTogYnVpbGRBcHBsZVdMb2NSZXNwb25zZSwKICAgIGV4dHJhY3RBcHBsZVdMb2NQYXlsb2FkOiBleHRyYWN0QXBwbGVXTG9jUGF5bG9hZCwKICAgIHNwb29mQXJwY1JlcXVlc3Q6IHNwb29mQXJwY1JlcXVlc3QsCiAgICBzcG9vZkFwcGxlUmVzcG9uc2U6IHNwb29mQXBwbGVSZXNwb25zZSwKICAgIHBhcnNlQXJndW1lbnRTdHJpbmc6IHBhcnNlQXJndW1lbnRTdHJpbmcsCiAgICByZWFkU2NyaXB0QXJndW1lbnRzOiByZWFkU2NyaXB0QXJndW1lbnRzLAogICAgZ2VvY29kZUFkZHJlc3M6IGdlb2NvZGVBZGRyZXNzLAogICAgcHJlcGFyZVJlcXVlc3RIZWFkZXJzOiBwcmVwYXJlUmVxdWVzdEhlYWRlcnMKICB9OwoKICBpZiAodHlwZW9mIG1vZHVsZSAhPT0gInVuZGVmaW5lZCIgJiYgbW9kdWxlLmV4cG9ydHMpIHsKICAgIG1vZHVsZS5leHBvcnRzID0gYXBpOwogIH0gZWxzZSB7CiAgICBydW5TaGFkb3dyb2NrZXQoKTsKICB9Cn0oKSk7Cg==";
const LOCATION_SETTINGS_B64 = "LyoKICogbG9jYXRpb24tc2V0dGluZ3MuanMg4oCUIHN0YXRlbGVzcyBzYXZlLWludGVyY2VwdG9yIGZvciBpT1MgTG9jYXRpb24gU3Bvb2Zlci4KICoKICogUnVucyBhcyBhbiBodHRwLVJFUVVFU1Qgc2NyaXB0IG9uIGdzLWxvYy5hcHBsZS5jb20vaWxzLXNldHRpbmdzL+KApiBhbmQgYW5zd2VycyB0aGUKICogcmVxdWVzdCBpdHNlbGYgKG5ldmVyIGhpdHMgQXBwbGUpLiBJdCB3cml0ZXMgdGhlIHBpY2tlZCBwb2ludCBpbnRvIFRISVMgZGV2aWNlJ3Mgb3duCiAqICRwZXJzaXN0ZW50U3RvcmUsIHVzaW5nIHRoZSBleGFjdCBrZXlzIGxvY2F0aW9uLXNwb29mZXIuanMgYWxyZWFkeSByZWFkcyB2aWEKICogZW5yaWNoQXJnc0Zyb21QbHVnaW5TdG9yZTogYGxhdGl0dWRlYCwgYGxvbmdpdHVkZWAsIGBhbHRpdHVkZWAsIGBlbmFibGVkYC4KICoKICogTm90aGluZyBpcyBzdG9yZWQgc2VydmVyLXNpZGUsIHNvIG9uZSBwdWJsaWMgcGlja2VyIHBhZ2UgY2FuIGJlIHNoYXJlZCBieSBhbnkgbnVtYmVyIG9mCiAqIHBlb3BsZSDigJQgZWFjaCBwZXJzb24gd3JpdGVzIG9ubHkgdGhlaXIgb3duIGRldmljZS4gYGVuYWJsZWRgIGdhdGVzIHNwb29maW5nOiBjbGVhcmVkIC8KICogbmV2ZXItcGlja2VkIOKGkiBlbmFibGVkPWZhbHNlIOKGkiBsb2NhdGlvbi1zcG9vZmVyLmpzIHBhc3NlcyB0aHJvdWdoIHRoZSByZWFsIGxvY2F0aW9uCiAqICh0aGlzIHBhaXJzIHdpdGggREVGQVVMVF9DT05GSUcuZW5hYmxlZD1mYWxzZSBpbiBsb2NhdGlvbi1zcG9vZmVyLmpzKS4KICoKICogICBHRVQg4oCmL2lscy1zZXR0aW5ncy9zYXZlP2xhdD0mbG9uPSZhbHQ9ICAg4oaSIHN0b3JlIGNvb3JkcyAoK2FsdGl0dWRlKSBhbmQgZW5hYmxlCiAqICAgR0VUIOKApi9pbHMtc2V0dGluZ3Mvc2F2ZT9hY3Rpb249cXVlcnkgICAgICDihpIgcmV0dXJuIHRoZSBkZXZpY2UncyBjdXJyZW50IHN0b3JlZCBwb2ludAogKiAgIEdFVCDigKYvaWxzLXNldHRpbmdzL3NhdmU/YWN0aW9uPWNsZWFyICAgICAg4oaSIGVuYWJsZWQ9ZmFsc2UgKHJlc3RvcmUgcmVhbCBsb2NhdGlvbikKICoKICogU3VwcG9ydGVkIGNsaWVudHM6IFN1cmdlIC8gU2hhZG93cm9ja2V0IC8gTG9vbiAvIFN0YXNoIC8gRWdlcm4gKCRwZXJzaXN0ZW50U3RvcmUpIGFuZAogKiBRdWFudHVtdWx0IFggKCRwcmVmcykuCiAqCiAqIENTUkYgZ3VhcmQ6IHdoZW4gYW4gYWxsb3dlZCBvcmlnaW4gaXMgY29uZmlndXJlZCAobW9kdWxlIGFyZ3VtZW50IGBvcmlnaW49aHR0cHM6Ly/igKZgLCBvcgogKiBpbmplY3RlZCBieSB0aGUgV29ya2VyIHdoZW4gaXQgc2VydmVzIHRoaXMgZmlsZSksIGEgcmVxdWVzdCB3aG9zZSBPcmlnaW4gLyBSZWZlcmVyIGRvZXMKICogbm90IG1hdGNoIGlzIHJlZnVzZWQgYW5kIENPUlMgaXMgbGltaXRlZCB0byB0aGF0IG9yaWdpbi4gUmVxdWVzdHMgd2l0aCBuZWl0aGVyIGhlYWRlcgogKiAoaU9TIFNob3J0Y3V0cyAiR2V0IENvbnRlbnRzIG9mIFVSTCIpIGFyZSBzdGlsbCBhbGxvd2VkIHVubGVzcyBhIGJyb3dzZXIgbWFya3MgdGhlbSBhcwogKiBjcm9zcy1zaXRlIHZpYSBTZWMtRmV0Y2gtU2l0ZS4gV2l0aCBubyBvcmlnaW4gY29uZmlndXJlZCB0aGUgb2xkIG9wZW4gYmVoYXZpb3VyIGlzIGtlcHQuCiAqLwooZnVuY3Rpb24gKCkgewogICJ1c2Ugc3RyaWN0IjsKCiAgdmFyIGlzUXVhblggPSB0eXBlb2YgJHRhc2sgIT09ICJ1bmRlZmluZWQiOwoKICBmdW5jdGlvbiByZWFkS2V5KGspIHsKICAgIHRyeSB7CiAgICAgIHJldHVybiBpc1F1YW5YID8gJHByZWZzLnZhbHVlRm9yS2V5KGspIDogJHBlcnNpc3RlbnRTdG9yZS5yZWFkKGspOwogICAgfSBjYXRjaCAoZSkgewogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICB9CiAgZnVuY3Rpb24gd3JpdGVLZXkoaywgdikgewogICAgdHJ5IHsKICAgICAgcmV0dXJuIGlzUXVhblggPyAkcHJlZnMuc2V0VmFsdWVGb3JLZXkoU3RyaW5nKHYpLCBrKSA6ICRwZXJzaXN0ZW50U3RvcmUud3JpdGUoU3RyaW5nKHYpLCBrKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgcmV0dXJuIGZhbHNlOwogICAgfQogIH0KCiAgZnVuY3Rpb24gcGFyc2VRdWVyeSh1cmwpIHsKICAgIHZhciBvdXQgPSB7fTsKICAgIHZhciBxaSA9IHVybC5pbmRleE9mKCI/Iik7CiAgICBpZiAocWkgPCAwKSByZXR1cm4gb3V0OwogICAgdmFyIHBhcnRzID0gdXJsLnNsaWNlKHFpICsgMSkuc3BsaXQoIiYiKTsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgcGFydHMubGVuZ3RoOyBpICs9IDEpIHsKICAgICAgaWYgKCFwYXJ0c1tpXSkgY29udGludWU7CiAgICAgIHZhciBlcSA9IHBhcnRzW2ldLmluZGV4T2YoIj0iKTsKICAgICAgdmFyIGsgPSBlcSA8IDAgPyBwYXJ0c1tpXSA6IHBhcnRzW2ldLnNsaWNlKDAsIGVxKTsKICAgICAgdmFyIHYgPSBlcSA8IDAgPyAiIiA6IHBhcnRzW2ldLnNsaWNlKGVxICsgMSk7CiAgICAgIHRyeSB7IGsgPSBkZWNvZGVVUklDb21wb25lbnQoay5yZXBsYWNlKC9cKy9nLCAiICIpKTsgfSBjYXRjaCAoZSkge30KICAgICAgdHJ5IHsgdiA9IGRlY29kZVVSSUNvbXBvbmVudCh2LnJlcGxhY2UoL1wrL2csICIgIikpOyB9IGNhdGNoIChlKSB7fQogICAgICBpZiAoIShrIGluIG91dCkpIG91dFtrXSA9IHY7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgZnVuY3Rpb24gZmluaXRlTnVtKHMpIHsKICAgIGlmIChzID09IG51bGwgfHwgcyA9PT0gIiIpIHJldHVybiBOYU47CiAgICB2YXIgbiA9IHBhcnNlRmxvYXQocyk7CiAgICByZXR1cm4gaXNGaW5pdGUobikgPyBuIDogTmFOOwogIH0KCiAgLy8gUmVwbGFjZWQgYnkgdGhlIFdvcmtlciB3aXRoIEpTT04gb2YgaXRzIG93biBvcmlnaW4gd2hlbiBzZXJ2aW5nIC9sb2NhdGlvbi1zZXR0aW5ncy5qcy4KICB2YXIgSU5KRUNURURfT1JJR0lOID0gLypfX0lMU19BTExPV0VEX09SSUdJTl9fKi8iIjsKCiAgZnVuY3Rpb24gb3JpZ2luT2YodSkgewogICAgdmFyIG0gPSAvXihodHRwcz86XC9cL1teXC8/I10rKS9pLmV4ZWMoU3RyaW5nKHUgfHwgIiIpLnRyaW0oKSk7CiAgICByZXR1cm4gbSA/IG1bMV0udG9Mb3dlckNhc2UoKS5yZXBsYWNlKC9cLyskLywgIiIpIDogIiI7CiAgfQoKICBmdW5jdGlvbiBnZXRIZWFkZXIoaGVhZGVycywgbmFtZSkgewogICAgaWYgKCFoZWFkZXJzKSByZXR1cm4gIiI7CiAgICB2YXIgbG5hbWUgPSBuYW1lLnRvTG93ZXJDYXNlKCk7CiAgICBmb3IgKHZhciBrIGluIGhlYWRlcnMpIHsKICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChoZWFkZXJzLCBrKSAmJiBTdHJpbmcoaykudG9Mb3dlckNhc2UoKSA9PT0gbG5hbWUpIHsKICAgICAgICByZXR1cm4gaGVhZGVyc1trXSA9PSBudWxsID8gIiIgOiBTdHJpbmcoaGVhZGVyc1trXSk7CiAgICAgIH0KICAgIH0KICAgIHJldHVybiAiIjsKICB9CgogIC8vIE1vZHVsZSBhcmd1bWVudCAoU3VyZ2UvTG9vbi9TdGFzaC9TaGFkb3dyb2NrZXQpIHdpbnMgb3ZlciB0aGUgV29ya2VyLWluamVjdGVkIG9yaWdpbi4KICBmdW5jdGlvbiBjb25maWd1cmVkT3JpZ2luKCkgewogICAgdmFyIGFyZyA9IHR5cGVvZiAkYXJndW1lbnQgIT09ICJ1bmRlZmluZWQiICYmICRhcmd1bWVudCA/ICRhcmd1bWVudCA6ICIiOwogICAgaWYgKGFyZyAmJiB0eXBlb2YgYXJnID09PSAib2JqZWN0IikgYXJnID0gYXJnLm9yaWdpbiB8fCAiIjsKICAgIHZhciBmcm9tQXJnID0gdHlwZW9mIGFyZyA9PT0gInN0cmluZyIgPyBvcmlnaW5PZihwYXJzZVF1ZXJ5KCI/IiArIGFyZykub3JpZ2luIHx8ICIiKSA6ICIiOwogICAgcmV0dXJuIGZyb21BcmcgfHwgb3JpZ2luT2YoSU5KRUNURURfT1JJR0lOKTsKICB9CgogIC8vIHRydWUgPSByZXF1ZXN0IG1heSBwcm9jZWVkLgogIGZ1bmN0aW9uIG9yaWdpbkFsbG93ZWQoYWxsb3dlZCwgaGVhZGVycykgewogICAgaWYgKCFhbGxvd2VkKSByZXR1cm4gdHJ1ZTsgLy8gbm90aGluZyBjb25maWd1cmVkOiBiYWNrd2FyZCBjb21wYXRpYmxlIChvcGVuKQogICAgdmFyIG9yaWdpbiA9IGdldEhlYWRlcihoZWFkZXJzLCAiT3JpZ2luIik7CiAgICBpZiAob3JpZ2luICYmIG9yaWdpbiAhPT0gIm51bGwiKSByZXR1cm4gb3JpZ2luT2Yob3JpZ2luKSA9PT0gYWxsb3dlZDsKICAgIHZhciByZWZlcmVyID0gZ2V0SGVhZGVyKGhlYWRlcnMsICJSZWZlcmVyIik7CiAgICBpZiAocmVmZXJlcikgcmV0dXJuIG9yaWdpbk9mKHJlZmVyZXIpID09PSBhbGxvd2VkOwogICAgaWYgKG9yaWdpbiA9PT0gIm51bGwiKSByZXR1cm4gZmFsc2U7CiAgICAvLyBObyBPcmlnaW4gYW5kIG5vIFJlZmVyZXI6IG5vbi1icm93c2VyIGNsaWVudHMgKGlPUyBTaG9ydGN1dHMpIGxhbmQgaGVyZS4gQSBicm93c2VyCiAgICAvLyB0aGF0IHN0cmlwcGVkIHRoZSBSZWZlcmVyIHN0aWxsIHNlbmRzIFNlYy1GZXRjaC1TaXRlLCBzbyByZWZ1c2UgYW55dGhpbmcgYnV0ICJub25lIi4KICAgIHZhciBzZnMgPSBnZXRIZWFkZXIoaGVhZGVycywgIlNlYy1GZXRjaC1TaXRlIikudG9Mb3dlckNhc2UoKTsKICAgIHJldHVybiAhc2ZzIHx8IHNmcyA9PT0gIm5vbmUiIHx8IHNmcyA9PT0gInNhbWUtb3JpZ2luIjsKICB9CgogIHZhciByZXEgPSB0eXBlb2YgJHJlcXVlc3QgIT09ICJ1bmRlZmluZWQiICYmICRyZXF1ZXN0ID8gJHJlcXVlc3QgOiB7fTsKICB2YXIgdXJsID0gcmVxLnVybCB8fCAiIjsKICB2YXIgcSA9IHBhcnNlUXVlcnkodXJsKTsKICB2YXIgYWN0aW9uID0gcS5hY3Rpb24gfHwgInNhdmUiOwogIHZhciByZXN1bHQ7CiAgdmFyIHN0YXR1cyA9IDIwMDsKICB2YXIgYWxsb3dlZE9yaWdpbiA9IGNvbmZpZ3VyZWRPcmlnaW4oKTsKCiAgaWYgKCFvcmlnaW5BbGxvd2VkKGFsbG93ZWRPcmlnaW4sIHJlcS5oZWFkZXJzKSkgewogICAgc3RhdHVzID0gNDAzOwogICAgcmVzdWx0ID0geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6ICLkvobmupDntrLln5/kuI3lhYHoqLEiIH07CiAgfSBlbHNlIGlmIChhY3Rpb24gPT09ICJxdWVyeSIpIHsKICAgIHZhciBxbGF0ID0gcmVhZEtleSgibGF0aXR1ZGUiKTsKICAgIHZhciBxbG9uID0gcmVhZEtleSgibG9uZ2l0dWRlIik7CiAgICB2YXIgcWFsdCA9IHJlYWRLZXkoImFsdGl0dWRlIik7CiAgICB2YXIgcWVuID0gcmVhZEtleSgiZW5hYmxlZCIpOwogICAgdmFyIHFoYWNjID0gcmVhZEtleSgiaG9yaXpvbnRhbEFjY3VyYWN5Iik7CiAgICB2YXIgcXZhY2MgPSByZWFkS2V5KCJ2ZXJ0aWNhbEFjY3VyYWN5Iik7CiAgICB2YXIgcXJyID0gcmVhZEtleSgicmFuZG9tUmFkaXVzIik7CiAgICBpZiAocWxhdCAhPSBudWxsICYmIHFsYXQgIT09ICIiICYmIHFsb24gIT0gbnVsbCAmJiBxbG9uICE9PSAiIikgewogICAgICByZXN1bHQgPSB7CiAgICAgICAgc3VjY2VzczogdHJ1ZSwKICAgICAgICBsYXRpdHVkZTogTnVtYmVyKHFsYXQpLAogICAgICAgIGxvbmdpdHVkZTogTnVtYmVyKHFsb24pLAogICAgICAgIGFsdGl0dWRlOiBxYWx0ICE9IG51bGwgJiYgcWFsdCAhPT0gIiIgPyBOdW1iZXIocWFsdCkgOiBudWxsLAogICAgICAgIGhvcml6b250YWxBY2N1cmFjeTogcWhhY2MgIT0gbnVsbCAmJiBxaGFjYyAhPT0gIiIgPyBOdW1iZXIocWhhY2MpIDogbnVsbCwKICAgICAgICB2ZXJ0aWNhbEFjY3VyYWN5OiBxdmFjYyAhPSBudWxsICYmIHF2YWNjICE9PSAiIiA/IE51bWJlcihxdmFjYykgOiBudWxsLAogICAgICAgIHJhbmRvbVJhZGl1czogcXJyICE9IG51bGwgJiYgcXJyICE9PSAiIiA/IE51bWJlcihxcnIpIDogbnVsbCwKICAgICAgICBlbmFibGVkOiBTdHJpbmcocWVuKSA9PT0gInRydWUiCiAgICAgIH07CiAgICB9IGVsc2UgewogICAgICByZXN1bHQgPSB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogIuWwmuacquWEsuWtmOW6p+aomSIgfTsKICAgIH0KICB9IGVsc2UgaWYgKGFjdGlvbiA9PT0gImNsZWFyIikgewogICAgd3JpdGVLZXkoImVuYWJsZWQiLCAiZmFsc2UiKTsKICAgIHJlc3VsdCA9IHsgc3VjY2VzczogdHJ1ZSB9OwogIH0gZWxzZSB7CiAgICB2YXIgbG9uID0gZmluaXRlTnVtKHEubG9uICE9IG51bGwgPyBxLmxvbiA6IHEubG9uZ2l0dWRlKTsKICAgIHZhciBsYXQgPSBmaW5pdGVOdW0ocS5sYXQgIT0gbnVsbCA/IHEubGF0IDogcS5sYXRpdHVkZSk7CiAgICB2YXIgYWx0ID0gZmluaXRlTnVtKHEuYWx0ICE9IG51bGwgPyBxLmFsdCA6IHEuYWx0aXR1ZGUpOwogICAgdmFyIGhhY2MgPSBmaW5pdGVOdW0ocS5oYWNjICE9IG51bGwgPyBxLmhhY2MgOiBxLmhvcml6b250YWxBY2N1cmFjeSk7CiAgICB2YXIgdmFjYyA9IGZpbml0ZU51bShxLnZhY2MgIT0gbnVsbCA/IHEudmFjYyA6IHEudmVydGljYWxBY2N1cmFjeSk7CiAgICB2YXIgcnIgPSBmaW5pdGVOdW0ocS5yciAhPSBudWxsID8gcS5yciA6IHEucmFuZG9tUmFkaXVzKTsKICAgIGlmIChpc0Zpbml0ZShsb24pICYmIGlzRmluaXRlKGxhdCkgJiYgKE1hdGguYWJzKGxhdCkgPiA5MCB8fCBNYXRoLmFicyhsb24pID4gMTgwKSkgewogICAgICByZXN1bHQgPSB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogIue2k+e3r+W6pui2heWHuuevhOWcjSIgfTsKICAgIH0gZWxzZSBpZiAoaXNGaW5pdGUobG9uKSAmJiBpc0Zpbml0ZShsYXQpKSB7CiAgICAgIHdyaXRlS2V5KCJsYXRpdHVkZSIsIFN0cmluZyhsYXQpKTsKICAgICAgd3JpdGVLZXkoImxvbmdpdHVkZSIsIFN0cmluZyhsb24pKTsKICAgICAgaWYgKGlzRmluaXRlKGFsdCkpIHdyaXRlS2V5KCJhbHRpdHVkZSIsIFN0cmluZyhNYXRoLnJvdW5kKGFsdCkpKTsKICAgICAgaWYgKGlzRmluaXRlKGhhY2MpKSB3cml0ZUtleSgiaG9yaXpvbnRhbEFjY3VyYWN5IiwgU3RyaW5nKE1hdGgucm91bmQoaGFjYykpKTsKICAgICAgaWYgKGlzRmluaXRlKHZhY2MpKSB3cml0ZUtleSgidmVydGljYWxBY2N1cmFjeSIsIFN0cmluZyhNYXRoLnJvdW5kKHZhY2MpKSk7CiAgICAgIC8vIHJhbmRvbVJhZGl1czogMCBpcyBhIHZhbGlkIHZhbHVlIChvZmYpLCBzbyB3cml0ZSB3aGVuZXZlciB0aGUgcGlja2VyIHNlbmRzIGl0LgogICAgICBpZiAoaXNGaW5pdGUocnIpKSB3cml0ZUtleSgicmFuZG9tUmFkaXVzIiwgU3RyaW5nKE1hdGgubWF4KDAsIE1hdGgucm91bmQocnIpKSkpOwogICAgICB3cml0ZUtleSgiZW5hYmxlZCIsICJ0cnVlIik7CiAgICAgIHJlc3VsdCA9IHsgc3VjY2VzczogdHJ1ZSwgbGF0aXR1ZGU6IGxhdCwgbG9uZ2l0dWRlOiBsb24gfTsKICAgICAgaWYgKGlzRmluaXRlKGFsdCkpIHJlc3VsdC5hbHRpdHVkZSA9IE1hdGgucm91bmQoYWx0KTsKICAgICAgaWYgKGlzRmluaXRlKGhhY2MpKSByZXN1bHQuaG9yaXpvbnRhbEFjY3VyYWN5ID0gTWF0aC5yb3VuZChoYWNjKTsKICAgICAgaWYgKGlzRmluaXRlKHZhY2MpKSByZXN1bHQudmVydGljYWxBY2N1cmFjeSA9IE1hdGgucm91bmQodmFjYyk7CiAgICAgIGlmIChpc0Zpbml0ZShycikpIHJlc3VsdC5yYW5kb21SYWRpdXMgPSBNYXRoLm1heCgwLCBNYXRoLnJvdW5kKHJyKSk7CiAgICB9IGVsc2UgewogICAgICByZXN1bHQgPSB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogIue8uuWwkSBsYXQvbG9uIOWPg+aVuCIgfTsKICAgIH0KICB9CgogIHZhciBoZWFkZXJzID0gewogICAgIkNvbnRlbnQtVHlwZSI6ICJhcHBsaWNhdGlvbi9qc29uIiwKICAgICJBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4iOiBhbGxvd2VkT3JpZ2luIHx8ICIqIiwKICAgICJBY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzIjogIkdFVCwgT1BUSU9OUyIKICB9OwogIGlmIChhbGxvd2VkT3JpZ2luKSBoZWFkZXJzWyJWYXJ5Il0gPSAiT3JpZ2luIjsKICB2YXIgYm9keSA9IEpTT04uc3RyaW5naWZ5KHJlc3VsdCk7CgogIGlmIChpc1F1YW5YKSB7CiAgICAkZG9uZSh7IHN0YXR1czogc3RhdHVzID09PSAyMDAgPyAiSFRUUC8xLjEgMjAwIE9LIiA6ICJIVFRQLzEuMSA0MDMgRm9yYmlkZGVuIiwgaGVhZGVyczogaGVhZGVycywgYm9keTogYm9keSB9KTsKICB9IGVsc2UgewogICAgJGRvbmUoeyByZXNwb25zZTogeyBzdGF0dXM6IHN0YXR1cywgaGVhZGVyczogaGVhZGVycywgYm9keTogYm9keSB9IH0pOwogIH0KfSkoKTsK";
const LOCATION_SPOOFER_QX_B64 = "LyoKICogUVgg55qEICRyZXNwb25zZS5ib2R5IOe7meeahOaYryBiYXNlNjQg5a2X56ym5Liy77yI5LiN5pivIFVpbnQ4QXJyYXnvvInvvIwKICog5omA5Lul6L+Z54mI5aSa5LqG5LiA5q2lIGJhc2U2NCDihpQgYnl0ZXMg55qE6L2s5o2i77yM5YW25LuW6YC76L6R5ZKM5Li754mI5LiA5qC344CCCiAqLwooZnVuY3Rpb24gKCkgewogICJ1c2Ugc3RyaWN0IjsKCiAgdmFyIERFRkFVTFRfQ09ORklHID0gewogICAgLy8gU3RhdGVsZXNzIGRlZmF1bHQ6IE9GRiB1bnRpbCB0aGUgcGlja2VyIHdyaXRlcyBjb29yZGluYXRlcyB0byB0aGlzIGRldmljZSdzIG93bgogICAgLy8gJHByZWZzLiAiTm90aGluZyBwaWNrZWQgeWV0IiB0aGVuIGZhbGxzIHRocm91Z2ggdG8gdGhlIHJlYWwgbG9jYXRpb24uCiAgICBlbmFibGVkOiBmYWxzZSwKICAgIGxhdGl0dWRlOiAzNy4zMzQ5LAogICAgbG9uZ2l0dWRlOiAtMTIyLjAwOTAyLAogICAgaG9yaXpvbnRhbEFjY3VyYWN5OiAzOSwKICAgIHZlcnRpY2FsQWNjdXJhY3k6IDEwMDAsCiAgICAvLyBSYW5kb20gcGVydHVyYmF0aW9uIHJhZGl1cyBpbiBtZXRyZXMgKFl1OTE5MSB2MS4xICLmibDliqjljYrlvoQiKS4gMCA9IG9mZi4gV3JpdHRlbgogICAgLy8gcGVyLWRldmljZSBieSB0aGUgcGlja2VyIHZpYSBsb2NhdGlvbi1zZXR0aW5ncy5qcyAoJHByZWZzKS4KICAgIHJhbmRvbVJhZGl1czogMCwKICAgIGFsdGl0dWRlOiA1MzAsCiAgICB1bmtub3duVmFsdWU0OiAzLAogICAgbW90aW9uQWN0aXZpdHlUeXBlOiA2MywKICAgIG1vdGlvbkFjdGl2aXR5Q29uZmlkZW5jZTogNDY3LAogICAgZmFpbE9wZW46IHRydWUsCiAgICBkZWJ1ZzogZmFsc2UKICB9OwoKICB2YXIgQVBQTEVfV0xPQ19QUkVGSVggPSBuZXcgVWludDhBcnJheShbMHgwMCwgMHgwMSwgMHgwMCwgMHgwMCwgMHgwMCwgMHgwMSwgMHgwMCwgMHgwMF0pOwogIHZhciBBUFBMRV9XTE9DX01BUktFUiA9IG5ldyBVaW50OEFycmF5KFsweDAwLCAweDAwLCAweDAwLCAweDAxLCAweDAwLCAweDAwXSk7CiAgdmFyIFJPT1RfRFJPUF9GSUVMRFMgPSB7IDM6IHRydWUsIDQ6IHRydWUsIDMzOiB0cnVlIH07CiAgdmFyIENFTExfUkVTUE9OU0VfRklFTERTID0geyAyMjogdHJ1ZSwgMjQ6IHRydWUgfTsKICB2YXIgTE9DQVRJT05fUkVQTEFDRURfRklFTERTID0geyAxOiB0cnVlLCAyOiB0cnVlLCAzOiB0cnVlLCA0OiB0cnVlLCA1OiB0cnVlLCA2OiB0cnVlLCAxMTogdHJ1ZSwgMTI6IHRydWUgfTsKCiAgLy8gPT09PT09PT09PSBCeXRlIFV0aWxpdGllcyA9PT09PT09PT09CgogIGZ1bmN0aW9uIGNvbmNhdEJ5dGVzKHBhcnRzKSB7CiAgICB2YXIgdG90YWwgPSAwLCBpOwogICAgZm9yIChpID0gMDsgaSA8IHBhcnRzLmxlbmd0aDsgaSsrKSB0b3RhbCArPSBwYXJ0c1tpXS5sZW5ndGg7CiAgICB2YXIgb3V0ID0gbmV3IFVpbnQ4QXJyYXkodG90YWwpLCBvZmZzZXQgPSAwOwogICAgZm9yIChpID0gMDsgaSA8IHBhcnRzLmxlbmd0aDsgaSsrKSB7IG91dC5zZXQocGFydHNbaV0sIG9mZnNldCk7IG9mZnNldCArPSBwYXJ0c1tpXS5sZW5ndGg7IH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICBmdW5jdGlvbiBmaW5kQnl0ZXMoYnl0ZXMsIG1hcmtlcikgewogICAgaWYgKCFieXRlcyB8fCAhbWFya2VyIHx8IG1hcmtlci5sZW5ndGggPT09IDApIHJldHVybiAtMTsKICAgIGZvciAodmFyIGkgPSAwOyBpIDw9IGJ5dGVzLmxlbmd0aCAtIG1hcmtlci5sZW5ndGg7IGkrKykgewogICAgICB2YXIgb2sgPSB0cnVlOwogICAgICBmb3IgKHZhciBqID0gMDsgaiA8IG1hcmtlci5sZW5ndGg7IGorKykgeyBpZiAoYnl0ZXNbaSArIGpdICE9PSBtYXJrZXJbal0pIHsgb2sgPSBmYWxzZTsgYnJlYWs7IH0gfQogICAgICBpZiAob2spIHJldHVybiBpOwogICAgfQogICAgcmV0dXJuIC0xOwogIH0KCiAgZnVuY3Rpb24gaGV4UHJldmlldyhieXRlcywgbGltaXQpIHsKICAgIGlmICghYnl0ZXMpIHJldHVybiAiPG5vbmU+IjsKICAgIHZhciBvdXQgPSBbXSwgbWF4ID0gTWF0aC5taW4oYnl0ZXMubGVuZ3RoLCBsaW1pdCB8fCAxNik7CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IG1heDsgaSsrKSBvdXQucHVzaCgoIjAiICsgYnl0ZXNbaV0udG9TdHJpbmcoMTYpKS5zbGljZSgtMikpOwogICAgcmV0dXJuIG91dC5qb2luKCIiKTsKICB9CgogIC8vID09PT09PT09PT0gQmFzZTY0IChRWCDkuJPnlKgpID09PT09PT09PT0KCiAgZnVuY3Rpb24gYmFzZTY0VG9CeXRlcyhiNjQpIHsKICAgIHZhciBhbHBoYWJldCA9ICJBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWmFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6MDEyMzQ1Njc4OSsvIjsKICAgIHZhciBsb29rdXAgPSB7fSwgaTsKICAgIGZvciAoaSA9IDA7IGkgPCBhbHBoYWJldC5sZW5ndGg7IGkrKykgbG9va3VwW2FscGhhYmV0W2ldXSA9IGk7CiAgICBiNjQgPSBiNjQucmVwbGFjZSgvW15BLVphLXowLTlcK1wvXS9nLCAiIik7CiAgICB2YXIgbGVuID0gYjY0Lmxlbmd0aCwgb3V0ID0gW10sIHBhZGRpbmcgPSAwOwogICAgaWYgKGxlbiA+IDAgJiYgYjY0W2xlbiAtIDFdID09PSAiPSIpIHBhZGRpbmcrKzsKICAgIGlmIChsZW4gPiAxICYmIGI2NFtsZW4gLSAyXSA9PT0gIj0iKSBwYWRkaW5nKys7CiAgICB2YXIgYnVmTGVuID0gKGxlbiAvIDQpICogMyAtIHBhZGRpbmc7CiAgICB2YXIgYnVmID0gbmV3IFVpbnQ4QXJyYXkoYnVmTGVuKSwgcG9zID0gMDsKICAgIGZvciAoaSA9IDA7IGkgPCBsZW47IGkgKz0gNCkgewogICAgICB2YXIgZW5jMSA9IGxvb2t1cFtiNjRbaV1dLCBlbmMyID0gbG9va3VwW2I2NFtpICsgMV1dLCBlbmMzID0gbG9va3VwW2I2NFtpICsgMl1dLCBlbmM0ID0gbG9va3VwW2I2NFtpICsgM11dOwogICAgICB2YXIgY2hyMSA9IChlbmMxIDw8IDIpIHwgKGVuYzIgPj4gNCk7CiAgICAgIHZhciBjaHIyID0gKChlbmMyICYgMTUpIDw8IDQpIHwgKGVuYzMgPj4gMik7CiAgICAgIHZhciBjaHIzID0gKChlbmMzICYgMykgPDwgNikgfCBlbmM0OwogICAgICBidWZbcG9zKytdID0gY2hyMTsKICAgICAgaWYgKGVuYzMgIT09IDY0KSBidWZbcG9zKytdID0gY2hyMjsKICAgICAgaWYgKGVuYzQgIT09IDY0KSBidWZbcG9zKytdID0gY2hyMzsKICAgIH0KICAgIHJldHVybiBidWY7CiAgfQoKICBmdW5jdGlvbiBieXRlc1RvQmFzZTY0KGJ5dGVzKSB7CiAgICB2YXIgYWxwaGFiZXQgPSAiQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODkrLyI7CiAgICB2YXIgb3V0ID0gIiI7CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSAzKSB7CiAgICAgIHZhciBiMCA9IGJ5dGVzW2ldLCBiMSA9IGkgKyAxIDwgYnl0ZXMubGVuZ3RoID8gYnl0ZXNbaSArIDFdIDogMCwgYjIgPSBpICsgMiA8IGJ5dGVzLmxlbmd0aCA/IGJ5dGVzW2kgKyAyXSA6IDA7CiAgICAgIHZhciB0cmlwbGV0ID0gKGIwIDw8IDE2KSB8IChiMSA8PCA4KSB8IGIyOwogICAgICBvdXQgKz0gYWxwaGFiZXRbKHRyaXBsZXQgPj4gMTgpICYgMHgzZl0gKyBhbHBoYWJldFsodHJpcGxldCA+PiAxMikgJiAweDNmXTsKICAgICAgb3V0ICs9IGkgKyAxIDwgYnl0ZXMubGVuZ3RoID8gYWxwaGFiZXRbKHRyaXBsZXQgPj4gNikgJiAweDNmXSA6ICI9IjsKICAgICAgb3V0ICs9IGkgKyAyIDwgYnl0ZXMubGVuZ3RoID8gYWxwaGFiZXRbdHJpcGxldCAmIDB4M2ZdIDogIj0iOwogICAgfQogICAgcmV0dXJuIG91dDsKICB9CgogIC8vID09PT09PT09PT0gVmFyaW50IC8gUHJvdG9idWYgPT09PT09PT09PQoKICBmdW5jdGlvbiBlbmNvZGVWYXJpbnRVbnNpZ25lZCh2YWx1ZSkgewogICAgdmFyIHYgPSB0eXBlb2YgdmFsdWUgPT09ICJiaWdpbnQiID8gdmFsdWUgOiBCaWdJbnQodmFsdWUpOwogICAgaWYgKHYgPCAwbikgdGhyb3cgbmV3IEVycm9yKCJuZWdhdGl2ZSB1bnNpZ25lZCB2YXJpbnQiKTsKICAgIHZhciBvdXQgPSBbXTsKICAgIHdoaWxlICh2ID49IDB4ODBuKSB7IG91dC5wdXNoKE51bWJlcigodiAmIDB4N2ZuKSB8IDB4ODBuKSk7IHYgPj49IDduOyB9CiAgICBvdXQucHVzaChOdW1iZXIodikpOwogICAgcmV0dXJuIG5ldyBVaW50OEFycmF5KG91dCk7CiAgfQoKICBmdW5jdGlvbiBlbmNvZGVWYXJpbnRTaWduZWRJbnQ2NCh2YWx1ZSkgewogICAgdmFyIHYgPSB0eXBlb2YgdmFsdWUgPT09ICJiaWdpbnQiID8gdmFsdWUgOiBCaWdJbnQoTWF0aC50cnVuYyh2YWx1ZSkpOwogICAgaWYgKHYgPCAwbikgdiA9IEJpZ0ludC5hc1VpbnROKDY0LCB2KTsKICAgIHJldHVybiBlbmNvZGVWYXJpbnRVbnNpZ25lZCh2KTsKICB9CgogIGZ1bmN0aW9uIGRlY29kZVZhcmludChieXRlcywgb2Zmc2V0KSB7CiAgICB2YXIgcmVzdWx0ID0gMG4sIHNoaWZ0ID0gMG4sIGN1cnJlbnQgPSBvZmZzZXQ7CiAgICB3aGlsZSAoY3VycmVudCA8IGJ5dGVzLmxlbmd0aCkgewogICAgICB2YXIgYiA9IGJ5dGVzW2N1cnJlbnRdOyBjdXJyZW50ICs9IDE7CiAgICAgIHJlc3VsdCB8PSBCaWdJbnQoYiAmIDB4N2YpIDw8IHNoaWZ0OwogICAgICBpZiAoKGIgJiAweDgwKSA9PT0gMCkgcmV0dXJuIHsgdmFsdWU6IHJlc3VsdCwgb2Zmc2V0OiBjdXJyZW50IH07CiAgICAgIHNoaWZ0ICs9IDduOwogICAgICBpZiAoc2hpZnQgPiA3MG4pIHRocm93IG5ldyBFcnJvcigidmFyaW50IHRvbyBsb25nIik7CiAgICB9CiAgICB0aHJvdyBuZXcgRXJyb3IoInVudGVybWluYXRlZCB2YXJpbnQiKTsKICB9CgogIGZ1bmN0aW9uIG1ha2VLZXkoZmllbGROdW1iZXIsIHdpcmVUeXBlKSB7CiAgICByZXR1cm4gZW5jb2RlVmFyaW50VW5zaWduZWQoKEJpZ0ludChmaWVsZE51bWJlcikgPDwgM24pIHwgQmlnSW50KHdpcmVUeXBlKSk7CiAgfQoKICBmdW5jdGlvbiBtYWtlVmFyaW50RmllbGQoZmllbGROdW1iZXIsIHZhbHVlKSB7CiAgICByZXR1cm4gY29uY2F0Qnl0ZXMoW21ha2VLZXkoZmllbGROdW1iZXIsIDApLCBlbmNvZGVWYXJpbnRTaWduZWRJbnQ2NCh2YWx1ZSldKTsKICB9CgogIGZ1bmN0aW9uIG1ha2VMZW5ndGhEZWxpbWl0ZWRGaWVsZChmaWVsZE51bWJlciwgcGF5bG9hZCkgewogICAgcmV0dXJuIGNvbmNhdEJ5dGVzKFttYWtlS2V5KGZpZWxkTnVtYmVyLCAyKSwgZW5jb2RlVmFyaW50VW5zaWduZWQocGF5bG9hZC5sZW5ndGgpLCBwYXlsb2FkXSk7CiAgfQoKICBmdW5jdGlvbiBwYXJzZUZpZWxkcyhieXRlcykgewogICAgdmFyIGZpZWxkcyA9IFtdLCBvZmZzZXQgPSAwOwogICAgd2hpbGUgKG9mZnNldCA8IGJ5dGVzLmxlbmd0aCkgewogICAgICB2YXIga2V5U3RhcnQgPSBvZmZzZXQ7CiAgICAgIHZhciBrZXkgPSBkZWNvZGVWYXJpbnQoYnl0ZXMsIG9mZnNldCk7CiAgICAgIG9mZnNldCA9IGtleS5vZmZzZXQ7CiAgICAgIHZhciBmaWVsZE51bWJlciA9IE51bWJlcihrZXkudmFsdWUgPj4gM24pLCB3aXJlVHlwZSA9IE51bWJlcihrZXkudmFsdWUgJiAweDduKTsKICAgICAgaWYgKGZpZWxkTnVtYmVyID09PSAwKSB0aHJvdyBuZXcgRXJyb3IoInByb3RvYnVmIGZpZWxkIG51bWJlciAwIik7CiAgICAgIHZhciB2YWx1ZVN0YXJ0ID0gb2Zmc2V0LCB2YWx1ZUVuZDsKICAgICAgaWYgKHdpcmVUeXBlID09PSAwKSB7IHZhbHVlRW5kID0gZGVjb2RlVmFyaW50KGJ5dGVzLCBvZmZzZXQpLm9mZnNldDsgfQogICAgICBlbHNlIGlmICh3aXJlVHlwZSA9PT0gMSkgeyB2YWx1ZUVuZCA9IG9mZnNldCArIDg7IH0KICAgICAgZWxzZSBpZiAod2lyZVR5cGUgPT09IDIpIHsgdmFyIGxlbkluZm8gPSBkZWNvZGVWYXJpbnQoYnl0ZXMsIG9mZnNldCk7IHZhbHVlU3RhcnQgPSBsZW5JbmZvLm9mZnNldDsgdmFsdWVFbmQgPSB2YWx1ZVN0YXJ0ICsgTnVtYmVyKGxlbkluZm8udmFsdWUpOyB9CiAgICAgIGVsc2UgaWYgKHdpcmVUeXBlID09PSA1KSB7IHZhbHVlRW5kID0gb2Zmc2V0ICsgNDsgfQogICAgICBlbHNlIHRocm93IG5ldyBFcnJvcigidW5zdXBwb3J0ZWQgd2lyZSB0eXBlOiAiICsgd2lyZVR5cGUpOwogICAgICBpZiAodmFsdWVFbmQgPiBieXRlcy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcigiZmllbGQgZXhjZWVkcyBidWZmZXIiKTsKICAgICAgZmllbGRzLnB1c2goeyBmaWVsZE51bWJlcjogZmllbGROdW1iZXIsIHdpcmVUeXBlOiB3aXJlVHlwZSwga2V5U3RhcnQ6IGtleVN0YXJ0LCB2YWx1ZVN0YXJ0OiB2YWx1ZVN0YXJ0LCB2YWx1ZUVuZDogdmFsdWVFbmQsIHJhdzogYnl0ZXMuc2xpY2Uoa2V5U3RhcnQsIHZhbHVlRW5kKSwgdmFsdWVCeXRlczogYnl0ZXMuc2xpY2UodmFsdWVTdGFydCwgdmFsdWVFbmQpIH0pOwogICAgICBvZmZzZXQgPSB2YWx1ZUVuZDsKICAgIH0KICAgIHJldHVybiBmaWVsZHM7CiAgfQoKICBmdW5jdGlvbiBmaXJzdEZpZWxkQnlOdW1iZXIoZmllbGRzLCBmaWVsZE51bWJlcikgewogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBmaWVsZHMubGVuZ3RoOyBpKyspIHsgaWYgKGZpZWxkc1tpXS5maWVsZE51bWJlciA9PT0gZmllbGROdW1iZXIpIHJldHVybiBmaWVsZHNbaV07IH0KICAgIHJldHVybiBudWxsOwogIH0KCiAgZnVuY3Rpb24gc2lnbmVkVmFyaW50RmllbGRWYWx1ZShmaWVsZCkgewogICAgaWYgKCFmaWVsZCB8fCBmaWVsZC53aXJlVHlwZSAhPT0gMCkgcmV0dXJuIG51bGw7CiAgICByZXR1cm4gQmlnSW50LmFzSW50Tig2NCwgZGVjb2RlVmFyaW50KGZpZWxkLnZhbHVlQnl0ZXMsIDApLnZhbHVlKTsKICB9CgogIGZ1bmN0aW9uIHRyeVBhcnNlRmllbGRzKGJ5dGVzKSB7CiAgICB0cnkgeyBpZiAoIWJ5dGVzIHx8IGJ5dGVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7IHZhciBmID0gcGFyc2VGaWVsZHMoYnl0ZXMpOyByZXR1cm4gZi5sZW5ndGggPiAwID8gZiA6IG51bGw7IH0KICAgIGNhdGNoIChlKSB7IHJldHVybiBudWxsOyB9CiAgfQoKICBmdW5jdGlvbiBpc0NlbGxSZXNwb25zZUZpZWxkKGZpZWxkTnVtYmVyKSB7IHJldHVybiBDRUxMX1JFU1BPTlNFX0ZJRUxEU1tmaWVsZE51bWJlcl0gPT09IHRydWU7IH0KCiAgLy8gPT09PT09PT09PSBBUlBDID09PT09PT09PT0KCiAgZnVuY3Rpb24gcmVhZFVJbnQxNkJFKGJ5dGVzLCBvZmZzZXQpIHsgcmV0dXJuIChieXRlc1tvZmZzZXRdIDw8IDgpIHwgYnl0ZXNbb2Zmc2V0ICsgMV07IH0KICBmdW5jdGlvbiByZWFkVUludDMyQkUoYnl0ZXMsIG9mZnNldCkgeyByZXR1cm4gKChieXRlc1tvZmZzZXRdICogMHgxMDAwMDAwKSArICgoYnl0ZXNbb2Zmc2V0ICsgMV0gPDwgMTYpIHwgKGJ5dGVzW29mZnNldCArIDJdIDw8IDgpIHwgYnl0ZXNbb2Zmc2V0ICsgM10pKSA+Pj4gMDsgfQogIGZ1bmN0aW9uIHdyaXRlVUludDE2QkUodmFsdWUpIHsgcmV0dXJuIG5ldyBVaW50OEFycmF5KFsodmFsdWUgPj4gOCkgJiAweGZmLCB2YWx1ZSAmIDB4ZmZdKTsgfQogIGZ1bmN0aW9uIHdyaXRlVUludDMyQkUodmFsdWUpIHsgcmV0dXJuIG5ldyBVaW50OEFycmF5KFsodmFsdWUgPj4+IDI0KSAmIDB4ZmYsICh2YWx1ZSA+Pj4gMTYpICYgMHhmZiwgKHZhbHVlID4+PiA4KSAmIDB4ZmYsIHZhbHVlICYgMHhmZl0pOyB9CgogIGZ1bmN0aW9uIGFzY2lpQnl0ZXModmFsdWUpIHsKICAgIHZhciBvdXQgPSBuZXcgVWludDhBcnJheSh2YWx1ZS5sZW5ndGgpOwogICAgZm9yICh2YXIgaSA9IDA7IGkgPCB2YWx1ZS5sZW5ndGg7IGkrKykgb3V0W2ldID0gdmFsdWUuY2hhckNvZGVBdChpKSAmIDB4N2Y7CiAgICByZXR1cm4gb3V0OwogIH0KCiAgZnVuY3Rpb24gcmVhZFBhc2NhbFN0cmluZyhieXRlcywgc3RhdGUpIHsKICAgIHZhciBsZW5ndGggPSByZWFkVUludDE2QkUoYnl0ZXMsIHN0YXRlLm9mZnNldCk7IHN0YXRlLm9mZnNldCArPSAyOwogICAgdmFyIGNoYXJzID0gW107CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbmd0aDsgaSsrKSBjaGFycy5wdXNoKFN0cmluZy5mcm9tQ2hhckNvZGUoYnl0ZXNbc3RhdGUub2Zmc2V0ICsgaV0pKTsKICAgIHN0YXRlLm9mZnNldCArPSBsZW5ndGg7CiAgICByZXR1cm4gY2hhcnMuam9pbigiIik7CiAgfQoKICBmdW5jdGlvbiB3cml0ZVBhc2NhbFN0cmluZyh2YWx1ZSkgeyByZXR1cm4gY29uY2F0Qnl0ZXMoW3dyaXRlVUludDE2QkUodmFsdWUubGVuZ3RoKSwgYXNjaWlCeXRlcyh2YWx1ZSldKTsgfQoKICBmdW5jdGlvbiBwYXJzZUFycGMoYnl0ZXMpIHsKICAgIHZhciBzdGF0ZSA9IHsgb2Zmc2V0OiAwIH07CiAgICB2YXIgdmVyc2lvbiA9IHJlYWRVSW50MTZCRShieXRlcywgc3RhdGUub2Zmc2V0KTsgc3RhdGUub2Zmc2V0ICs9IDI7CiAgICB2YXIgbG9jYWxlID0gcmVhZFBhc2NhbFN0cmluZyhieXRlcywgc3RhdGUpOwogICAgdmFyIGFwcElkZW50aWZpZXIgPSByZWFkUGFzY2FsU3RyaW5nKGJ5dGVzLCBzdGF0ZSk7CiAgICB2YXIgb3NWZXJzaW9uID0gcmVhZFBhc2NhbFN0cmluZyhieXRlcywgc3RhdGUpOwogICAgdmFyIGZ1bmN0aW9uSWQgPSByZWFkVUludDMyQkUoYnl0ZXMsIHN0YXRlLm9mZnNldCk7IHN0YXRlLm9mZnNldCArPSA0OwogICAgdmFyIHBheWxvYWRMZW5ndGggPSByZWFkVUludDMyQkUoYnl0ZXMsIHN0YXRlLm9mZnNldCk7IHN0YXRlLm9mZnNldCArPSA0OwogICAgaWYgKHN0YXRlLm9mZnNldCArIHBheWxvYWRMZW5ndGggPiBieXRlcy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcigiQVJQQyBwYXlsb2FkIGV4Y2VlZHMgYnVmZmVyIik7CiAgICByZXR1cm4geyB2ZXJzaW9uOiB2ZXJzaW9uLCBsb2NhbGU6IGxvY2FsZSwgYXBwSWRlbnRpZmllcjogYXBwSWRlbnRpZmllciwgb3NWZXJzaW9uOiBvc1ZlcnNpb24sIGZ1bmN0aW9uSWQ6IGZ1bmN0aW9uSWQsIHBheWxvYWQ6IGJ5dGVzLnNsaWNlKHN0YXRlLm9mZnNldCwgc3RhdGUub2Zmc2V0ICsgcGF5bG9hZExlbmd0aCkgfTsKICB9CgogIGZ1bmN0aW9uIHNlcmlhbGl6ZUFycGMoYXJwYykgewogICAgcmV0dXJuIGNvbmNhdEJ5dGVzKFt3cml0ZVVJbnQxNkJFKGFycGMudmVyc2lvbiksIHdyaXRlUGFzY2FsU3RyaW5nKGFycGMubG9jYWxlKSwgd3JpdGVQYXNjYWxTdHJpbmcoYXJwYy5hcHBJZGVudGlmaWVyKSwgd3JpdGVQYXNjYWxTdHJpbmcoYXJwYy5vc1ZlcnNpb24pLCB3cml0ZVVJbnQzMkJFKGFycGMuZnVuY3Rpb25JZCksIHdyaXRlVUludDMyQkUoYXJwYy5wYXlsb2FkLmxlbmd0aCksIGFycGMucGF5bG9hZF0pOwogIH0KCiAgLy8gPT09PT09PT09PSBMb2NhdGlvbiBQYXRjaGluZyA9PT09PT09PT09CgogIGZ1bmN0aW9uIGNvb3JkVG9JbnQodmFsdWUpIHsgcmV0dXJuIE1hdGgudHJ1bmMoTnVtYmVyKHZhbHVlKSAqIDEwMDAwMDAwMCk7IH0KCiAgZnVuY3Rpb24gcGF0Y2hMb2NhdGlvbihsb2NhdGlvblBheWxvYWQsIGNvbmZpZykgewogICAgdmFyIHBhcnRzID0gW10sIGZpZWxkcyA9IGxvY2F0aW9uUGF5bG9hZC5sZW5ndGggPyBwYXJzZUZpZWxkcyhsb2NhdGlvblBheWxvYWQpIDogW107CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGZpZWxkcy5sZW5ndGg7IGkrKykgeyBpZiAoIUxPQ0FUSU9OX1JFUExBQ0VEX0ZJRUxEU1tmaWVsZHNbaV0uZmllbGROdW1iZXJdKSBwYXJ0cy5wdXNoKGZpZWxkc1tpXS5yYXcpOyB9CiAgICBwYXJ0cy5wdXNoKG1ha2VWYXJpbnRGaWVsZCgxLCBjb29yZFRvSW50KGNvbmZpZy5sYXRpdHVkZSkpKTsKICAgIHBhcnRzLnB1c2gobWFrZVZhcmludEZpZWxkKDIsIGNvb3JkVG9JbnQoY29uZmlnLmxvbmdpdHVkZSkpKTsKICAgIHBhcnRzLnB1c2gobWFrZVZhcmludEZpZWxkKDMsIGNvbmZpZy5ob3Jpem9udGFsQWNjdXJhY3kpKTsKICAgIHBhcnRzLnB1c2gobWFrZVZhcmludEZpZWxkKDQsIGNvbmZpZy51bmtub3duVmFsdWU0KSk7CiAgICBwYXJ0cy5wdXNoKG1ha2VWYXJpbnRGaWVsZCg1LCBjb25maWcuYWx0aXR1ZGUpKTsKICAgIHBhcnRzLnB1c2gobWFrZVZhcmludEZpZWxkKDYsIGNvbmZpZy52ZXJ0aWNhbEFjY3VyYWN5KSk7CiAgICBwYXJ0cy5wdXNoKG1ha2VWYXJpbnRGaWVsZCgxMSwgY29uZmlnLm1vdGlvbkFjdGl2aXR5VHlwZSkpOwogICAgcGFydHMucHVzaChtYWtlVmFyaW50RmllbGQoMTIsIGNvbmZpZy5tb3Rpb25BY3Rpdml0eUNvbmZpZGVuY2UpKTsKICAgIHJldHVybiBjb25jYXRCeXRlcyhwYXJ0cyk7CiAgfQoKICBmdW5jdGlvbiBwYXRjaFdpZmlEZXZpY2Uod2lmaVBheWxvYWQsIGNvbmZpZykgewogICAgdmFyIGZpZWxkcyA9IHBhcnNlRmllbGRzKHdpZmlQYXlsb2FkKSwgcGFydHMgPSBbXSwgcGF0Y2hlZExvY2F0aW9uID0gZmFsc2U7CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGZpZWxkcy5sZW5ndGg7IGkrKykgewogICAgICBpZiAoZmllbGRzW2ldLmZpZWxkTnVtYmVyID09PSAyICYmIGZpZWxkc1tpXS53aXJlVHlwZSA9PT0gMikgewogICAgICAgIHBhcnRzLnB1c2gobWFrZUxlbmd0aERlbGltaXRlZEZpZWxkKDIsIHBhdGNoTG9jYXRpb24oZmllbGRzW2ldLnZhbHVlQnl0ZXMsIGNvbmZpZykpKTsgcGF0Y2hlZExvY2F0aW9uID0gdHJ1ZTsKICAgICAgfSBlbHNlIHBhcnRzLnB1c2goZmllbGRzW2ldLnJhdyk7CiAgICB9CiAgICBpZiAoIXBhdGNoZWRMb2NhdGlvbikgcGFydHMucHVzaChtYWtlTGVuZ3RoRGVsaW1pdGVkRmllbGQoMiwgcGF0Y2hMb2NhdGlvbihuZXcgVWludDhBcnJheShbXSksIGNvbmZpZykpKTsKICAgIHJldHVybiBjb25jYXRCeXRlcyhwYXJ0cyk7CiAgfQoKICBmdW5jdGlvbiBwYXRjaENlbGxUb3dlcihjZWxsUGF5bG9hZCwgY29uZmlnKSB7CiAgICB2YXIgZmllbGRzID0gcGFyc2VGaWVsZHMoY2VsbFBheWxvYWQpLCBwYXJ0cyA9IFtdLCBwYXRjaGVkTG9jYXRpb24gPSBmYWxzZTsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZmllbGRzLmxlbmd0aDsgaSsrKSB7CiAgICAgIGlmIChmaWVsZHNbaV0uZmllbGROdW1iZXIgPT09IDUgJiYgZmllbGRzW2ldLndpcmVUeXBlID09PSAyKSB7CiAgICAgICAgcGFydHMucHVzaChtYWtlTGVuZ3RoRGVsaW1pdGVkRmllbGQoNSwgcGF0Y2hMb2NhdGlvbihmaWVsZHNbaV0udmFsdWVCeXRlcywgY29uZmlnKSkpOyBwYXRjaGVkTG9jYXRpb24gPSB0cnVlOwogICAgICB9IGVsc2UgcGFydHMucHVzaChmaWVsZHNbaV0ucmF3KTsKICAgIH0KICAgIGlmICghcGF0Y2hlZExvY2F0aW9uKSBwYXJ0cy5wdXNoKG1ha2VMZW5ndGhEZWxpbWl0ZWRGaWVsZCg1LCBwYXRjaExvY2F0aW9uKG5ldyBVaW50OEFycmF5KFtdKSwgY29uZmlnKSkpOwogICAgcmV0dXJuIGNvbmNhdEJ5dGVzKHBhcnRzKTsKICB9CgogIGZ1bmN0aW9uIHBhdGNoQXBwbGVXTG9jUGF5bG9hZChwYXlsb2FkLCBjb25maWcpIHsKICAgIHZhciBmaWVsZHMgPSBwYXJzZUZpZWxkcyhwYXlsb2FkKSwgcGFydHMgPSBbXSwgd2lmaUNvdW50ID0gMCwgY2VsbENvdW50ID0gMDsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZmllbGRzLmxlbmd0aDsgaSsrKSB7CiAgICAgIHZhciBmaWVsZCA9IGZpZWxkc1tpXTsKICAgICAgaWYgKGZpZWxkLmZpZWxkTnVtYmVyID09PSAyICYmIGZpZWxkLndpcmVUeXBlID09PSAyKSB7IHBhcnRzLnB1c2gobWFrZUxlbmd0aERlbGltaXRlZEZpZWxkKDIsIHBhdGNoV2lmaURldmljZShmaWVsZC52YWx1ZUJ5dGVzLCBjb25maWcpKSk7IHdpZmlDb3VudCArPSAxOyB9CiAgICAgIGVsc2UgaWYgKGlzQ2VsbFJlc3BvbnNlRmllbGQoZmllbGQuZmllbGROdW1iZXIpICYmIGZpZWxkLndpcmVUeXBlID09PSAyKSB7IHBhcnRzLnB1c2gobWFrZUxlbmd0aERlbGltaXRlZEZpZWxkKGZpZWxkLmZpZWxkTnVtYmVyLCBwYXRjaENlbGxUb3dlcihmaWVsZC52YWx1ZUJ5dGVzLCBjb25maWcpKSk7IGNlbGxDb3VudCArPSAxOyB9CiAgICAgIGVsc2UgaWYgKCFST09UX0RST1BfRklFTERTW2ZpZWxkLmZpZWxkTnVtYmVyXSkgcGFydHMucHVzaChmaWVsZC5yYXcpOwogICAgfQogICAgcmV0dXJuIHsgcGF5bG9hZDogY29uY2F0Qnl0ZXMocGFydHMpLCB3aWZpQ291bnQ6IHdpZmlDb3VudCwgY2VsbENvdW50OiBjZWxsQ291bnQgfTsKICB9CgogIC8vID09PT09PT09PT0gUmVzcG9uc2UgRXh0cmFjdGlvbiA9PT09PT09PT09CgogIGZ1bmN0aW9uIGV4dHJhY3RQcmVmaXhlZEFwcGxlV0xvY1BheWxvYWQocmVzcG9uc2VCeXRlcykgewogICAgaWYgKCFyZXNwb25zZUJ5dGVzIHx8IHJlc3BvbnNlQnl0ZXMubGVuZ3RoIDwgMTApIHJldHVybiBudWxsOwogICAgaWYgKHJlc3BvbnNlQnl0ZXNbMF0gIT09IDB4MDAgfHwgcmVzcG9uc2VCeXRlc1sxXSAhPT0gMHgwMSkgcmV0dXJuIG51bGw7CiAgICBpZiAocmVzcG9uc2VCeXRlc1s2XSAhPT0gMHgwMCB8fCByZXNwb25zZUJ5dGVzWzddICE9PSAweDAwKSByZXR1cm4gbnVsbDsKICAgIHZhciBwYXlsb2FkTGVuZ3RoID0gcmVhZFVJbnQxNkJFKHJlc3BvbnNlQnl0ZXMsIDgpLCBwYXlsb2FkT2Zmc2V0ID0gMTA7CiAgICBpZiAocGF5bG9hZExlbmd0aCA8PSAwIHx8IHBheWxvYWRPZmZzZXQgKyBwYXlsb2FkTGVuZ3RoID4gcmVzcG9uc2VCeXRlcy5sZW5ndGgpIHJldHVybiBudWxsOwogICAgdmFyIHBheWxvYWQgPSByZXNwb25zZUJ5dGVzLnNsaWNlKHBheWxvYWRPZmZzZXQsIHBheWxvYWRPZmZzZXQgKyBwYXlsb2FkTGVuZ3RoKTsKICAgIGlmICh0cnlQYXJzZUZpZWxkcyhwYXlsb2FkKSA9PT0gbnVsbCkgcmV0dXJuIG51bGw7CiAgICByZXR1cm4geyBraW5kOiAic3ludGhldGljIiwgcGF5bG9hZDogcGF5bG9hZCwgcHJlZml4OiByZXNwb25zZUJ5dGVzLnNsaWNlKDAsIDgpLCBzdWZmaXg6IHJlc3BvbnNlQnl0ZXMuc2xpY2UocGF5bG9hZE9mZnNldCArIHBheWxvYWRMZW5ndGgpIH07CiAgfQoKICBmdW5jdGlvbiBleHRyYWN0QXBwbGVXTG9jUGF5bG9hZChyZXNwb25zZUJ5dGVzKSB7CiAgICBpZiAoIXJlc3BvbnNlQnl0ZXMgfHwgcmVzcG9uc2VCeXRlcy5sZW5ndGggPCAyKSB0aHJvdyBuZXcgRXJyb3IoIkFwcGxlIFdMb2MgcmVzcG9uc2UgdG9vIHNob3J0Iik7CiAgICB2YXIgcHJlZml4ZWQgPSBleHRyYWN0UHJlZml4ZWRBcHBsZVdMb2NQYXlsb2FkKHJlc3BvbnNlQnl0ZXMpOwogICAgaWYgKHByZWZpeGVkKSByZXR1cm4gcHJlZml4ZWQ7CiAgICB0cnkgewogICAgICB2YXIgYXJwYyA9IHBhcnNlQXJwYyhyZXNwb25zZUJ5dGVzKTsKICAgICAgaWYgKGFycGMucGF5bG9hZC5sZW5ndGggPiAwICYmIHRyeVBhcnNlRmllbGRzKGFycGMucGF5bG9hZCkgIT09IG51bGwpIHJldHVybiB7IGtpbmQ6ICJhcnBjIiwgcGF5bG9hZDogYXJwYy5wYXlsb2FkLCBhcnBjOiBhcnBjIH07CiAgICB9IGNhdGNoIChlKSB7fQogICAgdmFyIG1hcmtlcklkeCA9IGZpbmRCeXRlcyhyZXNwb25zZUJ5dGVzLCBBUFBMRV9XTE9DX01BUktFUik7CiAgICBpZiAobWFya2VySWR4ID49IDApIHsKICAgICAgdmFyIGxlbk9mZnNldCA9IG1hcmtlcklkeCArIEFQUExFX1dMT0NfTUFSS0VSLmxlbmd0aDsKICAgICAgaWYgKGxlbk9mZnNldCArIDIgPD0gcmVzcG9uc2VCeXRlcy5sZW5ndGgpIHsKICAgICAgICB2YXIgcmVhbExlbiA9IHJlYWRVSW50MTZCRShyZXNwb25zZUJ5dGVzLCBsZW5PZmZzZXQpLCByZWFsUGF5bG9hZE9mZnNldCA9IGxlbk9mZnNldCArIDI7CiAgICAgICAgaWYgKHJlYWxMZW4gPiAwICYmIHJlYWxQYXlsb2FkT2Zmc2V0ICsgcmVhbExlbiA8PSByZXNwb25zZUJ5dGVzLmxlbmd0aCkgewogICAgICAgICAgdmFyIGNhbmRpZGF0ZVBheWxvYWQgPSByZXNwb25zZUJ5dGVzLnNsaWNlKHJlYWxQYXlsb2FkT2Zmc2V0LCByZWFsUGF5bG9hZE9mZnNldCArIHJlYWxMZW4pOwogICAgICAgICAgaWYgKHRyeVBhcnNlRmllbGRzKGNhbmRpZGF0ZVBheWxvYWQpICE9PSBudWxsKSByZXR1cm4geyBraW5kOiAibWFya2VyIiwgcGF5bG9hZDogY2FuZGlkYXRlUGF5bG9hZCwgcHJlZml4OiByZXNwb25zZUJ5dGVzLnNsaWNlKDAsIG1hcmtlcklkeCksIG1hcmtlckFuZExlbjogcmVzcG9uc2VCeXRlcy5zbGljZShtYXJrZXJJZHgsIHJlYWxQYXlsb2FkT2Zmc2V0KSwgc3VmZml4OiByZXNwb25zZUJ5dGVzLnNsaWNlKHJlYWxQYXlsb2FkT2Zmc2V0ICsgcmVhbExlbikgfTsKICAgICAgICB9CiAgICAgIH0KICAgIH0KICAgIGlmIChyZXNwb25zZUJ5dGVzLmxlbmd0aCA+IDApIHsgdmFyIHRhZyA9IHJlc3BvbnNlQnl0ZXNbMF07IHZhciBmbiA9IHRhZyA+PiAzLCB3dCA9IHRhZyAmIDB4NzsgaWYgKGZuID4gMCAmJiAod3QgPT09IDAgfHwgd3QgPT09IDIpKSByZXR1cm4geyBraW5kOiAiYmFyZSIsIHBheWxvYWQ6IHJlc3BvbnNlQnl0ZXMgfTsgfQogICAgdGhyb3cgbmV3IEVycm9yKCJtaXNzaW5nIEFwcGxlIFdMb2MgcmVzcG9uc2UgcHJlZml4Iik7CiAgfQoKICBmdW5jdGlvbiBidWlsZEFwcGxlV0xvY1Jlc3BvbnNlKHBheWxvYWQsIHByZWZpeCkgewogICAgcmV0dXJuIGNvbmNhdEJ5dGVzKFtwcmVmaXggfHwgQVBQTEVfV0xPQ19QUkVGSVgsIHdyaXRlVUludDE2QkUocGF5bG9hZC5sZW5ndGgpLCBwYXlsb2FkXSk7CiAgfQoKICBmdW5jdGlvbiBzcG9vZkFwcGxlUmVzcG9uc2UocmVzcG9uc2VCeXRlcywgY29uZmlnKSB7CiAgICB2YXIgZXh0cmFjdGlvbiA9IGV4dHJhY3RBcHBsZVdMb2NQYXlsb2FkKHJlc3BvbnNlQnl0ZXMpOwogICAgdmFyIHBhdGNoZWQgPSBwYXRjaEFwcGxlV0xvY1BheWxvYWQoZXh0cmFjdGlvbi5wYXlsb2FkLCBjb25maWcpOwogICAgdmFyIHJlc3BvbnNlOwogICAgaWYgKGV4dHJhY3Rpb24ua2luZCA9PT0gImFycGMiKSB7CiAgICAgIHJlc3BvbnNlID0gc2VyaWFsaXplQXJwYyh7IHZlcnNpb246IGV4dHJhY3Rpb24uYXJwYy52ZXJzaW9uLCBsb2NhbGU6IGV4dHJhY3Rpb24uYXJwYy5sb2NhbGUsIGFwcElkZW50aWZpZXI6IGV4dHJhY3Rpb24uYXJwYy5hcHBJZGVudGlmaWVyLCBvc1ZlcnNpb246IGV4dHJhY3Rpb24uYXJwYy5vc1ZlcnNpb24sIGZ1bmN0aW9uSWQ6IGV4dHJhY3Rpb24uYXJwYy5mdW5jdGlvbklkLCBwYXlsb2FkOiBwYXRjaGVkLnBheWxvYWQgfSk7CiAgICB9IGVsc2UgaWYgKGV4dHJhY3Rpb24ua2luZCA9PT0gIm1hcmtlciIpIHsKICAgICAgdmFyIG5ld0xlbkJ5dGVzID0gd3JpdGVVSW50MTZCRShwYXRjaGVkLnBheWxvYWQubGVuZ3RoKTsKICAgICAgcmVzcG9uc2UgPSBjb25jYXRCeXRlcyhbZXh0cmFjdGlvbi5wcmVmaXgsIGV4dHJhY3Rpb24ubWFya2VyQW5kTGVuLnNsaWNlKDAsIEFQUExFX1dMT0NfTUFSS0VSLmxlbmd0aCksIG5ld0xlbkJ5dGVzLCBwYXRjaGVkLnBheWxvYWQsIGV4dHJhY3Rpb24uc3VmZml4XSk7CiAgICB9IGVsc2UgewogICAgICByZXNwb25zZSA9IGJ1aWxkQXBwbGVXTG9jUmVzcG9uc2UocGF0Y2hlZC5wYXlsb2FkLCBleHRyYWN0aW9uLnByZWZpeCk7CiAgICB9CiAgICByZXR1cm4geyByZXNwb25zZTogcmVzcG9uc2UsIHBheWxvYWQ6IHBhdGNoZWQucGF5bG9hZCwgd2lmaUNvdW50OiBwYXRjaGVkLndpZmlDb3VudCwgY2VsbENvdW50OiBwYXRjaGVkLmNlbGxDb3VudCwga2luZDogZXh0cmFjdGlvbi5raW5kIH07CiAgfQoKICBmdW5jdGlvbiBwYXRjaGVkUGF5bG9hZFN1bW1hcnkocGF5bG9hZCkgewogICAgdHJ5IHsKICAgICAgdmFyIHJvb3RGaWVsZHMgPSBwYXJzZUZpZWxkcyhwYXlsb2FkKSwgcGFydHMgPSBbXTsKICAgICAgdmFyIHdpZmkgPSBmaXJzdEZpZWxkQnlOdW1iZXIocm9vdEZpZWxkcywgMik7CiAgICAgIGlmICh3aWZpICYmIHdpZmkud2lyZVR5cGUgPT09IDIpIHsKICAgICAgICB2YXIgd2lmaUxvYyA9IGZpcnN0RmllbGRCeU51bWJlcihwYXJzZUZpZWxkcyh3aWZpLnZhbHVlQnl0ZXMpLCAyKTsKICAgICAgICBwYXJ0cy5wdXNoKCJmaXJzdFdpZmk9IiArICh3aWZpTG9jID8gKE51bWJlcihzaWduZWRWYXJpbnRGaWVsZFZhbHVlKGZpcnN0RmllbGRCeU51bWJlcihwYXJzZUZpZWxkcyh3aWZpTG9jLnZhbHVlQnl0ZXMpLCAxKSkpIC8gMTAwMDAwMDAwKS50b0ZpeGVkKDgpICsgIiwiICsgKE51bWJlcihzaWduZWRWYXJpbnRGaWVsZFZhbHVlKGZpcnN0RmllbGRCeU51bWJlcihwYXJzZUZpZWxkcyh3aWZpTG9jLnZhbHVlQnl0ZXMpLCAyKSkpIC8gMTAwMDAwMDAwKS50b0ZpeGVkKDgpIDogIjxtaXNzaW5nPiIpKTsKICAgICAgfQogICAgICByZXR1cm4gcGFydHMubGVuZ3RoID8gcGFydHMuam9pbigiLCAiKSA6ICJubyBsb2NhdGlvbiBmaWVsZHMiOwogICAgfSBjYXRjaCAoZXJyKSB7IHJldHVybiAic3VtbWFyeSBmYWlsZWQ6ICIgKyBlcnIubWVzc2FnZTsgfQogIH0KCiAgLy8gPT09PT09PT09PSBDb25maWcgPT09PT09PT09PQoKICBmdW5jdGlvbiBub3JtYWxpemVDb25maWcoaW5wdXQpIHsKICAgIHZhciBjZmcgPSB7fSwga2V5OwogICAgZm9yIChrZXkgaW4gREVGQVVMVF9DT05GSUcpIHsgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChERUZBVUxUX0NPTkZJRywga2V5KSkgY2ZnW2tleV0gPSBERUZBVUxUX0NPTkZJR1trZXldOyB9CiAgICBpbnB1dCA9IGlucHV0IHx8IHt9OwogICAgZm9yIChrZXkgaW4gaW5wdXQpIHsgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChpbnB1dCwga2V5KSkgY2ZnW2tleV0gPSBpbnB1dFtrZXldOyB9CiAgICBjZmcuZW5hYmxlZCA9ICEoY2ZnLmVuYWJsZWQgPT09IGZhbHNlIHx8IGNmZy5lbmFibGVkID09PSAiZmFsc2UiIHx8IGNmZy5lbmFibGVkID09PSAiMCIgfHwgY2ZnLmVuYWJsZWQgPT09ICJvZmYiIHx8IGNmZy5lbmFibGVkID09PSAibm8iIHx8IGNmZy5lbmFibGVkID09PSAwKTsKICAgIGNmZy5sYXRpdHVkZSA9IE51bWJlcihjZmcubGF0aXR1ZGUpOyBjZmcubG9uZ2l0dWRlID0gTnVtYmVyKGNmZy5sb25naXR1ZGUpOwogICAgY2ZnLmhvcml6b250YWxBY2N1cmFjeSA9IE1hdGgudHJ1bmMoTnVtYmVyKGNmZy5ob3Jpem9udGFsQWNjdXJhY3kpKTsKICAgIGNmZy52ZXJ0aWNhbEFjY3VyYWN5ID0gTWF0aC50cnVuYyhOdW1iZXIoY2ZnLnZlcnRpY2FsQWNjdXJhY3kpKTsKICAgIGNmZy5hbHRpdHVkZSA9IE1hdGgudHJ1bmMoTnVtYmVyKGNmZy5hbHRpdHVkZSkpOwogICAgY2ZnLnVua25vd25WYWx1ZTQgPSBNYXRoLnRydW5jKE51bWJlcihjZmcudW5rbm93blZhbHVlNCkpOwogICAgY2ZnLm1vdGlvbkFjdGl2aXR5VHlwZSA9IE1hdGgudHJ1bmMoTnVtYmVyKGNmZy5tb3Rpb25BY3Rpdml0eVR5cGUpKTsKICAgIGNmZy5tb3Rpb25BY3Rpdml0eUNvbmZpZGVuY2UgPSBNYXRoLnRydW5jKE51bWJlcihjZmcubW90aW9uQWN0aXZpdHlDb25maWRlbmNlKSk7CiAgICBjZmcuZmFpbE9wZW4gPSBjZmcuZmFpbE9wZW4gIT09IGZhbHNlOwogICAgY2ZnLmRlYnVnID0gY2ZnLmRlYnVnID09PSB0cnVlIHx8IFN0cmluZyhjZmcuZGVidWcpLnRvTG93ZXJDYXNlKCkgPT09ICJ0cnVlIjsKICAgIGNmZy5yYW5kb21SYWRpdXMgPSBOdW1iZXIoY2ZnLnJhbmRvbVJhZGl1cyk7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShjZmcucmFuZG9tUmFkaXVzKSB8fCBjZmcucmFuZG9tUmFkaXVzIDwgMCkgY2ZnLnJhbmRvbVJhZGl1cyA9IDA7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShjZmcubGF0aXR1ZGUpIHx8IGNmZy5sYXRpdHVkZSA8IC05MCB8fCBjZmcubGF0aXR1ZGUgPiA5MCkgdGhyb3cgbmV3IEVycm9yKCJpbnZhbGlkIGxhdGl0dWRlIik7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShjZmcubG9uZ2l0dWRlKSB8fCBjZmcubG9uZ2l0dWRlIDwgLTE4MCB8fCBjZmcubG9uZ2l0dWRlID4gMTgwKSB0aHJvdyBuZXcgRXJyb3IoImludmFsaWQgbG9uZ2l0dWRlIik7CiAgICBpZiAoY2ZnLnJhbmRvbVJhZGl1cyA+IDApIHsKICAgICAgdmFyIGppdHRlcmVkID0gYXBwbHlSYW5kb21SYWRpdXMoY2ZnLmxhdGl0dWRlLCBjZmcubG9uZ2l0dWRlLCBjZmcucmFuZG9tUmFkaXVzKTsKICAgICAgY2ZnLmxhdGl0dWRlID0gaml0dGVyZWQubGF0aXR1ZGU7CiAgICAgIGNmZy5sb25naXR1ZGUgPSBqaXR0ZXJlZC5sb25naXR1ZGU7CiAgICAgIGNmZy5yYW5kb21EaXN0YW5jZSA9IGppdHRlcmVkLmRpc3RhbmNlOwogICAgfQogICAgcmV0dXJuIGNmZzsKICB9CgogIC8vIFJhbmRvbSBwZXJ0dXJiYXRpb24gKFl1OTE5MSB2MS4xICLmibDliqjljYrlvoQiKSDigJQgc2VlIGxvY2F0aW9uLXNwb29mZXIuanMgZm9yIGRldGFpbHMuCiAgZnVuY3Rpb24gYXBwbHlSYW5kb21SYWRpdXMobGF0LCBsb24sIHJhZGl1c01ldGVycykgewogICAgdmFyIHIgPSBOdW1iZXIocmFkaXVzTWV0ZXJzKTsKICAgIGlmICghTnVtYmVyLmlzRmluaXRlKHIpIHx8IHIgPD0gMCkgcmV0dXJuIHsgbGF0aXR1ZGU6IGxhdCwgbG9uZ2l0dWRlOiBsb24sIGRpc3RhbmNlOiAwIH07CiAgICB2YXIgZGlzdGFuY2UgPSBNYXRoLnNxcnQoTWF0aC5yYW5kb20oKSkgKiByOwogICAgdmFyIGJlYXJpbmcgPSAyICogTWF0aC5yYW5kb20oKSAqIE1hdGguUEk7CiAgICB2YXIgYW5ndWxhciA9IGRpc3RhbmNlIC8gNjM3ODEzNzsKICAgIHZhciBsYXRSYWQgPSAobGF0ICogTWF0aC5QSSkgLyAxODA7CiAgICB2YXIgbG9uUmFkID0gKGxvbiAqIE1hdGguUEkpIC8gMTgwOwogICAgdmFyIG5ld0xhdCA9IE1hdGguYXNpbihNYXRoLnNpbihsYXRSYWQpICogTWF0aC5jb3MoYW5ndWxhcikgKyBNYXRoLmNvcyhsYXRSYWQpICogTWF0aC5zaW4oYW5ndWxhcikgKiBNYXRoLmNvcyhiZWFyaW5nKSk7CiAgICB2YXIgbmV3TG9uID0gKChsb25SYWQgKyBNYXRoLmF0YW4yKE1hdGguc2luKGJlYXJpbmcpICogTWF0aC5zaW4oYW5ndWxhcikgKiBNYXRoLmNvcyhsYXRSYWQpLCBNYXRoLmNvcyhhbmd1bGFyKSAtIE1hdGguc2luKGxhdFJhZCkgKiBNYXRoLnNpbihuZXdMYXQpKSArIDMgKiBNYXRoLlBJKSAlICgyICogTWF0aC5QSSkpIC0gTWF0aC5QSTsKICAgIHJldHVybiB7CiAgICAgIGxhdGl0dWRlOiBOdW1iZXIoKChuZXdMYXQgKiAxODApIC8gTWF0aC5QSSkudG9GaXhlZCg4KSksCiAgICAgIGxvbmdpdHVkZTogTnVtYmVyKCgobmV3TG9uICogMTgwKSAvIE1hdGguUEkpLnRvRml4ZWQoOCkpLAogICAgICBkaXN0YW5jZTogZGlzdGFuY2UKICAgIH07CiAgfQoKICBmdW5jdGlvbiBsb2FkQ29uZmlnKCkgewogICAgLy8g5peg54q25oCB77ya5LuO5pys5py6ICRwcmVmcyDor7vlj5bpgInngrnpobXlhpnlhaXnmoTlnZDmoIfvvIjkuI3lj5Hotbfku7vkvZXlpJbpg6jnvZHnu5zor7fmsYLvvInjgIIKICAgIC8vIOmUruS4jiBsb2NhdGlvbi1zZXR0aW5ncy5qcyDlhpnlhaXnmoTkuIDoh7TvvJplbmFibGVkL2xhdGl0dWRlL2xvbmdpdHVkZS9hbHRpdHVkZS9ob3Jpem9udGFsQWNjdXJhY3kvdmVydGljYWxBY2N1cmFjeeOAggogICAgdmFyIGNmZyA9IHt9OwogICAgZm9yICh2YXIgayBpbiBERUZBVUxUX0NPTkZJRykgeyBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKERFRkFVTFRfQ09ORklHLCBrKSkgY2ZnW2tdID0gREVGQVVMVF9DT05GSUdba107IH0KICAgIHZhciBrZXlzID0gWyJlbmFibGVkIiwgImxhdGl0dWRlIiwgImxvbmdpdHVkZSIsICJhbHRpdHVkZSIsICJob3Jpem9udGFsQWNjdXJhY3kiLCAidmVydGljYWxBY2N1cmFjeSIsICJyYW5kb21SYWRpdXMiXTsKICAgIGlmICh0eXBlb2YgJHByZWZzICE9PSAidW5kZWZpbmVkIiAmJiAkcHJlZnMudmFsdWVGb3JLZXkpIHsKICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBrZXlzLmxlbmd0aDsgaSsrKSB7CiAgICAgICAgdmFyIHYgPSAkcHJlZnMudmFsdWVGb3JLZXkoa2V5c1tpXSk7CiAgICAgICAgaWYgKHYgIT0gbnVsbCAmJiB2ICE9PSAiIikgY2ZnW2tleXNbaV1dID0gdjsKICAgICAgfQogICAgfQogICAgcmV0dXJuIG5vcm1hbGl6ZUNvbmZpZyhjZmcpOwogIH0KCiAgZnVuY3Rpb24gbWVyZ2VDb25maWcoYmFzZSwgZXh0cmEpIHsKICAgIHZhciBvdXQgPSB7fSwga2V5OwogICAgZm9yIChrZXkgaW4gYmFzZSkgeyBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGJhc2UsIGtleSkpIG91dFtrZXldID0gYmFzZVtrZXldOyB9CiAgICBleHRyYSA9IGV4dHJhIHx8IHt9OwogICAgZm9yIChrZXkgaW4gZXh0cmEpIHsgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChleHRyYSwga2V5KSkgb3V0W2tleV0gPSBleHRyYVtrZXldOyB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgLy8gPT09PT09PT09PSBRWCBFbnRyeSBQb2ludCA9PT09PT09PT09CgogIGZ1bmN0aW9uIHJ1blFYKCkgewogICAgdmFyIGhhc1Jlc3BvbnNlID0gdHlwZW9mICRyZXNwb25zZSAhPT0gInVuZGVmaW5lZCI7CgogICAgaWYgKGhhc1Jlc3BvbnNlKSB7CiAgICAgIHZhciBjb25maWcgPSBudWxsOwogICAgICB0cnkgewogICAgICAgIC8vIGxvYWRDb25maWcoKSDlnKggdHJ5IOWFp++8miRwcmVmcyDlhaflrrnmkI3lo57vvIjlpoLnt6/luqbotoXlh7rnr4TlnI3vvInmmYIgbm9ybWFsaXplQ29uZmlnIOacg+S4n+S+i+Wklu+8jAogICAgICAgIC8vIOW/hemgiOS7jeWRvOWPqyAkZG9uZSh7fSkg5pS+6KGM5Y6f5aeL5Zue5oeJ77yM5ZCm5YmHIFFYIOacg+S4gOebtOetieW+heiFs+acrOe1kOadn+OAggogICAgICAgIGNvbmZpZyA9IGxvYWRDb25maWcoKTsKICAgICAgICBpZiAoIWNvbmZpZy5lbmFibGVkKSB7ICRkb25lKHt9KTsgcmV0dXJuOyB9CiAgICAgICAgLy8gUVggdjEuMC4xOSsg6LW35LqM6L+b5Yi25ZON5bqU6LWwICRyZXNwb25zZS5ib2R5Qnl0ZXMoQXJyYXlCdWZmZXIp77yMCiAgICAgICAgLy8gJHJlc3BvbnNlLmJvZHkg5a+55LqM6L+b5Yi25piv56m6L+S5seeggeaWh+acrOOAguivpuingSBjcm9zc3V0aWxpdHkvUXVhbnR1bXVsdC1YCiAgICAgICAgLy8g55qEIHNhbXBsZS1ieXRlcy1yZXdyaXRlLmpz44CCCiAgICAgICAgdmFyIHJhd0J1ZiA9ICRyZXNwb25zZS5ib2R5Qnl0ZXM7CiAgICAgICAgaWYgKCFyYXdCdWYgfHwgKHJhd0J1Zi5ieXRlTGVuZ3RoICE9PSB1bmRlZmluZWQgJiYgcmF3QnVmLmJ5dGVMZW5ndGggPT09IDApKSB7CiAgICAgICAgICAkZG9uZSh7fSk7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQogICAgICAgIHZhciByZXNwb25zZUJ5dGVzID0gcmF3QnVmIGluc3RhbmNlb2YgVWludDhBcnJheSA/IHJhd0J1ZiA6IG5ldyBVaW50OEFycmF5KHJhd0J1Zik7CiAgICAgICAgaWYgKHJlc3BvbnNlQnl0ZXMubGVuZ3RoIDwgMikgeyAkZG9uZSh7fSk7IHJldHVybjsgfQogICAgICAgIGlmIChjb25maWcuZGVidWcpIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIFFYIHJlc3BvbnNlOiAiICsgcmVzcG9uc2VCeXRlcy5sZW5ndGggKyAiIGJ5dGVzLCBoZWFkPSIgKyBoZXhQcmV2aWV3KHJlc3BvbnNlQnl0ZXMsIDMyKSk7CiAgICAgICAgdmFyIHJlc3VsdCA9IHNwb29mQXBwbGVSZXNwb25zZShyZXNwb25zZUJ5dGVzLCBjb25maWcpOwogICAgICAgIGlmIChjb25maWcuZGVidWcpIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIHBhdGNoZWQgIiArIHJlc3VsdC53aWZpQ291bnQgKyAiIHdpZmksICIgKyByZXN1bHQuY2VsbENvdW50ICsgIiBjZWxsLCBraW5kPSIgKyByZXN1bHQua2luZCArICIsIHJlc3BvbnNlPSIgKyByZXN1bHQucmVzcG9uc2UubGVuZ3RoICsgIiBieXRlcyIpOwogICAgICAgIGlmIChjb25maWcuZGVidWcpIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIGxvY2F0aW9uczogIiArIHBhdGNoZWRQYXlsb2FkU3VtbWFyeShyZXN1bHQucGF5bG9hZCkpOwogICAgICAgIC8vIFFYOiDkuozov5vliLbmlLnlkI7lk43lupTlv4XpobvnlKggJGRvbmUoe2JvZHlCeXRlczogQXJyYXlCdWZmZXJ9KSDlm57lhpkKICAgICAgICAkZG9uZSh7CiAgICAgICAgICBib2R5Qnl0ZXM6IHJlc3VsdC5yZXNwb25zZS5idWZmZXIuc2xpY2UoCiAgICAgICAgICAgIHJlc3VsdC5yZXNwb25zZS5ieXRlT2Zmc2V0LAogICAgICAgICAgICByZXN1bHQucmVzcG9uc2UuYnl0ZU9mZnNldCArIHJlc3VsdC5yZXNwb25zZS5ieXRlTGVuZ3RoCiAgICAgICAgICApCiAgICAgICAgfSk7CiAgICAgIH0gY2F0Y2ggKGVycikgewogICAgICAgIGlmIChjb25maWcgJiYgY29uZmlnLmRlYnVnKSBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBmYWlsZWQ6ICIgKyBlcnIubWVzc2FnZSk7CiAgICAgICAgJGRvbmUoe30pOwogICAgICB9CiAgICB9IGVsc2UgewogICAgICAkZG9uZSh7fSk7CiAgICB9CiAgfQoKICB2YXIgYXBpID0gewogICAgREVGQVVMVF9DT05GSUc6IERFRkFVTFRfQ09ORklHLAogICAgYmFzZTY0VG9CeXRlczogYmFzZTY0VG9CeXRlcywKICAgIGJ5dGVzVG9CYXNlNjQ6IGJ5dGVzVG9CYXNlNjQsCiAgICBwYXRjaEFwcGxlV0xvY1BheWxvYWQ6IHBhdGNoQXBwbGVXTG9jUGF5bG9hZCwKICAgIHNwb29mQXBwbGVSZXNwb25zZTogc3Bvb2ZBcHBsZVJlc3BvbnNlLAogICAgZXh0cmFjdEFwcGxlV0xvY1BheWxvYWQ6IGV4dHJhY3RBcHBsZVdMb2NQYXlsb2FkLAogICAgcGFyc2VBcnBjOiBwYXJzZUFycGMsCiAgICBjb29yZFRvSW50OiBjb29yZFRvSW50LAogICAgbm9ybWFsaXplQ29uZmlnOiBub3JtYWxpemVDb25maWcsCiAgICBsb2FkQ29uZmlnOiBsb2FkQ29uZmlnCiAgfTsKCiAgaWYgKHR5cGVvZiBtb2R1bGUgIT09ICJ1bmRlZmluZWQiICYmIG1vZHVsZS5leHBvcnRzKSB7CiAgICBtb2R1bGUuZXhwb3J0cyA9IGFwaTsKICB9IGVsc2UgewogICAgcnVuUVgoKTsKICB9Cn0oKSk7Cg==";

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
<script>try{var th=localStorage.getItem('theme');if(th==='light'||th==='dark')document.documentElement.setAttribute('data-theme',th);}catch(e){}<\/script>
<style>
:root {
  --bg:#ffffff; --card:#ffffff; --card2:#f5f5f7; --line:#e5e5ea; --inset:#f2f2f7;
  --cyan:#0062d9; --cyan2:#0056b3; --green:#1e7a35; --red:#d70015; --orange:#ff9500; /* ponytail: iOS tokens darkened for AA (white-on-blue 5.60, white-on-green 5.40) */
  --txt:#1c1c1e; --muted:#6e6e73; --mono:#5856d6;
  --blue:#0062d9; --gray:#6e6e73;
  --on-accent:#ffffff; --ck:#0062d9; --ph:#8e8e93; --hint:#4b5563; --barbg:rgba(255,255,255,.92); --press:#e5e5ea;
  --err-txt:#3a3a3c; --focus-ring:rgba(0,98,217,.18); --scroll:#d1d1d6;
}
/* ---- dark theme: Apple system colors. data-theme wins over the media block below. ---- */
html[data-theme=dark] {
  --bg:#0b0b0d; --card:#1c1c1e; --card2:#16161a; --line:#38383a; --inset:#2c2c2e;
  --cyan:#0a84ff; --cyan2:#409cff; --green:#30d158; --red:#ff453a; --orange:#ff9f0a;
  --txt:#ebebf0; --muted:#a1a1a6; --mono:#8ab8ff;
  --blue:#0a84ff; --gray:#a1a1a6;
  --on-accent:#0b0b0d; --ck:#8ab8ff; --ph:#9a9aa0; --hint:#a1a1a6; --barbg:rgba(28,28,30,.92); --press:#3a3a3c;
  --err-txt:#ebebf0; --focus-ring:rgba(10,132,255,.32); --scroll:#48484a;
}
@media (prefers-color-scheme:dark) {
  html:not([data-theme]) {
    --bg:#0b0b0d; --card:#1c1c1e; --card2:#16161a; --line:#38383a; --inset:#2c2c2e;
    --cyan:#0a84ff; --cyan2:#409cff; --green:#30d158; --red:#ff453a; --orange:#ff9f0a;
    --txt:#ebebf0; --muted:#a1a1a6; --mono:#8ab8ff;
    --blue:#0a84ff; --gray:#a1a1a6;
    --on-accent:#0b0b0d; --ck:#8ab8ff; --ph:#9a9aa0; --hint:#a1a1a6; --barbg:rgba(28,28,30,.92); --press:#3a3a3c;
    --err-txt:#ebebf0; --focus-ring:rgba(10,132,255,.32); --scroll:#48484a;
  }
}
/* dark map controls: keep edges + stronger shadow so they don't melt into tiles */
html[data-theme=dark] .leaflet-bar, html[data-theme=dark] .lang-switch, html[data-theme=dark] .layer-toggle { box-shadow:0 2px 14px rgba(0,0,0,.55)!important; }
@media (prefers-color-scheme:dark) {
  html:not([data-theme]) .leaflet-bar, html:not([data-theme]) .lang-switch, html:not([data-theme]) .layer-toggle { box-shadow:0 2px 14px rgba(0,0,0,.55)!important; }
}
* { margin:0; padding:0; box-sizing:border-box; }
body {
  font-family:-apple-system,system-ui,"SF Pro TC","PingFang TC","Helvetica Neue",sans-serif;
  color:var(--txt);
  background:var(--bg);
  overscroll-behavior-y:none;
}
::placeholder { color:var(--ph); }
::-webkit-scrollbar { width:6px; height:6px; }
::-webkit-scrollbar-thumb { background:var(--scroll); border-radius:3px; }

/* ---- 頂部列 ---- */
.topbar { position:sticky; top:0; z-index:1200; display:flex; align-items:center; gap:10px; padding:9px 12px; background:var(--barbg); -webkit-backdrop-filter:blur(14px); backdrop-filter:blur(14px); border-bottom:1px solid var(--line); font-size:11px; color:var(--muted); }
.topbar .back { flex:none; color:var(--cyan); font-weight:700; text-decoration:none; }
.topbar .topcredit { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-align:center; }
.topbar .topcredit .title { font-size:14px; font-weight:800; color:var(--txt); letter-spacing:.3px; }

/* ---- 地圖 ---- */
#map { height:56vh; width:100%; min-height:300px; background:var(--inset); border-bottom:1px solid var(--line); }
.leaflet-container { background:var(--inset); }
.leaflet-control-zoom a { background:var(--barbg)!important; color:var(--txt)!important; border-color:var(--line)!important; -webkit-backdrop-filter:blur(10px); backdrop-filter:blur(10px); }
.leaflet-control-zoom a:hover { background:var(--inset)!important; }
.leaflet-bar { border:1px solid var(--line)!important; box-shadow:0 2px 12px rgba(0,0,0,.08)!important; }
.leaflet-control-attribution { background:var(--barbg)!important; color:var(--muted)!important; }
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
.btn-primary { background:var(--cyan); color:var(--on-accent); }
.btn-primary:active { filter:brightness(.92); transform:scale(.97); }
.btn-primary[disabled] { opacity:.35; }
.btn-secondary { background:var(--card2); color:var(--txt); border:1px solid var(--line); font-weight:600; }
.btn-secondary:active { background:var(--press); transform:scale(.97); }
.btn-danger { background:transparent; color:var(--red); border:1px solid rgba(255,59,48,.35); }
.btn-danger:active { background:rgba(255,59,48,.08); transform:scale(.97); }
.btn.success { background:var(--green); color:var(--on-accent); border:none; }
.btn-sm { flex:none; min-width:auto; min-height:40px; padding:6px 12px; font-size:12px; border-radius:8px; }
:focus-visible { outline:2px solid var(--cyan); outline-offset:2px; }

/* ---- 輸入框 ---- */
.input-row { display:flex; gap:8px; margin-top:10px; }
.input-row input { flex:1; padding:10px 12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; font-size:14px; color:var(--txt); outline:none; min-width:0; -webkit-appearance:none; transition:border-color .15s,box-shadow .15s; }
.cvi { flex:1; min-width:0; width:100%; font-family:"SF Mono",ui-monospace,monospace; font-size:14px; color:var(--mono); padding:6px 10px; background:var(--inset); border:1px solid var(--line); border-radius:8px; outline:none; -webkit-appearance:none; transition:border-color .15s,box-shadow .15s; }
.accfield input { width:100%; padding:8px 10px; background:var(--inset); border:1px solid var(--line); border-radius:8px; font-size:14px; color:var(--txt); outline:none; -webkit-appearance:none; transition:border-color .15s,box-shadow .15s; }
.input-row input:focus, .cvi:focus, .accfield input:focus, .modal input:focus { border-color:var(--cyan); box-shadow:0 0 0 3px var(--focus-ring); }
.acc-row { display:flex; gap:8px; margin-bottom:6px; }
.accfield { flex:1; min-width:0; display:flex; flex-direction:column; gap:4px; }
.acclbl { font-size:11px; color:var(--muted); }

.status { font-size:12px; color:var(--muted); margin-top:8px; text-align:center; }
.hint { font-size:13px; color:var(--hint); margin-top:8px; line-height:1.6; }
.accnote { margin-top:10px; padding:11px 13px; background:var(--inset); border:1px solid var(--line); border-radius:9px; font-size:11.5px; color:var(--err-txt); line-height:1.85; }
.accnote b { display:block; color:var(--cyan); font-weight:800; font-size:12px; margin-bottom:6px; letter-spacing:.3px; }
.accnote code { font-family:"SF Mono",ui-monospace,monospace; color:var(--mono); font-size:11px; }
.accnote em { color:var(--txt); font-style:normal; font-weight:800; }
.accnote .src { display:block; margin-top:7px; color:var(--muted); font-size:10.5px; }

/* ---- 清單 ---- */
.search-results { margin-top:8px; max-height:260px; overflow-y:auto; }
.search-item { padding:10px 12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; margin-bottom:6px; cursor:pointer; transition:all .15s; }
.search-item:active { background:var(--press); border-color:var(--cyan); }
.search-item .si-name { font-size:14px; color:var(--txt); font-weight:600; }
.search-item .si-sub { font-size:11px; color:var(--muted); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

.error-banner { background:rgba(255,59,48,.06); border:1px solid rgba(255,59,48,.3); border-left:4px solid var(--red); color:#3a3a3c; padding:14px 16px; border-radius:12px; margin-bottom:12px; font-size:13.5px; line-height:1.6; display:none; }
.error-banner b { display:block; margin-bottom:4px; color:var(--red); font-size:14.5px; }
.error-banner .btn { flex:none; margin-top:10px; }

.toast { position:fixed; top:60px; left:50%; transform:translateX(-50%); background:rgba(28,28,30,.92); -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px); color:#ffffff; padding:11px 20px; border-radius:22px; font-size:14px; opacity:0; transition:opacity .3s; pointer-events:none; z-index:9999; max-width:90vw; text-align:center; box-shadow:0 8px 28px rgba(0,0,0,.15); }
.toast.show { opacity:1; }

.active-loc { background:var(--inset); border:1px solid var(--line); border-radius:10px; padding:11px 12px; font-size:13px; color:var(--txt); }
.active-loc .label { font-size:11px; color:var(--muted); margin-bottom:5px; }
.active-loc .value { font-family:"SF Mono",ui-monospace,monospace; font-size:13px; color:var(--mono); }

.fav-list { max-height:240px; overflow-y:auto; }
.fav-item { display:flex; align-items:center; gap:8px; padding:10px 12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; margin-bottom:6px; cursor:pointer; transition:all .15s; }
.fav-item:active { background:var(--press); border-color:var(--cyan); }
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
.modal { background:var(--card); border-radius:18px; padding:20px; width:100%; max-width:340px; box-shadow:0 6px 16px rgba(0,0,0,.15); }
.modal h3 { font-size:17px; font-weight:700; margin-bottom:16px; text-align:center; color:var(--txt); }
.modal input { width:100%; padding:12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; font-size:15px; color:var(--txt); outline:none; margin-bottom:12px; -webkit-appearance:none; transition:border-color .15s,box-shadow .15s; }
.modal .modal-btns { display:flex; gap:8px; }
.modal .modal-btns .btn { padding:12px; }

/* ---- 地圖圖層切換（一顆圖層鈕開 popover，取代 6 顆平級 chip） ---- */
.layer-pop { position:absolute; top:10px; right:10px; z-index:1000; }
.layer-toggle { min-height:44px; padding:0 12px; display:flex; align-items:center; gap:6px; background:var(--barbg); -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px); border:1px solid var(--line); border-radius:10px; font-size:13px; font-weight:700; color:var(--txt); cursor:pointer; box-shadow:0 2px 8px rgba(0,0,0,.06); }
.layer-toggle svg { width:15px; height:15px; flex:none; }
.layer-popover { position:absolute; top:52px; right:0; z-index:1100; display:none; width:min(300px, calc(100vw - 24px)); max-height:min(60vh, 420px); overflow-y:auto; background:var(--barbg); -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px); border:1px solid var(--line); border-radius:12px; padding:6px; box-shadow:0 4px 10px rgba(0,0,0,.16); }
.layer-popover.show { display:block; }
.lp-group { font-size:11px; font-weight:800; letter-spacing:.5px; color:var(--muted); padding:8px 10px 4px; text-transform:uppercase; }
.lp-item { display:flex; flex-direction:column; gap:2px; width:100%; text-align:left; border:none; background:transparent; padding:7px 10px; border-radius:8px; cursor:pointer; min-height:44px; justify-content:center; }
.lp-item .lp-name { font-size:14px; font-weight:600; color:var(--txt); }
.lp-item .lp-desc { font-size:13px; color:var(--muted); line-height:1.35; }
.lp-item.active { background:var(--cyan); }
.lp-item.active .lp-name, .lp-item.active .lp-desc { color:var(--on-accent); }
.lang-switch { position:absolute; top:10px; left:10px; z-index:1000; display:flex; gap:2px; align-items:stretch; background:var(--barbg); -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px); border:1px solid var(--line); border-radius:10px; padding:4px; box-shadow:0 2px 8px rgba(0,0,0,.06); }
.lang-btn { border:none; background:transparent; min-height:32px; padding:6px 11px; border-radius:7px; font-size:12px; font-weight:700; color:var(--muted); cursor:pointer; transition:all .15s; }
.lang-btn.active { background:var(--cyan); color:var(--on-accent); }
.lang-btn:active { transform:scale(.95); }
.theme-btn { min-width:44px; min-height:44px; display:flex; align-items:center; justify-content:center; color:var(--txt); }
.theme-btn svg { width:18px; height:18px; }
.sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }

/* ---- 手機黏著列：座標讀數＋儲存（桌面不顯示；地圖僅佔畫面中上段，不會蓋到右下縮放鈕） ---- */
.mobile-bar { display:none; position:fixed; left:0; right:0; bottom:0; z-index:1300; align-items:center; gap:10px; padding:8px 12px calc(8px + env(safe-area-inset-bottom)); background:var(--barbg); -webkit-backdrop-filter:blur(14px); backdrop-filter:blur(14px); border-top:1px solid var(--line); box-shadow:0 -2px 12px rgba(0,0,0,.08); }
.mobile-bar .mb-coords { flex:1; min-width:0; font-family:"SF Mono",ui-monospace,monospace; font-size:13px; color:var(--txt); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.mobile-bar .mb-empty { color:var(--muted); font-family:inherit; }
.mobile-bar .btn { flex:none; min-width:auto; min-height:44px; padding:10px 16px; }
@media(max-width:768px) {
  .mobile-bar { display:flex; }
  .panel { padding-bottom:calc(90px + env(safe-area-inset-bottom)); }
}
html[data-theme=dark] .crow .ck { color:#64d2ff; }
@media (prefers-color-scheme:dark) { html:not([data-theme]) .crow .ck { color:#64d2ff; } }

@media(max-width:480px) { #map { height:50vh; } .panel { padding:12px 12px calc(90px + env(safe-area-inset-bottom)); } }
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
  <button class="lang-btn theme-btn" id="themeBtn" type="button" aria-label="主題" onclick="cycleTheme()"></button>
</div>
<div class="layer-pop">
  <button class="layer-toggle" id="layerToggle" type="button" aria-expanded="false" aria-controls="layerPopover" data-i18n-al="layer_toggle_aria" aria-label="切換地圖底圖" onclick="toggleLayerPop()"></button>
  <div class="layer-popover" id="layerPopover" role="group" aria-label="底圖"></div>
</div>
</div>
<div class="panel">
  <div class="error-banner" id="errorBanner" role="alert">
  <div id="errBody"></div>
  <button class="btn btn-sm btn-secondary retry-btn" type="button" id="errRetry" data-i18n="retry" onclick="if(window.__errRetry)window.__errRetry()">重試</button>
</div>
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
    <div style="font-size:13px;color:var(--hint);margin-top:6px" data-i18n="paste_hint">支援 Apple Maps · Google Maps · 高德 · 百度 · 座標文字（自動換算為 WGS-84）</div>
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
<div class="mobile-bar" id="mobileBar">
  <span class="mb-coords mb-empty" id="mbCoords" data-i18n="pick_none">尚未選擇位置</span>
  <button class="btn btn-primary" id="mbSave" type="button" disabled data-i18n="save_short" onclick="save()">儲存</button>
</div>
<div class="toast" id="toast" aria-live="polite" role="status"></div>
<div class="modal-overlay" id="favModal" role="dialog" aria-modal="true" aria-labelledby="favModalTitle" onclick="if(event.target===this)closeFavModal()">
  <div class="modal">
    <h3 id="favModalTitle" data-i18n="modal_title">收藏此位置</h3>
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
    layer_toggle_aria: '切換地圖底圖', lp_group_base: '底圖',
    lp_satellite_d: 'ArcGIS 衛星實拍影像（預設）', lp_wgs84_d: 'OpenStreetMap 圖資，附隨機偏移提示', lp_amap_d: '高德地圖，中國道路與地名最完整',
    lp_voyager_d: 'CARTO 淺色導航圖，疊加標點最清楚', lp_standard_d: 'CARTO 極簡淡色底圖', lp_dark_d: 'CARTO 深色底圖，夜間省眼',
    retry: '重試', pick_none: '尚未選擇位置', op_failed: '操作未完成，詳情見下方提示',
    err_first: '暫時讀不到裝置目前座標（不影響選點與儲存）。',
    theme_auto: '自動（跟隨系統）', theme_light: '淺色', theme_dark: '深色', theme_btn_aria: '主題', theme_now: '目前主題：',
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
    layer_toggle_aria: 'Change base map', lp_group_base: 'Base map',
    lp_satellite_d: 'ArcGIS satellite imagery (default)', lp_wgs84_d: 'OpenStreetMap data, with GCJ-02 offset hint', lp_amap_d: 'AMap - best roads and POI names in China',
    lp_voyager_d: 'CARTO Voyager - light labels, best with pins', lp_standard_d: 'CARTO Positron - minimal light base', lp_dark_d: 'CARTO Dark Matter - easy on the eyes at night',
    retry: 'Retry', pick_none: 'No location selected', op_failed: 'Operation failed - see the notice below',
    err_first: 'Could not read the device current location (point picking and saving still work).',
    theme_auto: 'Auto (system)', theme_light: 'Light', theme_dark: 'Dark', theme_btn_aria: 'Theme', theme_now: 'Theme: ',
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
  document.querySelectorAll('.lang-btn[data-lang]').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-lang') === lang); });
  renderLayerUI();
  applyTheme();
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

/* ---- 主題三軌：auto → light → dark → auto（localStorage 'theme'，預設 auto 跟系統） ---- */
const THEME_KEY = 'theme';
let themePref = 'auto';
try { const tv = localStorage.getItem(THEME_KEY); if (tv === 'light' || tv === 'dark') themePref = tv; } catch(e) {}
const THEME_ICONS = {
  auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/></svg>',
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/></svg>',
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/></svg>'
};
function themeLabel(p) { return p === 'auto' ? t('theme_auto') : p === 'light' ? t('theme_light') : t('theme_dark'); }
function applyTheme() {
  if (themePref === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', themePref);
  const darkNow = themePref === 'dark' || (themePref === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme:dark)').matches);
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', darkNow ? '#0b0b0d' : '#ffffff');
  const btn = document.getElementById('themeBtn');
  if (btn) {
    const label = themeLabel(themePref);
    btn.innerHTML = THEME_ICONS[themePref] + '<span class="sr-only">' + escHtml(label) + '</span>';
    btn.setAttribute('aria-label', t('theme_btn_aria') + ': ' + label);
  }
}
function cycleTheme() {
  themePref = themePref === 'auto' ? 'light' : themePref === 'light' ? 'dark' : 'auto';
  try { localStorage.setItem(THEME_KEY, themePref); } catch(e) {}
  applyTheme();
  toast(t('theme_now') + themeLabel(themePref), 1500);
}

const map = L.map('map').setView([20, 0], 2); map.zoomControl.setPosition('bottomright');
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
let curLayerName = 'satellite';
const LAYER_LABEL_KEY = { satellite:'layer_satellite', amap:'layer_amap', voyager:'layer_color', standard:'layer_standard', dark:'layer_dark' };
const MAP_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="1 6 8 3 16 6 23 3 23 18 16 21 8 18 1 21"/><line x1="8" y1="3" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="21"/></svg>';
function lpLabel(name) { return name === 'wgs84' ? 'WGS84' : t(LAYER_LABEL_KEY[name]); }
function renderLayerUI() {
  const btn = document.getElementById('layerToggle');
  if (btn) btn.innerHTML = MAP_SVG + '<span>' + escHtml(lpLabel(curLayerName)) + '</span>';
  const pop = document.getElementById('layerPopover');
  if (pop) { pop.setAttribute('aria-label', t('lp_group_base')); pop.innerHTML = '<div class="lp-group">' + escHtml(t('lp_group_base')) + '</div>' +
    Object.keys(tiles).map(function(n){
      return '<button type="button" class="lp-item' + (n === curLayerName ? ' active' : '') + '" data-layer="' + n + '" onclick="switchLayer(&#39;' + n + '&#39;)">' +
        '<span class="lp-name">' + escHtml(lpLabel(n)) + '</span>' +
        '<span class="lp-desc">' + escHtml(t('lp_' + n + '_d')) + '</span></button>';
    }).join(''); }
}
function toggleLayerPop(force) {
  const pop = document.getElementById('layerPopover'), btn = document.getElementById('layerToggle');
  const open = force !== undefined ? force : !pop.classList.contains('show');
  pop.classList.toggle('show', open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function switchLayer(name) {
  map.removeLayer(currentLayer);
  currentLayer = tiles[name];
  currentLayer.addTo(map);
  curLayerName = name;
  renderLayerUI();
  toggleLayerPop(false);
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
  const mb = document.getElementById('mbCoords');
  const mbs = document.getElementById('mbSave');
  if (mb) {
    mb.classList.toggle('mb-empty', !selected);
    mb.textContent = selected ? (lon.toFixed(6) + ', ' + lat.toFixed(6)) : t('pick_none');
  }
  if (mbs) mbs.disabled = !selected;
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

function showError(show, retryFn, msg) {
  const b = document.getElementById('errorBanner');
  b.style.display = show ? 'block' : 'none';
  if (show) {
    document.getElementById('errBody').innerHTML = msg || t('err_html');
    const rb = document.getElementById('errRetry');
    rb.style.display = retryFn ? '' : 'none';
    window.__errRetry = retryFn || null;
  }
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
  try {
    const arr = JSON.parse(localStorage.getItem(FAV_KEY));
    if (!Array.isArray(arr)) return [];
    // 過濾損壞的收藏（非數字或超出範圍的座標），避免 toFixed 等處拋錯
    return arr.filter(f => f && typeof f.lat === 'number' && typeof f.lon === 'number' &&
      Number.isFinite(f.lat) && Number.isFinite(f.lon) && Math.abs(f.lat) <= 90 && Math.abs(f.lon) <= 180);
  } catch(e) { return []; }
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
    return '<div class="fav-item" role="button" tabindex="0" onclick="loadFav(' + i + ')" onkeydown="favKey(event,' + i + ')">' +
      '<div class="fav-info">' +
        '<div class="fav-name">' + escHtml(f.name) + '<\\/div>' +
        '<div class="fav-coords">' + f.lon.toFixed(6) + ', ' + f.lat.toFixed(6) + altStr + '<\\/div>' +
        (isActive ? '<div class="fav-active">' + escHtml(t('active_now')) + '<\\/div>' : '') +
      '<\\/div>' +
      '<button class="fav-del" aria-label="' + escHtml(t('del')) + '" onclick="event.stopPropagation();delFav(' + i + ')" title="' + escHtml(t('del')) + '">\\u00d7<\\/button>' +
    '<\\/div>';
  }).join('');
}

function favKey(e, i) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); loadFav(i); } }

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function addFav() {
  if (!selected) { toast(t('pick_first')); return; }
  var _fa = currentAlt();
  document.getElementById('favModalCoords').textContent = lon.toFixed(6) + ', ' + lat.toFixed(6) + (_fa !== null ? ('  ·  ' + _fa + ' m') : '');
  document.getElementById('favNameInput').value = '';
  lastFocused = document.activeElement;
  document.getElementById('favModal').classList.add('show');
  setTimeout(() => document.getElementById('favNameInput').focus(), 100);
}

function closeFavModal() {
  document.getElementById('favModal').classList.remove('show');
  if (lastFocused && lastFocused.focus) lastFocused.focus();
  lastFocused = null;
}

var lastFocused = null;
document.addEventListener('keydown', function(e){
  if (e.key === 'Escape') {
    if (document.getElementById('favModal').classList.contains('show')) { closeFavModal(); return; }
    if (document.getElementById('layerPopover').classList.contains('show')) { toggleLayerPop(false); document.getElementById('layerToggle').focus(); }
    return;
  }
  if (e.key === 'Tab' && document.getElementById('favModal').classList.contains('show')) {
    const f = [...document.querySelectorAll('#favModal button, #favModal input')].filter(el => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});
document.addEventListener('click', function(e){
  const pop = document.getElementById('layerPopover');
  if (pop && pop.classList.contains('show') && !pop.contains(e.target) && !e.target.closest('#layerToggle')) toggleLayerPop(false);
});

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
    .catch(() => {
      activeStatus = 'failed'; renderActive();
      showError(true, queryActive, '<b>' + escHtml(t('err_first')) + '</b>');
      toast(t('op_failed'), 1500);
    });
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
      } else { showError(true, clearActive, '<b>' + escHtml(t('clear_failed', d.error || '')) + '</b>'); toast(t('op_failed'), 1500); }
    })
    .catch(() => { showError(true, clearActive, '<b>' + escHtml(t('clear_failed_cfg')) + '</b>'); toast(t('op_failed'), 1500); });
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
    showError(true, save);
    toast(t('op_failed'), 1500);
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
  return null;
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
      } else { showError(true, restoreReal, '<b>' + escHtml(t('clear_failed_cfg')) + '</b>'); toast(t('op_failed'), 1500); }
    })
    .catch(() => { showError(true, restoreReal, '<b>' + escHtml(t('clear_failed_cfg')) + '</b>'); toast(t('op_failed'), 1500); });
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
<script>try{var th=localStorage.getItem('theme');if(th==='light'||th==='dark')document.documentElement.setAttribute('data-theme',th);}catch(e){}<\/script>
<link rel="apple-touch-icon" href="/icon-180.png">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>
/* tokens identical to /picker (src/page.js) — same Apple system colors, same tri-state theme switch */
:root{
  --bg:#ffffff; --card:#ffffff; --card2:#f5f5f7; --line:#e5e5ea; --inset:#f2f2f7;
  --brand:#0062d9; --brand2:#0056b3; --green:#1e7a35; --green2:#059669;
  --red:#d70015; --amber:#ff9500; --txt:#1c1c1e; --muted:#6e6e73; --mono:#5856d6;
  --on-accent:#ffffff; --press:#e5e5ea;
}
html[data-theme=dark]{
  --bg:#0b0b0d; --card:#1c1c1e; --card2:#16161a; --line:#38383a; --inset:#2c2c2e;
  --brand:#0a84ff; --brand2:#409cff; --green:#30d158; --green2:#22b87a;
  --red:#ff453a; --amber:#ff9f0a; --txt:#ebebf0; --muted:#a1a1a6; --mono:#8ab8ff;
  --on-accent:#0b0b0d; --press:#3a3a3c;
}
@media (prefers-color-scheme:dark){
  html:not([data-theme]){
    --bg:#0b0b0d; --card:#1c1c1e; --card2:#16161a; --line:#38383a; --inset:#2c2c2e;
    --brand:#0a84ff; --brand2:#409cff; --green:#30d158; --green2:#22b87a;
    --red:#ff453a; --amber:#ff9f0a; --txt:#ebebf0; --muted:#a1a1a6; --mono:#8ab8ff;
    --on-accent:#0b0b0d; --press:#3a3a3c;
  }
}
*{ margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
body{
  font-family:-apple-system,system-ui,"SF Pro TC","PingFang TC","Helvetica Neue",sans-serif;
  color:var(--txt); line-height:1.5;
  background:var(--card2);
  -webkit-font-smoothing:antialiased;
}
.wrap{ max-width:600px; margin:0 auto; padding:20px 16px calc(44px + env(safe-area-inset-bottom)); }
.theme-fab{ position:fixed; top:14px; right:14px; width:44px; height:44px; display:flex; align-items:center; justify-content:center; border:1px solid var(--line); border-radius:12px; background:var(--card); color:var(--txt); cursor:pointer; box-shadow:0 1px 4px rgba(0,0,0,.06); z-index:98; font-family:inherit; }
.theme-fab svg{ width:18px; height:18px; }

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
.enter.go{ background:var(--brand); color:var(--on-accent); }

.divider{ height:1px; background:linear-gradient(90deg,transparent,var(--line),transparent); margin:24px 0 20px; }

h2{ font-size:16px; font-weight:800; margin-bottom:4px; display:flex; align-items:center; gap:9px; }
h2::before{ content:""; width:3px; height:14px; border-radius:2px; background:var(--brand); flex:none; }
.sub{ font-size:12.5px; color:var(--muted); margin:0 0 14px 13px; }
.note{ background:var(--inset); border:1px solid var(--line); border-left:4px solid var(--brand); border-radius:11px; padding:12px 14px; font-size:12.5px; color:var(--muted); margin-bottom:16px; line-height:1.8; }
.note b{ color:var(--txt); }

.plat{ background:var(--card); border:1px solid var(--line); border-radius:16px; padding:16px; margin-bottom:12px; box-shadow:0 1px 4px rgba(0,0,0,.04); }
.plat .big{ display:flex; align-items:center; justify-content:center; gap:8px; width:100%; padding:14px; border:none; border-radius:11px; background:var(--brand); color:var(--on-accent); font-size:15.5px; font-weight:800; cursor:pointer; text-align:center; text-decoration:none; transition:filter .12s,transform .12s; }
.plat .big:active{ filter:brightness(.92); transform:scale(.97); }
.plat .line{ display:flex; align-items:center; gap:8px; margin-top:9px; }
.plat .url{ flex:1; min-width:0; font-family:"SF Mono",ui-monospace,monospace; font-size:11px; color:var(--muted); background:var(--inset); border:1px solid var(--line); border-radius:10px; padding:8px 10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.plat .copy{ flex:none; padding:8px 15px; min-height:40px; border:1px solid var(--line); border-radius:8px; background:var(--card2); color:var(--txt); font-size:12.5px; font-weight:600; cursor:pointer; transition:all .12s; font-family:inherit; }
.plat .copy:active{ background:var(--press); }
.plat .copy.ok{ background:var(--green); border-color:var(--green); color:var(--on-accent); }
.plat .pnote{ font-size:11.5px; color:var(--muted); margin-top:7px; line-height:1.6; }

.mitm{ background:var(--card); border:1px solid var(--line); border-radius:16px; padding:16px; font-size:12.5px; color:var(--muted); margin-top:12px; box-shadow:0 1px 4px rgba(0,0,0,.04); }
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
  <button class="theme-fab" id="themeBtn" type="button" aria-label="主題"></button>
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
/* tri-state theme, same localStorage('theme') key + icons as /picker */
var THEME_ICONS = {
  auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/></svg>',
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/></svg>',
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/></svg>'
};
var themePref = 'auto';
try { var tv = localStorage.getItem('theme'); if (tv === 'light' || tv === 'dark') themePref = tv; } catch(e) {}
function applyTheme(){
  if (themePref === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', themePref);
  var darkNow = themePref === 'dark' || (themePref === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme:dark)').matches);
  var meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', darkNow ? '#0b0b0d' : '#ffffff');
  document.getElementById('themeBtn').innerHTML = THEME_ICONS[themePref];
}
function cycleTheme(){
  themePref = themePref === 'auto' ? 'light' : themePref === 'light' ? 'dark' : 'auto';
  try { localStorage.setItem('theme', themePref); } catch(e) {}
  applyTheme();
  toast('主題：' + (themePref==='auto'?'跟隨系統':themePref==='light'?'淺色':'深色'));
}
applyTheme();
document.getElementById('themeBtn').addEventListener('click', cycleTheme);
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
  theme_color: "#0062d9",
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
// Inject this worker's own origin so the on-device settings script only accepts save/query
// requests coming from this picker (CSRF guard; see location-settings.js).
app.get("/location-settings.js", (c) => {
  const src = new TextDecoder().decode(b64ToBytes(LOCATION_SETTINGS_B64));
  const origin = new URL(c.req.url).origin;
  const out = src.replace('/*__ILS_ALLOWED_ORIGIN__*/""', JSON.stringify(origin));
  return c.body(out, 200, JS_HEADERS);
});
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
// Full Shadowrocket .conf module (self-updating via update-url).
// Deliberately WITHOUT ca-p12/ca-passphrase: those are per-device private certs and must never
// be served publicly. Shadowrocket reuses/asks for the device's own CA on import.
function shadowconf(origin) {
  return String.raw`# Shadowrocket module (self-hosted): iOS Location Spoofer (Stateless)
[General]
update-url = ${origin}/ios-location-spoofer.conf

[Script]
# 1) 攔截 Apple /clls/wloc 回應，讀取本機 $persistentStore 的 latitude/longitude/altitude/enabled 等資料替換座標。
#    argument 不帶經緯度/enabled —— 全部交給裝置端持久化控制（未選點 → enabled 預設 false → 透傳真實定位）。
iOS Location Spoofer = type=http-response,pattern=^https?:\/\/(?:gs-loc(?:-cn)?\.apple\.com|bluedot\.is\.autonavi\.com(?:\.gds\.alibabadns\.com)?)\/clls\/wloc(?:\?.*)?$,requires-body=1,binary-body-mode=1,max-size=1048576,timeout=10,script-path=${origin}/location-spoofer.js,argument=mode=response&debug=false
# 2) 攔截選點頁的儲存請求，把座標寫進本機持久化（不送往 Apple、不經過任何伺服器）。
iLS Settings = type=http-request,pattern=^https?:\/\/gs-loc(?:-cn)?\.apple\.com\/ils-settings\/,requires-body=0,max-size=0,timeout=10,script-path=${origin}/location-settings.js

[MITM]
enable = true
hostname = %APPEND% gs-loc.apple.com, gs-loc-cn.apple.com, bluedot.is.autonavi.com, bluedot.is.autonavi.com.gds.alibabadns.com`;
}
const TXT = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" };
app.get("/ios-location-spoofer.conf", (c) => c.body(shadowconf(new URL(c.req.url).origin), 200, TXT));
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
  return c.text("Internal Server Error", 500);
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