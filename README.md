# iOS Location Spoofer

自建了 worker 網頁，選點頁也在裡面：https://cyberhandyman-ioslocspo.cyberhandyman.workers.dev

影片教學：https://youtu.be/EspuRlKWUxc

> 📺 YouTube：**[CyberHandyman 賽博工具人](https://www.youtube.com/@CyberHandyman/videos)** ｜ ✈️ Telegram 討論群：**[@cyberhandymancngroup](https://t.me/cyberhandymancngroup)**

> ✅ **已同步上游 [Yu9191/wloc v1.1](https://github.com/Yu9191/wloc/releases)**：隨機擾動半徑（每次定位在目標點周圍隨機偏移，避免結果完全相同）· 港澳台座標（蘋果/Google 在港澳台直發 WGS-84，不再誤做 GCJ 反算）· 百度連結解析 · 高德 `position=` 經緯順序修正。擾動半徑在選點頁設定。

---

## ⚠️ 免費開源專案 · 禁止販售

**如果你是透過付款來到本頁面，請立即聯絡退款。**
任何販售本專案 / 模組的都是騙子。一經發現立即刪庫，血本無歸。

---

## 🚀 一鍵部署你自己的選點頁

不想用我的網址、或者想自己掌控？點下面的按鈕，登入 Cloudflare 後一路下一步，
**30 秒**就能部署一份**屬於你自己的**選點頁（Cloudflare 免費額度完全夠用）：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cyberhandyman/ios-location-spoofer/tree/main/stateless-picker/worker)

部署完你會拿到一個自己的網址（形如 `https://xxx.你的帳號.workers.dev`）。
它自帶全部模組檔案，首頁裡的「一鍵匯入」按鈕會**自動指向你自己的網域**，不用改任何程式碼。

> **無狀態說明**：座標只存在**各自裝置**上，伺服器端不存任何資料（沒有綁定 KV / D1 等任何儲存）。
> 所以同一個網址可以被無數人同時使用、互不覆蓋，你部署的這份也一樣。

---

## 📖 使用教學

| | |
|---|---|
| 🇨🇳 小白保姆級圖文教學 | [使用教學.md](使用教程.md) |
| 🇬🇧 English guide | [使用教學.en.md](使用教程.en.md) ｜ [README.en.md](README.en.md) |
| 📲 iOS 捷徑（分享地圖連結直接改定位） | [見使用教學末尾](使用教程.md#-ios-快捷指令分享地图链接直接改定位) |

**生效前提**：① 代理 App 已連線（開關/引擎開啟、非「直連」模式）② 開啟 HTTPS 解密(MITM) 並信任憑證 ③ 裝好對應客戶端的模組。

> **macOS 也能用**：Shadowrocket 需開啟「強制路由」、Surge 需開啟「增強模式」，讓代理真正全量接管流量後，同一個模組即可生效。

---

## 📦 模組安裝位址

推薦直接在[選點頁首頁](https://cyberhandyman-ioslocspo.cyberhandyman.workers.dev)點「一鍵匯入」。手動新增用下面的位址：

| 客戶端 | 模組位址 |
|---|---|
| Shadowrocket / Surge / Egern | `https://raw.githubusercontent.com/cyberhandyman/ios-location-spoofer/main/ios-location-spoofer.sgmodule` |
| Loon | `https://raw.githubusercontent.com/cyberhandyman/ios-location-spoofer/main/ios-location-spoofer.lnplugin` |
| Stash | `https://raw.githubusercontent.com/cyberhandyman/ios-location-spoofer/main/ios-location-spoofer.stoverride` |
| Quantumult X | `https://raw.githubusercontent.com/cyberhandyman/ios-location-spoofer/main/ios-location-spoofer.snippet` |

**MITM 主機名稱**（若全部設定成功仍不生效，手動加入這四個網域）：

```
gs-loc.apple.com
gs-loc-cn.apple.com
bluedot.is.autonavi.com
bluedot.is.autonavi.com.gds.alibabadns.com
```

---

## 🔍 原理

iPhone 靠周圍 Wi-Fi、基地台的 BSSID 去問 Apple「這些裝置在哪」，Apple 回一份座標清單，iOS 據此算出自己的位置。

本模組在 **Apple 回座標的半路上**（`gs-loc.apple.com/clls/wloc`）把回應裡的座標全部改成你指定的數字，iPhone 算出來就是你選的地方。選點頁則透過 `ils-settings` 請求把座標寫進**你手機本機**的持久化儲存，模組讀取後生效——**全程不經過任何伺服器**。

---

## 🙏 fork from 鳴謝貢獻者

[Yu9191/wloc](https://github.com/Yu9191/wloc) · [mekos2772/ios-location-spoofer](https://github.com/mekos2772/ios-location-spoofer) · [acheong08/ios-location-spoofer](https://github.com/acheong08/ios-location-spoofer)

---

## 📄 免責聲明

1. 本專案為免費開源工具，**僅供個人學習、研究與技術測試之用**，請勿用於任何違反所在國家/地區法律法規的用途。
2. 使用本專案（含模組、腳本、選點頁）所引發的**一切風險與後果由使用者自行承擔**，與開源專案原作者、貢獻者及本倉庫維護者無關。
3. 本專案與 **Apple Inc.** 無任何關聯，不隸屬、不代表 Apple，亦未獲其授權或認可。
4. 本專案**不在中國大陸提供服務**。
5. 下載、安裝或使用本專案，即視為你已閱讀並同意本聲明；如不同意，請立即停止使用。

授權條款：**GNU AGPL-3.0**（繼承自上游專案） 
