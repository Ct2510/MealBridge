# API 摘要

以啟動後 `/docs` 的 OpenAPI 為完整型別契約。寫入一律 JSON 與 `X-Requested-With: portfolio`；瀏覽器帶 HttpOnly Cookie。未知欄位與格式錯誤回 422；未登入 401、無權限 403／404、資料衝突 409、節流 429。

| 方法 / 路徑 | 說明 |
|---|---|
| POST `/api/register` | username、password、nickname；建立帳號及工作階段 |
| POST `/api/login`、`/api/logout` | 登入／登出目前工作階段 |
| GET `/api/me` | 本人帳號 |
| GET `/api/catalog` | 公開的菜單及 version |
| PUT `/api/catalog` | 完整 Catalog；另需 `X-Catalog-Key`，未設定維護金鑰則停用 |
| GET / POST `/api/rooms` | 本人決策室／以 title 建立決策室 |
| POST `/api/rooms/join` | `{ "invite": "邀請碼" }`，已加入則不重複新增 |
| GET `/api/rooms/{id}` | 僅成員：進度、本人偏好、邀請碼及定案快照 |
| PUT `/api/rooms/{id}/preferences` | budget、vegetarian、no_beef、no_pork、no_spicy、max_walk、cuisines |
| GET `/api/rooms/{id}/recommendations` | eligible、rejected、room_version、catalog_version |
| POST `/api/rooms/{id}/freeze` | restaurant_id、room_version、catalog_version；限主辦人 |
| POST `/api/reports` | restaurant_id、note；建立待查核資料，不改寫菜單 |

價格與預算必須是整數，不接受字串或布林；來源 URL 限 HTTP/HTTPS（正式資料應使用 HTTPS）。菜單中的 diet 是 vegetarian／omnivore／unknown；vegetarian 在本系統指蛋奶素，非全素。

範例偏好：

```json
{"budget":140,"vegetarian":false,"no_beef":true,"no_pork":false,"no_spicy":true,"max_walk":15,"cuisines":["台式"]}
```

邀請碼不放伺服器查詢字串，而由網址 fragment 交給頁面，加入動作仍需使用者提交。快照匯出為前端下載，不會產生公開的私人資料網址。
