export function getPageHtml() {
  return `<!DOCTYPE html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>iOS Location Spoofer</title>
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="iOSLoc">
<meta name="theme-color" content="#ffffff">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icon-180.png">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<style>
:root {
  --bg:#f4f6fa; --card:#ffffff; --card2:#f0f3f8; --line:#e4e8ef; --inset:#f7f9fc;
  --brand:#2b7de9; --brand2:#1c62c4; --green:#10b981; --red:#ef4444; --orange:#f59e0b;
  --txt:#1e293b; --muted:#64748b; --mono:#0b8ce0;
  --blue:#2b7de9; --gray:#64748b; --cyan:#2b7de9; --cyan2:#1c62c4;
}
* { margin:0; padding:0; box-sizing:border-box; }
body {
  font-family:-apple-system,system-ui,"SF Pro","PingFang TC","Helvetica Neue","Microsoft JhengHei",sans-serif;
  color:var(--txt);
  background:var(--bg);
  -webkit-font-smoothing:antialiased;
}
::placeholder { color:#a3adbb; }
::-webkit-scrollbar { width:6px; height:6px; }
::-webkit-scrollbar-thumb { background:#cfd6e0; border-radius:3px; }

.map-wrap { position:relative; padding-top: env(safe-area-inset-top); }
#map { height:50vh; width:100%; min-height:250px; background:#e9edf3; border-bottom:1px solid var(--line); display:flex; align-items:center; justify-content:center; }
.leaflet-container { background:#e9edf3; }
.leaflet-control-zoom a { background:#fff!important; color:var(--txt)!important; border-color:var(--line)!important; }
.leaflet-control-zoom a:hover { background:var(--card2)!important; }
.leaflet-bar { border:1px solid var(--line)!important; box-shadow:0 4px 14px rgba(15,25,45,.10)!important; }
.leaflet-control-attribution { background:rgba(255,255,255,.85)!important; color:#8792a3!important; }
.leaflet-control-attribution a { color:var(--muted)!important; }

.panel { padding:16px; max-width:600px; margin:0 auto; padding-bottom:calc(16px + env(safe-area-inset-bottom)); }
.card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:16px; margin-bottom:12px; box-shadow:0 2px 10px rgba(15,25,45,.04); }
.card h3 { font-size:15px; font-weight:700; margin-bottom:12px; color:var(--txt); display:flex; align-items:center; gap:8px; }
.card h3::before { content:""; width:3px; height:15px; border-radius:2px; background:linear-gradient(180deg,var(--brand),#5ba0f0); flex:none; }

.coords { font-family:"SF Mono",ui-monospace,monospace; font-size:13.5px; color:var(--muted); padding:12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; word-break:break-all; line-height:1.6; margin-bottom:10px; }
.crow { display:flex; align-items:center; gap:8px; padding:8px 12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; margin-bottom:6px; }
.crow .ck { font-size:11px; font-weight:700; letter-spacing:.4px; color:var(--brand); width:42px; flex:none; }
.crow .cv { flex:1; min-width:0; font-family:"SF Mono",ui-monospace,monospace; font-size:14px; color:var(--mono); word-break:break-all; }
.copybtn { flex:none; }

.row { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
.btn { flex:1; min-width:100px; padding:12px 16px; border:none; border-radius:11px; font-size:14px; font-weight:700; cursor:pointer; transition:all .15s; font-family:inherit; }
.btn-primary { background:linear-gradient(135deg,var(--brand),var(--brand2)); color:#fff; box-shadow:0 6px 16px rgba(43,125,233,.25); }
.btn-primary:active { filter:brightness(1.08); transform:scale(.97); }
.btn-secondary { background:#fff; color:#425068; border:1px solid var(--line); font-weight:600; }
.btn-secondary:active { background:var(--card2); transform:scale(.97); }
.btn-danger { background:#fff; color:#d62f37; border:1px solid #f7c9cc; }
.btn-danger:active { background:#fff2f3; transform:scale(.97); }
.btn.success { background:linear-gradient(135deg,#2fbf71,#158a4d); color:#fff; border:none; box-shadow:0 6px 16px rgba(16,185,129,.28); }
.btn-sm { flex:none; min-width:auto; padding:6px 12px; font-size:12px; border-radius:8px; }

.input-row { display:flex; gap:8px; margin-top:10px; }
.input-row input { flex:1; padding:11px 12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; font-size:14px; color:var(--txt); outline:none; min-width:0; -webkit-appearance:none; font-family:inherit; transition:border-color .15s,box-shadow .15s; }
.cvi { flex:1; min-width:0; width:100%; font-family:"SF Mono",ui-monospace,monospace; font-size:14px; color:var(--mono); padding:7px 10px; background:var(--inset); border:1px solid var(--line); border-radius:8px; outline:none; -webkit-appearance:none; transition:border-color .15s,box-shadow .15s; }
.accfield input { width:100%; padding:9px 10px; background:var(--inset); border:1px solid var(--line); border-radius:8px; font-size:14px; color:var(--txt); outline:none; -webkit-appearance:none; font-family:inherit; transition:border-color .15s,box-shadow .15s; }
.input-row input:focus, .cvi:focus, .accfield input:focus, .modal input:focus { border-color:var(--brand); box-shadow:0 0 0 3px rgba(43,125,233,.13); }
.acc-row { display:flex; gap:8px; margin-bottom:6px; }
.accfield { flex:1; min-width:0; display:flex; flex-direction:column; gap:4px; }
.acclbl { font-size:11px; color:var(--muted); }

.status { font-size:12px; color:var(--muted); margin-top:8px; text-align:center; line-height:1.6; }
.hint { font-size:11px; color:#8792a3; margin-top:8px; line-height:1.7; }
.accnote { margin-top:10px; padding:12px 14px; background:#f5f9ff; border:1px solid #dbe8fb; border-left:3px solid var(--brand); border-radius:9px; font-size:11.5px; color:#4a5568; line-height:1.9; }
.accnote b { display:block; color:var(--brand); font-weight:800; font-size:12px; margin-bottom:6px; letter-spacing:.3px; }
.accnote code { font-family:"SF Mono",ui-monospace,monospace; color:var(--mono); font-size:11px; background:#e6f1fe; padding:1px 5px; border-radius:4px; }
.accnote em { color:var(--txt); font-style:normal; font-weight:800; }
.accnote .src { display:block; margin-top:8px; color:#9aa5b5; font-size:10.5px; }

.search-results { margin-top:8px; max-height:260px; overflow-y:auto; }
.search-item { padding:11px 12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; margin-bottom:6px; cursor:pointer; transition:all .15s; }
.search-item:active { background:#e9f2fe; border-color:var(--brand); }
.search-item .si-name { font-size:14px; color:var(--txt); font-weight:600; }
.search-item .si-sub { font-size:11px; color:var(--muted); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

.error-banner { background:#fff5f5; border:1px solid #f7c9cc; border-left:4px solid var(--red); color:#7a3b3e; padding:14px 16px; border-radius:12px; margin-bottom:12px; font-size:13.5px; line-height:1.7; display:none; }
.error-banner b { display:block; margin-bottom:4px; color:#d62f37; font-size:14.5px; }

.toast { position:fixed; top:60px; left:50%; transform:translateX(-50%); background:rgba(30,41,59,.94); -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px); color:#fff; padding:11px 20px; border-radius:22px; font-size:14px; opacity:0; transition:opacity .3s; pointer-events:none; z-index:9999; max-width:90vw; text-align:center; box-shadow:0 8px 26px rgba(15,25,45,.28); }
.toast.show { opacity:1; }

.active-loc { background:var(--inset); border:1px solid var(--line); border-radius:10px; padding:12px; font-size:13px; color:var(--txt); }
.active-loc .label { font-size:11px; color:var(--muted); margin-bottom:5px; }
.active-loc .value { font-family:"SF Mono",ui-monospace,monospace; font-size:13px; color:var(--mono); word-break:break-all; }

.fav-list { max-height:240px; overflow-y:auto; }
.fav-item { display:flex; align-items:center; gap:8px; padding:11px 12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; margin-bottom:6px; cursor:pointer; transition:all .15s; }
.fav-item:active { background:#e9f2fe; border-color:var(--brand); }
.fav-item .fav-info { flex:1; min-width:0; }
.fav-item .fav-name { font-size:14px; font-weight:600; color:var(--txt); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.fav-item .fav-coords { font-size:11px; color:var(--muted); font-family:"SF Mono",ui-monospace,monospace; margin-top:2px; }
.fav-item .fav-active { font-size:10px; color:var(--green); font-weight:700; margin-top:2px; }
.fav-item .fav-del { flex:none; width:28px; height:28px; border:none; border-radius:50%; background:transparent; color:var(--red); font-size:16px; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:background .15s; }
.fav-item .fav-del:hover { background:#ffe9ea; }
.fav-empty { text-align:center; color:var(--muted); font-size:13px; padding:16px 0; }
.fav-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
.fav-header h3 { margin-bottom:0; }

.modal-overlay { position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(15,25,45,.42); -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px); z-index:10000; display:none; align-items:center; justify-content:center; padding:20px; }
.modal-overlay.show { display:flex; }
.modal { background:#fff; border:1px solid var(--line); border-radius:18px; padding:22px; width:100%; max-width:340px; box-shadow:0 20px 60px rgba(15,25,45,.22); }
.modal h3 { font-size:17px; font-weight:700; margin-bottom:16px; text-align:center; color:var(--txt); }
.modal input { width:100%; padding:12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; font-size:15px; color:var(--txt); outline:none; margin-bottom:12px; -webkit-appearance:none; font-family:inherit; transition:border-color .15s,box-shadow .15s; }
.modal .modal-btns { display:flex; gap:8px; }
.modal .modal-btns .btn { padding:12px; }

.layer-switch { position:absolute; top:calc(10px + env(safe-area-inset-top)); right:10px; z-index:1000; display:flex; gap:4px; background:rgba(255,255,255,.92); -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px); border:1px solid var(--line); border-radius:10px; padding:4px; box-shadow:0 4px 14px rgba(15,25,45,.12); }
.layer-btn { border:none; background:transparent; padding:6px 10px; border-radius:7px; font-size:12px; font-weight:600; color:#5b6779; cursor:pointer; transition:all .15s; white-space:nowrap; font-family:inherit; }
.layer-btn.active { background:linear-gradient(135deg,var(--brand),var(--brand2)); color:#fff; font-weight:700; }
.layer-btn:active { transform:scale(.95); }
.lang-switch { position:absolute; top:calc(10px + env(safe-area-inset-top)); left:10px; z-index:1000; display:flex; gap:2px; background:rgba(255,255,255,.92); -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px); border:1px solid var(--line); border-radius:10px; padding:4px; box-shadow:0 4px 14px rgba(15,25,45,.12); }
.lang-btn { border:none; background:transparent; padding:6px 11px; border-radius:7px; font-size:12px; font-weight:700; color:#5b6779; cursor:pointer; transition:all .15s; font-family:inherit; }
.lang-btn.active { background:linear-gradient(135deg,var(--brand),var(--brand2)); color:#fff; }
.lang-btn:active { transform:scale(.95); }

@media(max-width:480px) { #map { height:44vh; } .panel { padding:12px; } .layer-btn { padding:5px 7px; font-size:11px; } }
</style>
</head>
<body>
<div class="map-wrap">
<div id="map"></div>
<div class="lang-switch">
  <button class="lang-btn" data-lang="zh" onclick="setLang('zh')">繁</button>
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
    <div id="coordGrid">
      <div class="crow"><span class="ck" data-i18n="lat">緯度</span><input class="cvi" id="cvLat" type="number" step="0.000001" placeholder="latitude" /><button class="btn btn-sm btn-secondary copybtn" data-i18n="copy" onclick="copyField('lat',this)">複製</button></div>
      <div class="crow"><span class="ck" data-i18n="lon">經度</span><input class="cvi" id="cvLon" type="number" step="0.000001" placeholder="longitude" /><button class="btn btn-sm btn-secondary copybtn" data-i18n="copy" onclick="copyField('lon',this)">複製</button></div>
      <div class="crow"><span class="ck" data-i18n="alt">海拔</span><input class="cvi" id="altInput" type="number" inputmode="decimal" step="1" /><button class="btn btn-sm btn-secondary copybtn" data-i18n="copy" onclick="copyField('alt',this)">複製</button></div>
      <div class="acc-row">
        <div class="accfield"><span class="acclbl" data-i18n="hacc">水平精確度</span><input id="haccInput" type="number" inputmode="numeric" step="1" min="1" value="39" /></div>
        <div class="accfield"><span class="acclbl" data-i18n="vacc">垂直精確度</span><input id="vaccInput" type="number" inputmode="numeric" step="1" min="1" value="1000" /></div>
        <div class="accfield"><span class="acclbl" data-i18n="jitter">擾動半徑</span><input id="jitterInput" type="number" inputmode="numeric" step="1" min="0" value="0" /></div>
      </div>
    </div>
    <div class="row">
      <button class="btn btn-primary" id="saveBtn" data-i18n="save" onclick="save()">儲存到裝置</button>
      <button class="btn btn-secondary" data-i18n="restore" onclick="restoreReal()">還原真實定位</button>
    </div>
    <div class="row">
      <button class="btn btn-secondary" data-i18n="copy_params" onclick="copyParams(this)">複製模組參數</button>
      <button class="btn btn-secondary" data-i18n="add_fav" onclick="addFav()">收藏位置</button>
      <button class="btn btn-secondary" data-i18n="locate" onclick="locateMe()">目前位置</button>
    </div>
    <div class="hint" data-i18n="alt_hint">海拔由 Open-Meteo 自動查詢（WGS-84），儲存到裝置時隨經緯度一併寫入，由 iOS Location Spoofer 模組生效。</div>
    <div class="accnote" data-i18n-html="acc_note_html"></div>
  </div>
  <div class="card">
    <div class="fav-header">
      <h3 data-i18n="fav_title">收藏的地點</h3>
      <button class="btn btn-sm btn-secondary" data-i18n="clear_all" onclick="clearAllFav()" id="clearAllBtn" style="display:none">清空全部</button>
    </div>
    <div id="favList" class="fav-list"></div>
  </div>
  <div class="card">
    <h3 data-i18n="active_title">目前生效座標</h3>
    <div class="active-loc" id="activeLoc">
      <div class="label" data-i18n="active_label">裝置本機座標（latitude／longitude／altitude）</div>
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
      <input id="urlInput" data-i18n-ph="paste_ph" placeholder="Apple／Google／高德／百度地圖連結或經緯度" />
      <button class="btn btn-secondary" style="flex:none;min-width:56px" data-i18n="parse" onclick="parseUrl()">解析</button>
    </div>
    <div style="font-size:11px;color:var(--gray);margin-top:6px" data-i18n="paste_hint">支援 Apple Maps · Google Maps · 高德 · 百度 · 座標文字（自動轉換為 WGS-84）</div>
  </div>
  <div class="card">
    <h3 data-i18n="search_title">搜尋地點</h3>
    <div class="input-row">
      <input id="searchInput" data-i18n-ph="search_ph" placeholder="搜尋地名，按 Enter 列出候選（僅預覽，不修改定位）" />
      <button class="btn btn-secondary" style="flex:none;min-width:56px" data-i18n="search" onclick="searchPlace()">搜尋</button>
    </div>
    <div id="searchResults" class="search-results"></div>
  </div>
  <div class="status" id="status">選好位置後點擊「儲存到裝置」寫入代理工具</div>
</div>
<div class="toast" id="toast"></div>
<div class="modal-overlay" id="favModal">
  <div class="modal">
    <h3 data-i18n="modal_title">收藏此地點</h3>
    <input id="favNameInput" data-i18n-ph="modal_ph" placeholder="輸入備註名稱（例如：公司、家）" maxlength="30" />
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

if (typeof L === 'undefined') {
  document.getElementById('map').innerHTML = '<div style="text-align:center; color:#d62f37; font-size:14px; padding:20px; font-weight:700;">⚠️ 地圖元件載入失敗<br><span style="font-size:12px;color:#64748b;font-weight:normal;">請檢查網路，或將 unpkg.com 加入代理規則。您仍可在下方手動輸入座標。</span></div>';
}

const I18N = {
  zh: {
    title: 'iOS Location Spoofer',
    layer_satellite: '衛星', layer_amap: '高德', layer_color: '彩色', layer_standard: '標準', layer_dark: '暗色',
    err_html: '<b>模組未生效</b>請檢查以下設定：<br>1. 已安裝並啟用 iOS Location Spoofer 模組<br>2. MITM 已開啟且信任憑證<br>3. MITM 主機名稱包含 gs-loc.apple.com<br>4. 目前網路已走代理',
    choose_title: '選擇目標位置',
    coords_hint: '點擊地圖或使用下方工具選擇位置',
    save: '儲存到裝置', add_fav: '收藏位置', locate: '目前位置',
    copy: '複製', copy_params: '複製模組參數',
    lat: '緯度', lon: '經度', alt: '海拔',
    alt_querying: '海拔查詢中…', alt_na: '海拔無法取得',
    alt_hint: '海拔由 Open-Meteo 自動查詢（WGS-84），儲存到裝置時隨經緯度一併寫入，由 iOS Location Spoofer 模組生效。',
    acc_note_html: '<b>精確度參數怎麼填</b>' +
      '<code>horizontalAccuracy</code> 水平精確度（公尺），預設 <em>39</em>，越小越「精準」—— 想更像 GPS 可設 <em>5~15</em>；保持 <em>39</em> 也正常。<br>' +
      '<code>verticalAccuracy</code> 垂直精確度（公尺），預設 <em>1000</em> —— 本頁已自動填入目標點真實海拔，可調小到 <em>10~30</em>，讓海拔顯得更有說服力。<br>' +
      '<code>擾動半徑</code>（公尺），預設 <em>0</em>（關閉）—— 設為 <em>N</em> 後，每次定位會在目標點周圍 <em>N</em> 公尺內隨機偏移，避免每次結果一模一樣。想固定在精確座標就留 <em>0</em>。' +
      '<span class="src">參數建議來自上游專案 mekos2772 / ios-location-spoofer</span>',
    fav_title: '收藏的地點', clear_all: '清空全部',
    active_title: '目前生效座標', active_label: '裝置本機座標（latitude／longitude／altitude）',
    refresh: '重新整理', clear_data: '清除資料',
    paste_title: '貼上地圖連結', paste_ph: 'Apple／Google／高德／百度地圖連結 或 經緯度', parse: '解析',
    paste_hint: '支援 Apple Maps · Google Maps · 高德 · 百度 · 座標文字（自動轉換為 WGS-84）',
    search_title: '搜尋地點', search_ph: '搜尋地名，按 Enter 列出候選（僅預覽，不修改定位）', search: '搜尋',
    status_hint: '選好位置後點擊「儲存到裝置」寫入代理工具',
    modal_title: '收藏此地點', modal_ph: '輸入備註名稱（例如：公司、家）', cancel: '取消', save_short: '儲存',
    acc: '精確度', restore: '還原真實定位', restored: '✓ 虛擬定位已清除，定位服務開關關閉後，關掉代理開關，等待至少 10 秒鐘，再次開啟才會生效', hacc: '水平精確度', vacc: '垂直精確度', jitter: '擾動半徑（公尺）',
    querying: '查詢中...', no_saved: '沒有已儲存的座標', query_failed: '查詢失敗（需要代理模組支援）', cleared: '已清除',
    fav_empty: '尚無收藏，選好位置後點擊「收藏位置」',
    active_now: '✓ 目前生效', del: '刪除',
    pick_first: '請先在地圖上選擇一個位置',
    enter_label: '請輸入備註名稱',
    added: function(n){ return '已收藏：' + n; },
    deleted: function(n){ return '已刪除：' + n; },
    clear_fav_confirm: '確定要清空所有收藏嗎？', all_cleared: '已清空所有收藏',
    clear_confirm: '確定要清除裝置上已儲存的座標嗎？清除後將使用模組預設參數或停止修改定位。',
    dev_cleared: '已清除裝置座標',
    clear_failed: function(e){ return '清除失敗：' + e; },
    clear_failed_cfg: '清除失敗 - 請檢查模組設定',
    saving: '儲存中...', saved: '✓ 已儲存',
    written: function(lo, la, ts){ return '✓ 已寫入：' + lo.toFixed(6) + ', ' + la.toFixed(6) + ' · ' + ts; },
    saved_toast: '✓ 座標已成功寫入模組，定位服務開關關閉後，等待至少 10 秒鐘，再次開啟才會生效',
    save_failed: '✗ 儲存失敗 - 請檢查模組設定', write_failed: '寫入失敗',
    no_geo: '瀏覽器不支援定位', getting_loc: '取得位置中...', got_loc: '已取得目前位置',
    loc_failed: function(m){ return '定位失敗：' + m; },
    paste_first: '請貼上地圖連結或座標', parse_failed: '無法解析座標，請檢查連結格式', parsing: '解析中...',
    parsed: function(lo, la){ return '已解析：' + lo.toFixed(4) + ', ' + la.toFixed(4); },
    enter_place: '請輸入地名', searching: '搜尋中...',
    not_found: function(q){ return '未找到：' + q; }, search_failed: '搜尋失敗',
    copied: function(x){ return '已複製：' + x; }, copy_failed: '複製失敗，請手動選取',
    alt_unknown_copy: '海拔尚未取得，僅複製經緯度'
  },
  en: {
    title: 'iOS Location Spoofer',
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

let map = null;
if (typeof L !== 'undefined') {
  map = L.map('map').setView([20, 0], 2);
  const tiles = {
    satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {maxZoom:19, attribution:'ArcGIS'}),
    wgs84: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {maxZoom:19, attribution:'ArcGIS WGS84'}),
    standard: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'© OSM'}),
    dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {maxZoom:19, attribution:'© Carto'}),
    amap: L.tileLayer('https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}', {maxZoom:18, subdomains:'1234', attribution:'© Amap'}),
    voyager: L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {maxZoom:19, attribution:'© Carto'})
  };
  let currentLayer = tiles.satellite;
  currentLayer.addTo(map);
  window.switchLayer = function(name) {
    map.removeLayer(currentLayer);
    currentLayer = tiles[name];
    currentLayer.addTo(map);
    document.querySelectorAll('.layer-btn').forEach(b => b.classList.toggle('active', b.dataset.layer === name));
  };
  let marker = L.marker([lat, lon], {draggable:true});
  let markerShown = false;
  window.showMarker = function() { if (!markerShown) { marker.addTo(map); markerShown = true; } };
  marker.on('dragend', e => { const p=e.target.getLatLng(); setPos(p.lat, p.lng); });
  map.on('click', e => { setPos(e.latlng.lat, e.latlng.lng); });
}

document.getElementById('cvLat').addEventListener('input', function(e) { lat = parseFloat(e.target.value) || 0; });
document.getElementById('cvLon').addEventListener('input', function(e) { lon = parseFloat(e.target.value) || 0; });

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
  const coords = document.getElementById('coords');
  if (!selected) {
    coords.style.display = '';
    coords.textContent = t('coords_hint');
  } else {
    coords.style.display = 'none';
  }
  document.getElementById('cvLat').value = lat ? lat.toFixed(6) : '';
  document.getElementById('cvLon').value = lon ? lon.toFixed(6) : '';
}

function updateStatus() {
  document.getElementById('status').textContent = (savedLon !== null)
    ? t('written', savedLon, savedLat, savedTimeStr)
    : t('status_hint');
}

function setPos(newLat, newLon, knownAlt) {
  lat = newLat; lon = newLon; selected = true;
  if (map) window.showMarker();
  if (map && marker) marker.setLatLng([lat, lon]);
  if (typeof knownAlt === 'number') { elev = Math.round(knownAlt); elevState = 'ok'; elevCache.set(elevKey(lat, lon), elev); }
  updateCoords();
  fetchElevation(lat, lon);
}

function moveTo(newLat, newLon, zoom, knownAlt) {
  setPos(newLat, newLon, knownAlt);
  if (map) map.setView([lat, lon], zoom || 15);
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
    fetch(ELEV_API + '?latitude=' + la + '&longitude=' + lo, { cache:'no-store' })
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
  let val;
  if (which === 'lat') val = lat ? lat.toFixed(6) : '';
  else if (which === 'lon') val = lon ? lon.toFixed(6) : '';
  else { const a = currentAlt(); if (a === null) { toast(t('alt_na')); return; } val = String(a); }
  if (!val) { toast(t('pick_first')); return; }
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
  if (!lat || !lon) { toast(t('pick_first')); return; }
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
      '<button class="fav-del" onclick="event.stopPropagation();delFav(' + i + ')" title="' + escHtml(t('del')) + '">\\u00d7<\\/button>' +
    '<\\/div>';
  }).join('');
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function addFav() {
  if (!lat || !lon) { toast(t('pick_first')); return; }
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
  fetch(SAVE_API + '?action=query', { method:'GET', mode:'cors', cache:'no-store' })
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
  fetch(SAVE_API + '?action=clear', { method:'GET', mode:'cors', cache:'no-store' })
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

async function save() {
  if (!lat || !lon) { toast(t('pick_first')); return; }
  const btn = document.getElementById('saveBtn');
  btn.textContent = t('saving'); btn.disabled = true;
  showError(false);
  try {
    let url = SAVE_API + '?lon=' + lon + '&lat=' + lat;
    const a = currentAlt(); if (a !== null) url += '&alt=' + a;
    url += '&hacc=' + haccVal() + '&vacc=' + vaccVal() + '&randomRadius=' + jitterVal();
    const r = await fetch(url, { method: 'GET', mode: 'cors', cache: 'no-store' });
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
      setTimeout(() => { btn.textContent = t('save'); btn.className='btn btn-primary'; btn.disabled=false; }, 2500);
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
    const r = await fetch(PARSE_API + '?format=json&u=' + encodeURIComponent(input), { cache:'no-store' });
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
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=6&q='+encodeURIComponent(q), { headers: { 'Accept-Language': (lang === 'zh' ? 'zh-TW' : 'en') } });
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
  fetch(SAVE_API + '?action=clear', { method:'GET', mode:'cors', cache:'no-store' })
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
