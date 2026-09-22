export function getLandingHtml() {
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
  --brand:#2b7de9; --brand2:#1c62c4; --green:#10b981; --green2:#059669;
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

/* --- header / branding --- */
header{ text-align:center; padding:8px 0 6px; }
header .logowrap{ position:relative; width:74px; margin:0 auto 14px; }
header .logo{ width:74px; height:74px; border-radius:20px; display:block; box-shadow:0 0 0 1px var(--line),0 10px 30px rgba(43,125,233,.15); }
h1{ font-size:23px; font-weight:800; letter-spacing:.3px; color:var(--txt); }
.credit{ font-size:12px; color:var(--muted); margin-top:12px; line-height:1.7; }
.credit a{ color:var(--brand); text-decoration:none; font-weight:600; }
.synced{ font-size:12px; color:var(--green); font-weight:700; margin-top:8px; }
.synced a{ color:var(--green); text-decoration:underline; }

/* --- primary CTA --- */
.ctas{ display:flex; justify-content:center; margin:18px 0 4px; }
.enter{ flex:1; display:flex; align-items:center; justify-content:center; gap:8px; padding:17px 14px; border:none; border-radius:14px; font-size:16px; font-weight:800; cursor:pointer; text-decoration:none; transition:transform .12s,box-shadow .12s; font-family:inherit; }
.enter:active{ transform:scale(.97); }
.enter.go{ background:linear-gradient(135deg,var(--brand),var(--brand2)); color:#fff; box-shadow:0 10px 26px rgba(43,125,233,.25); }

.divider{ height:1px; background:linear-gradient(90deg,transparent,var(--line),transparent); margin:24px 0 20px; }

/* --- section heads with accent bar --- */
h2{ font-size:16px; font-weight:800; margin-bottom:4px; display:flex; align-items:center; gap:9px; }
h2::before{ content:""; width:4px; height:16px; border-radius:2px; background:linear-gradient(180deg,var(--brand),#5ba0f0); }
.sub{ font-size:12.5px; color:var(--muted); margin:0 0 14px 13px; }
.note{ background:#f5f9ff; border:1px solid #dbe8fb; border-left:4px solid var(--brand); border-radius:11px; padding:12px 14px; font-size:12.5px; color:#4a5568; margin-bottom:16px; }
.note b{ color:var(--txt); }

/* --- platform cards --- */
.plat{ background:var(--card); border:1px solid var(--line); border-radius:14px; padding:12px; margin-bottom:12px; box-shadow:0 2px 10px rgba(15,25,45,.04); }
.plat .big{ display:flex; align-items:center; justify-content:center; gap:8px; width:100%; padding:14px; border:none; border-radius:11px; background:linear-gradient(135deg,var(--brand),var(--brand2)); color:#fff; font-size:15.5px; font-weight:800; cursor:pointer; text-align:center; text-decoration:none; transition:filter .12s,transform .12s; }
.plat .big:active{ filter:brightness(1.1); transform:scale(.98); }
.plat .line{ display:flex; align-items:center; gap:8px; margin-top:9px; }
.plat .url{ flex:1; min-width:0; font-family:"SF Mono",ui-monospace,monospace; font-size:11px; color:var(--muted); background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:8px 10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.plat .copy{ flex:none; padding:8px 15px; border:1px solid var(--line); border-radius:8px; background:var(--card2); color:var(--txt); font-size:12.5px; font-weight:600; cursor:pointer; transition:all .12s; font-family:inherit; }
.plat .copy:active{ background:#e4e8ef; }
.plat .copy.ok{ background:var(--green); border-color:var(--green); color:#fff; }
.plat .pnote{ font-size:11.5px; color:var(--muted); margin-top:7px; line-height:1.6; }

/* --- info boxes --- */
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
      <a href="https://港澳github.com/mekos2772/ios-location-spoofer" target="_blank" rel="noopener">mekos2772</a> ·
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
