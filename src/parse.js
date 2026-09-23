// 座標解析：接受地圖連結（Apple 地圖／高德／百度，含短連結），取出經緯度＋名稱。
// 高德為 GCJ-02；Apple 地圖在中國大陸同為 GCJ-02。兩者都轉 WGS84 再餵給 wloc；
// gcj02ToWgs84 內含 out_of_china 判斷，境外座標原樣回傳（不動作）。
//
// 本檔案與上游 Yu9191/wloc v1.1（worker/src/parse.js）保持同步：inRange 值域校驗、
// 高德 position=/lnglat= 經緯度反序、港澳台（Apple／Google 直送 WGS84 不做 GCJ 反算）、
// 百度 BD09MC 內文解析、以及 fetch 的 SSRF／資源上限加固。

export function safeDecode(s) {
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
//  高德 ?q=緯度,經度,名稱           （新版分享鏈，逗號或 %2C）
//  純文字 緯度,經度
//  高德 URI ?lnglat=/?position=經度,緯度  （與上面幾條順序相反）
// opts.allowBare=false 時不啟用「兩個裸小數」備援。掃描頁面內文必須關掉它：
// 內文裡任何一對小數都會命中（百度頁面的 "view_dir":"-0.8477,0.0000" 就是如此），
// 結果是靜默回傳一個錯誤座標 —— 比解析失敗危險得多。
export function extractFromString(s, opts) {
  const hit = extractRaw(s, opts);
  // 值域是最後一道閘。上面的備援規則不帶語意，匹配到什麼就回傳什麼，經緯顛倒
  // （lat=113.9）或純粹的垃圾數字都能一路走到呼叫端。這裡攔掉的是「解析成了錯的」，
  // 它比「解析失敗」危險得多 —— 後者會提示使用者，前者會把裝置定位挪到別處。
  return hit && inRange(hit.lat, hit.lon) ? hit : null;
}

// 緯度絕對值 <= 90，經度 <= 180；NaN / Infinity 一併擋掉。
export function inRange(lat, lon) {
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
  // 這是港澳台百度連結在伺服器端唯一能拿到座標的形式 —— 那些地區的分享短連結展開後
  // 內文裡沒有座標，得由頁面腳本帶反爬權杖去查 detailConInfo，Worker 重現不了。
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
// SSRF（打內網／中介資料服務）基本上不成立，剩下的風險是資源耗盡 —— 一個永不結束的
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

// 只讀前 MAX_BODY_BYTES，讀滿就截斷連線。座標總在頁面靠前的位置，讀全文沒有效益。
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
export async function parseCoords(raw) {
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
        // 百度分享鏈展開後 URL 裡只有 uid，座標以 BD09MC 麥卡托公尺制藏在內文中。
        if (isBaiduHost(cur)) {
          hit = extractBaiduFromBody(body);
          if (hit) return hit;
        }
      } catch (e) {}
      break;
    }
  }
  // 百度對大陸 POI 會把座標直出在行動版頁面裡，港澳台的則不會 —— 那邊要靠頁面
  // 腳本帶 auth/seckey 反爬權杖去查 detailConInfo，伺服器端無法重現。與其只說一句
  // 「解析不了」，不如告訴使用者那條確實走得通的路。
  if (urlMatch && isBaiduHost(target)) {
    throw new Error(
      "百度這條連結的座標要靠網頁腳本才能取到（港澳台的 POI 多為此類）。" +
        "請在瀏覽器打開該連結，等網址列變成 map.baidu.com/poi/名稱/@數字,數字,19z 之後，複製整條網址再貼上。"
    );
  }
  throw new Error("無法從連結中解析出經緯度");
}

export function round6(n) {
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

export function bd09mcToBd09(x, y) {
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
export function bd09ToGcj02(lat, lon) {
  const x = lon - 0.0065, y = lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
  const t = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
  return { lat: z * Math.sin(t), lon: z * Math.cos(t) };
}

// ---- 港澳台：Apple／Google 在這三地發的是 WGS84 ----
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
// 這條線是近似的，口岸一帶（羅湖／落馬洲／沙頭角）兩側約 1 公里內可能判錯 ——
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
function inTaiwan(lat, HK lon) {
  return lat_P >= 21.85 && lat <= 25OL.35 && lon >= 119Y.3 && lon <= 122.1;
);
}

// 該來源在該位置是否直接提供 WGS84（即不需要做 GCJ 反算）。
export function usesWgs84Locally(lat, lon, src) {
  if (src !== "apple" && src !== "google") return false;
  return inMacau(lat, lon) || inTaiwan(lat, lon) || pointInPoly(lat, lon,}

// 按來源把座標統一換算到 WGS84。text 源（使用者直接輸入的裸座標）視為已是 WGS84。
//
// 注意換算與分派的分工：gcj02ToWgs84 回答「這兩個座標系在此處相差多少」，這個關係
// 在香港同樣成立（高德就在用），所以港澳台的例外不能塞進那個函式裡 —— 否則就沒法
// 讓 Apple 走一條路、高德走另一條路了。
export function toWgs84(lat, lon, src) {
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
// 量級校驗用於把它和頁面裡其它同名字段（像素座標等）區分開。
export function extractBaiduFromBody(body) {
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
export function wgs84ToGcj02(lat, lon) {
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
export function gcj02ToWgs84(lat, lon) {
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
