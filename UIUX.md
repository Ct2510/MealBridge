# MealBridge v1.1：設計依據與驗收

研究與修改日期：2026-10-17。這是 AI 協作原創實作，不以「看起來不像 AI」冒充人工設計履歷。目標是讓畫面跟隨餐點決策任務，不再與運動 App 共用通用卡片樣板。

## 實際研究了什麼

| 來源 | 實際查看範圍 | 採用的設計原則，而非照抄 |
|---|---|---|
| [Beli 官方網站](https://beliapp.com/) | 公開首頁、餐廳清單／地圖與朋友動態展示，未使用付費或私人帳號功能 | 餐廳資料保持主角；清單與位置互相對照，不以巨大介紹區搶走搜尋入口 |
| [Airbnb 搜尋篩選說明](https://www.airbnb.com/help/article/479) | 官方說明的搜尋／篩選概念，不宣稱實測完整產品 | 地點與範圍先於結果，讓當前條件可見並可改回 |
| [AdventureLog](https://github.com/seanmorley15/AdventureLog) | README、LICENSE 與 [公開地圖截圖](https://github.com/seanmorley15/AdventureLog/blob/main/brand/screenshots/map.png) | 地圖／列表的資訊分工、篩選與來源的層次；未取用其程式、畫面或素材 |

AdventureLog LICENSE 為 GPL-3.0；本案沒有移植或衍生其原始碼，不把觀看截圖說成可任意取用資產。原有功能競品研究仍見 [PRODUCT.md](PRODUCT.md)。

## 我們自己的視覺與流程

- 米白紙色、陶土色重點、細分隔線與有編號的餐廳列；品牌標題與內文有字體層級，但不用遠端字型／素材。
- 桌機：搜尋列 → 來源與料理篩選 → 左餐廳列表／右距離示意；手機以單欄重排。距離示意明確標示不是街道圖，街道 iframe 要另外同意。
- 「附近探索」處理我在哪裡、附近有什麼；「一起選餐」處理共同集合點、個人限制、可行餐點、定案；「菜單與來源」處理可信度與回報。
- 決策室用 01 集合點／02 條件／03 比較／04 定案的進度，不把登入、回報、預算與定案全部塞在首頁。
- 價格、資料日期、來源、未知菜單優先於分數；分數收進說明，不把自訂分數包裝成真實滿意度。
- 空結果、上游失敗、定位拒絕／逾時、誤差大於搜尋半徑，都有不同提示，不自動擴大半徑或假造附近店家。

## 值得加入、而非只堆功能

| 已做 | 解決的問題 |
|---|---|
| 使用者主動定位＋手選點＋半徑 | 不知道附近選項；不願分享位置者仍可使用 |
| 示範／OSM 真實資料分開＋來源署名 | 避免把假資料、缺菜單的店家當可靠推薦 |
| 共享集合點＋每人最遠距離 | 同一間店對某人太遠，不能只看平均喜好 |
| 邀請碼更新 | 連結誤傳後可以停止新成員加入，不假裝踢除已加入者 |
| 雙版本定案＋下載快照 | 比較之後改菜單／條件，不該悄悄用舊結果定案 |
| 登出清空＋過時請求隔離 | 網路失敗／回應順序不同，不讓前一位使用者資料留在畫面 |

暫不加入：AI 自動飲食保證、GPS 背景追蹤、照片推算過敏原、訂位／支付、虛構評價。它們增加資料責任，不會自動改善這個小群體決策任務。

## 定位與公開資料依據

- [MDN getCurrentPosition](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation/getCurrentPosition)：安全環境、權限、誤差與錯誤；瀏覽器定位不保證使用衛星 GPS。
- [Overpass QL](https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL)：附近節點與 way／relation center；沒有可靠菜單欄位就不補造。
- [公共 Overpass 實例](https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances)：公共服務容量有限，本版設定全站／來源配額，不提供 SLA。
- [OSM copyright](https://www.openstreetmap.org/copyright)、[圖磚政策](https://operations.osmfoundation.org/policies/tiles/)：結果與圖面保留署名，不下載或快取離線圖磚；使用官方 embed，不鏡像底圖。

## 驗收的證據與缺口

已自動驗證：GPS API 成功／三種錯誤、座標有效性與約略化、Haversine 邊界、半徑提交、沒有同意就不呼叫 OSM／不載入 iframe、來源署名、私人資料不快取、登出與過時身份回應、舊資料庫升級、共同點版本衝突。

`test_ui.mjs` 使用 LinkeDOM 與模擬 API，不執行 CSS 排版、原生權限視窗或真實網路請求。`screenshot.jpg` 是 v1.0 歷史截圖，不當作 v1.1 成果。

尚待人工：在可連線的本機預覽上以桌機、390px 手機、鍵盤與螢幕閱讀器走完定位→篩選→邀請→比較→定案；檢查橫向溢位、焦點、對比、觸控與可讀性。尚未宣稱 WCAG 通過。

2026-10-17 實際公開 Overpass 查詢遇到 502，測試另一公開實例亦失敗。故只能宣稱 provider 已實作、模擬解析／錯誤流程通過，不能宣稱即時附近店家成功上線；實機 GPS 同樣尚未驗收。
