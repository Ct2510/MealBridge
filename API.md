# API 摘要

以啟動後 `/docs` 的 OpenAPI 為完整型別契約。寫入一律 JSON 與 `X-Requested-With: portfolio`；瀏覽器帶 HttpOnly Cookie。未知欄位與格式錯誤回 422；未登入 401、無權限 403／404、資料衝突 409、節流 429。

| 方法 / 路徑 | 說明 |
|---|---|
| POST `/api/register` | username、password、nickname；建立帳號及工作階段 |
| POST `/api/login`、`/api/logout` | 登入／登出目前工作階段 |
| GET `/api/me` | 本人帳號 |
| GET `/api/catalog` | 公開的菜單及 version |
| PUT `/api/catalog` | 完整 Catalog；另需 `X-Catalog-Key`，未設定維護金鑰則停用 |
| GET / POST `/api/rooms` | 本人決策室／以 title、選填 area 建立；有 area 表示明確同意分享 |
| POST `/api/rooms/join` | `{ "invite": "邀請碼" }`，已加入則不重複新增 |
| GET `/api/rooms/{id}` | 僅成員：進度、本人偏好、邀請碼及定案快照 |
| PUT `/api/rooms/{id}/preferences` | budget、vegetarian、no_beef、no_pork、no_spicy、max_distance_m、cuisines；max_walk 僅供舊版相容 |
| GET `/api/rooms/{id}/recommendations` | eligible、rejected、room_version、catalog_version |
| POST `/api/rooms/{id}/freeze` | restaurant_id、room_version、catalog_version；限主辦人 |
| POST `/api/reports` | restaurant_id、note；建立待查核資料，不改寫菜單 |

價格與預算必須是整數，不接受字串或布林；來源 URL 限 HTTP/HTTPS（正式資料應使用 HTTPS）。菜單中的 diet 是 vegetarian／omnivore／unknown；vegetarian 在本系統指蛋奶素，非全素。

範例偏好：

```json
{"budget":140,"vegetarian":false,"no_beef":true,"no_pork":false,"no_spicy":true,"max_walk":15,"cuisines":["台式"]}
```

邀請碼不放伺服器查詢字串，而由網址 fragment 交給頁面，加入動作仍需使用者提交。快照匯出為前端下載，不會產生公開的私人資料網址。

## v1.1 定位與共同點

| 方法 / 路徑 | 規則 |
|---|---|
| POST `/api/nearby/catalog` | 公開，SearchArea；既有菜單依實際座標／半徑篩選，缺座標不納入 |
| POST `/api/nearby/openstreetmap` | 公開，SearchArea + `external_consent: true`（必須 JSON boolean）；上游失敗 503，超過配額 429，不回虛構替代 |
| PUT `/api/rooms/{id}/area` | SearchArea；僅主辦、未定案；遞增 room_version，使舊比較無效 |
| POST `/api/rooms/{id}/rotate-invite` | 僅主辦；舊碼失效但保留既有成員，遞增 room_version |

SearchArea：

```json
{"latitude":25.033,"longitude":121.5654,"radius_m":1000,"label":"公共集合點"}
```

緯經度是有限數字，拒絕字串／布林；範圍分別 −90～90、−180～180。radius_m 為整數 100～5000；label 1～70 字。位置必須放 POST body，不使用查詢字串。附近回傳 `restaurants`、`source`、`distance_kind: straight_line`；OSM 菜單是空陣列、價格 null，未經查核不產生飲食保證。

共同點在 room.area 及定案 snapshot.area 中；nearby 查詢本身不寫入位置。每人 max_distance_m 預設 3000；共同半徑與所有人的距離限制都必須通過。有 area 時不使用舊 walk_minutes 作距離；舊 API 未設 area 時保留 v1.0 行為供相容，但新版 UI 會要求先設共同點。
