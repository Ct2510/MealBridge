const main = document.querySelector("main");
const dialog = document.querySelector("dialog");
const message = document.querySelector("#message");
let messageTimer;
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[character]));
}
function toast(value) {
  message.textContent = value;
  message.classList.add("visible");
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => message.classList.remove("visible"), 6500);
}
async function api(path, method = "GET", body) {
  if (!navigator.onLine) throw new Error("目前離線：只能查看介面，操作尚未送出，請連線後重試。");
  let response;
  try {
    response = await fetch("/api" + path, {method, headers: {"Content-Type":"application/json","X-Requested-With":"portfolio"},
      body: body === undefined ? undefined : JSON.stringify(body), cache:"no-store"});
  } catch {
    throw new Error("無法連上伺服器，操作未確認；請重新整理確認狀態後再試。");
  }
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "資料格式不正確，請檢查所有欄位。");
  return result;
}
function renderIdentity(user) {
  document.querySelector("#identity").textContent = user ? user.nickname : "訪客";
  document.querySelector("#auth").classList.toggle("hidden", Boolean(user));
  document.querySelector("#logout").classList.toggle("hidden", !user);
}
document.querySelector("#auth").addEventListener("click", () => dialog.showModal());
document.querySelector("#close-auth").addEventListener("click", () => dialog.close());
function offlineState() {
  document.querySelector("#offline").classList.toggle("hidden", navigator.onLine);
}
addEventListener("online", offlineState);
addEventListener("offline", offlineState);
offlineState();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
let installPrompt;
addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  installPrompt = event;
  document.querySelector("#install").classList.remove("hidden");
});
document.querySelector("#install").addEventListener("click", async () => {
  if (installPrompt) await installPrompt.prompt();
  document.querySelector("#install").classList.add("hidden");
});
document.querySelector("#auth-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(event.target));
    await api(button.dataset.mode === "register" ? "/register" : "/login", "POST", values);
    dialog.close();
    event.target.reset();
    await load();
    toast("已登入；這是全新作品集示範系統，請勿使用其他網站的真實密碼。");
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});
document.querySelector("#logout").addEventListener("click", async () => {
  try { await api("/logout","POST"); location.hash=""; clearPrivateState(); await load(); } catch (error) { toast(error.message); }
});


let user = null;
let loadSequence = 0;
let catalog = null;
let rooms = [];
let activeRoom = null;
let comparison = null;
let view = new URLSearchParams(location.hash.slice(1)).get("view") || "explore";
if (new URLSearchParams(location.hash.slice(1)).has("invite")) view = "rooms";
let area = {latitude:25.033,longitude:121.5654,radius_m:1000,label:"台北示範區（非目前位置）"};
let source = "catalog";
let restaurants = [];
let keyword = "";
let cuisine = "";
let sourceError = "";
let searching = false;
let sequence = 0;
let mapConsent = false;
let placesConsent = false;
let pendingExternal = null;
let accuracy = null;
let pendingConfirmation = null;
const presets = {
  demo:{latitude:25.033,longitude:121.5654,label:"台北示範區（非目前位置）"},
  station:{latitude:25.0478,longitude:121.517,label:"台北車站周邊（近似座標）"},
  taichung:{latitude:24.1503,longitude:120.6648,label:"台中市中心周邊（近似座標）"}
};
const money = value => Number(value).toLocaleString("zh-TW");
const distanceLabel = value => value == null ? "距離未知" : value < 1000 ? Math.round(value)+" 公尺" : (value/1000).toFixed(1)+" 公里";
const inviteFromUrl = () => new URLSearchParams(location.hash.slice(1)).get("invite") || "";
function areaPayload() {
  return {latitude:area.latitude,longitude:area.longitude,radius_m:area.radius_m,label:area.label};
}
function heading(title, description, extra="") {
  return `<div class="page-title"><div><p class="overline">MEALBRIDGE / ${view==="rooms"?"SHARED TABLE":view==="catalog"?"MENU NOTES":"NEARBY"}</p><h1>${title}</h1><p class="muted">${description}</p></div><div class="page-aside">${extra}</div></div>`;
}
function filteredRestaurants() {
  return restaurants.filter(item=>(!keyword||(item.name+" "+item.cuisine).toLowerCase().includes(keyword.toLowerCase()))&&(!cuisine||item.cuisine===cuisine));
}
function restaurantRows() {
  const visible = filteredRestaurants();
  return `<div class="results-heading"><h2>${visible.length} 個附近選擇</h2><span class="caption">依直線距離排序</span></div>
    ${visible.map((item,index)=>{
      const prices=item.dishes.map(dish=>dish.price);
      const age=item.verified_on?Math.floor(Date.now()/86400000)-Math.floor(Date.parse(item.verified_on+"T00:00:00Z")/86400000):null;
      const outdated=age!==null&&(age<0||age>30);
      return `<article class="restaurant-row"><span class="row-index">${String(index+1).padStart(2,"0")}</span><div><h3><button class="title-button" data-action="restaurant" data-id="${escapeHtml(item.id)}">${escapeHtml(item.name)}</button></h3><div class="meta"><span>${escapeHtml(item.cuisine)}</span><span>↗ ${distanceLabel(item.distance_m)}</span><span class="data-label ${item.fictional?"":"osm"}">${item.fictional?"虛構示範":source==="osm"?"OSM 店家":"維護者資料"}</span></div><div class="tags">${prices.length?`<span class="tag ${outdated?"warn":"positive"}">${outdated?"菜單需重新查核":item.fictional?"示範菜單可比較":"含維護者菜單"}</span>${item.dishes.some(dish=>dish.diet==="vegetarian")?'<span class="tag">有蛋奶素選項</span>':""}`:'<span class="tag warn">尚無已查核菜單</span>'}</div>${item.address?`<p>${escapeHtml(item.address)}</p>`:""}</div><div class="price">${prices.length?"$"+Math.min(...prices):"—"}<small>${prices.length?"單道餐點起":"價格待確認"}</small><button class="inline-link row-action" data-action="restaurant" data-id="${escapeHtml(item.id)}">${prices.length?"看菜單 ↗":"看店家 ↗"}</button></div></article>`;
    }).join("")||`<div class="empty"><h3>${searching?"正在找附近的選擇…":"這個範圍還沒有符合的資料。"}</h3><p>${source==="catalog"?"示範店家只放在台北示範區，不會假裝出現在你附近。可調大範圍、切換示範集合點，或同意查詢真實 OSM 店家。":"可以放大範圍或稍後重試。社群資料不保證收錄所有店家。"}</p><button class="outline" data-action="location">重新選擇地點</button></div>`}`;
}
function mapView() {
  const points=filteredRestaurants().slice(0,12);
  const scale=137/area.radius_m;
  return `<div class="distance-map"><svg viewBox="0 0 520 350" role="img" aria-label="附近餐廳的直線距離示意圖，非街道地圖"><defs><pattern id="map-grid" width="25" height="25" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r=".6" fill="#d7cdbb"/></pattern></defs><rect width="520" height="350" fill="url(#map-grid)"/><circle cx="260" cy="165" r="137" fill="#e7ecdf" fill-opacity=".6" stroke="#b9c5ab" stroke-dasharray="5 5"/><circle cx="260" cy="165" r="91" fill="none" stroke="#d3d7c3"/><circle cx="260" cy="165" r="45" fill="none" stroke="#d3d7c3"/><path d="M260 20V308M113 165H407" stroke="#d6d9c7" stroke-dasharray="2 5"/><text x="472" y="38" font-size="12" fill="#6b7262">N ↑</text><text x="275" y="35" font-size="11" fill="#6b7262">${distanceLabel(area.radius_m)}</text>${points.map((item,index)=>{
    if(!item.coordinates)return "";
    const longitudeDelta=((item.coordinates.longitude-area.longitude+540)%360)-180;
    const horizontal=260+longitudeDelta*111195*Math.cos(area.latitude*Math.PI/180)*scale;
    const vertical=165-(item.coordinates.latitude-area.latitude)*111195*scale;
    return `<g class="map-marker" role="button" tabindex="0" aria-label="查看 ${escapeHtml(item.name)}" data-action="restaurant" data-id="${escapeHtml(item.id)}"><rect x="${(horizontal-17).toFixed(2)}" y="${(vertical-16).toFixed(2)}" width="34" height="30" rx="5"/><text x="${horizontal.toFixed(2)}" y="${(vertical+4).toFixed(2)}" text-anchor="middle">${index+1}</text></g>`;
  }).join("")}<circle cx="260" cy="165" r="8" fill="#b7492d" stroke="white" stroke-width="3"/><rect x="233" y="180" width="54" height="23" rx="4" fill="#b7492d"/><text x="260" y="195" text-anchor="middle" fill="white" font-size="10">搜尋點</text></svg><div class="map-legend"><strong>↗ 直線距離示意 · 非街道</strong><span>標示前 12 間</span></div></div>
  <p class="map-caption">以「${escapeHtml(area.label)}」為中心。${accuracy!==null?`裝置回報誤差約 ${accuracy} 公尺；定位座標已約略化。`:"不是即時 GPS 追蹤。"}直線距離不是步行路線或到店時間。</p>
  <div class="map-card"><h3>${mapConsent?"街道圖 · OpenStreetMap":"想看看實際街道？"}</h3>${mapConsent?`<iframe class="street-map" title="OpenStreetMap 搜尋區域地圖" loading="lazy" referrerpolicy="origin" src="${escapeHtml(mapUrl())}"></iframe><p class="caption">© OpenStreetMap contributors · 僅顯示約略區域，不標出你的定位點。此圖不會離線快取。</p>`:'<p>載入前會先告知搜尋區域將傳給 OpenStreetMap；不需付費金鑰，也可不載入。</p><button class="outline small" data-action="external-map">載入街道圖</button>'}</div>`;
}
function mapUrl() {
  const latitude=Math.round(area.latitude*100)/100,longitude=Math.round(area.longitude*100)/100;
  const latitudeSpan=(area.radius_m+1600)/111195;
  const longitudeSpan=latitudeSpan/Math.max(.05,Math.cos(latitude*Math.PI/180));
  const bounds=[Math.max(-180,longitude-longitudeSpan),Math.max(-90,latitude-latitudeSpan),Math.min(180,longitude+longitudeSpan),Math.min(90,latitude+latitudeSpan)];
  return "https://www.openstreetmap.org/export/embed.html?bbox="+encodeURIComponent(bounds.join(","))+"&layer=mapnik";
}
function exploreView() {
  return heading("今天這一餐，從附近開始。","先找位置，再把每個人的條件放進來。","不急著選評分最高的店。<br>先找大家都能好好吃飯的地方。")+
  `<form id="discover-filter" class="search-bar"><label>從哪裡出發<button type="button" class="point-button" data-action="location">◎ ${escapeHtml(area.label)}</button></label><label>想找什麼<input name="keyword" placeholder="店名或料理類型" maxlength="100" value="${escapeHtml(keyword)}"></label><label>直線範圍<select name="radius_m">${[100,500,1000,3000,5000].map(radius=>`<option value="${radius}" ${radius===area.radius_m?"selected":""}>${distanceLabel(radius)}內</option>`).join("")}</select></label><button ${searching?"disabled":""}>${searching?"搜尋中":"搜尋"}</button></form>
  <div class="toolbar"><div class="chips"><button class="chip ${!cuisine?"active":""}" data-action="cuisine" data-value="">全部料理</button>${[...new Set(restaurants.map(item=>item.cuisine))].slice(0,5).map(value=>`<button class="chip ${cuisine===value?"active":""}" data-action="cuisine" data-value="${escapeHtml(value)}">${escapeHtml(value)}</button>`).join("")}</div><div class="source-switch" aria-label="店家資料來源"><button class="${source==="catalog"?"active":""}" data-action="source" data-source="catalog">${catalog.restaurants.some(item=>!item.fictional)?"維護者菜單":"示範菜單"}</button><button class="${source==="osm"?"active":""}" data-action="source" data-source="osm">真實 OSM 店家 ↗</button></div></div>
  <p class="notice ${sourceError?"warning":""}">${sourceError?escapeHtml(sourceError):source==="catalog"?(catalog.restaurants.some(item=>!item.fictional)?"目前為維護者提供的菜單；來源與查核日期由維護者負責，不代表平台實地驗證。":"目前為虛構示範菜單；店名、價格及座標都不是實際商家。定位與距離計算是真的，不會把示範店家搬到你的附近。"):"目前為 OpenStreetMap 社群店家。無已查核菜單、價格與飲食保證；不能直接當成符合全員條件的推薦。"}${accuracy!==null&&accuracy>area.radius_m?" 定位誤差大於搜尋半徑，建議放大範圍或手動選點。":""}</p>
  ${source==="osm"?'<p class="caption">店家資料 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors · ODbL</a>。範圍內最多回傳 80 筆，不保證完整收錄。</p>':""}
  <div class="discovery"><section aria-label="附近店家">${restaurantRows()}</section><aside class="map-column">${mapView()}</aside></div>`;
}
function preferencesForm(values) {
  values=values||{budget:150,max_distance_m:1500,cuisines:[]};
  return `<form id="preferences" class="preference-fields"><div class="form-grid"><label>我這餐最多花多少？（NT$）<input type="number" name="budget" min="50" max="3000" value="${values.budget}" required></label><label>離共同集合點最遠幾公尺？<input type="number" name="max_distance_m" min="100" max="5000" value="${values.max_distance_m||3000}" required></label><label class="full">偏好的料理（選填，用逗號分隔）<input name="cuisines" maxlength="180" placeholder="台式,日式" value="${escapeHtml(values.cuisines.join(","))}"></label></div><div class="checks">${[["vegetarian","蛋奶素"],["no_beef","不吃牛"],["no_pork","不吃豬"],["no_spicy","不吃辣"]].map(([key,label])=>`<label class="check"><input type="checkbox" name="${key}" ${values[key]?"checked":""}>${label}</label>`).join("")}</div><p class="caption">蛋奶素不等於全素；未確認的成分不會自動當作符合限制。這不是過敏原或醫療飲食工具。</p><button>儲存我的條件</button></form>`;
}
function candidate(item, frozen=false) {
  return `<article class="candidate" id="candidate-${escapeHtml(item.id)}"><div class="candidate-head"><div><span class="tag positive">全員有符合條件的餐點</span><h3>${escapeHtml(item.name)}</h3><p class="muted">${escapeHtml(item.cuisine)} · ${distanceLabel(item.distance_m)} · ${item.fictional?"虛構示範菜單":"維護者提供菜單"}</p></div><div class="total">$ ${money(item.group_total)}<small>全員餐點合計</small></div></div><div class="meal-allocation">${item.choices.map(choice=>`<div><strong>${escapeHtml(choice.nickname)}</strong>${escapeHtml(choice.dish.name)} · $ ${choice.dish.price}<br><span class="caption">預算餘額 $ ${choice.remaining_budget}</span></div>`).join("")}</div><div class="button-row">${!frozen&&activeRoom?.is_host?`<button class="outline" data-action="freeze" data-id="${escapeHtml(item.id)}">就選這間，保留紀錄</button>`:""}<details><summary>查看菜單依據與排序說明</summary><p class="caption">${escapeHtml(item.source_label)} · 菜單日期 ${escapeHtml(item.verified_on)}。排序採硬條件先過濾、最低個人分數優先；最低參考分數 ${item.min_score}，不是滿意度機率或真實評價。</p></details></div></article>`;
}
function sharedAreaForm() {
  if(!activeRoom?.is_host||activeRoom.snapshot)return "";
  return `<details><summary>${activeRoom.area?"修改共同集合點":"設定共同集合點"}</summary><p class="muted">先在「附近探索」選好公共集合點，再套用。若使用私人定位，套用後座標會分享給這個決策室的所有成員。</p><form id="shared-area" class="form-stack"><div class="room-area">準備套用：${escapeHtml(area.label)}<br>${area.latitude.toFixed(4)}, ${area.longitude.toFixed(4)} · ${distanceLabel(area.radius_m)}內</div><label class="check"><input type="checkbox" name="consent" required>我同意將這個搜尋點及範圍分享給決策室成員。</label><button class="outline">套用這個共同集合點</button></form></details>`;
}
function roomContent() {
  if(!activeRoom)return `<div class="empty"><p class="overline">A TABLE FOR EVERYONE</p><h2>一餐，不必有人將就。</h2><p>建立決策室，把邀請傳給朋友。<br>選好共同集合點，每個人填好條件，再看全員可行的餐點。</p><button data-action="create-focus">建立這次的餐桌</button></div>`;
  const room=activeRoom;
  const complete=room.members.filter(member=>member.ready).length;
  return `<div class="room-header"><div><p class="overline">YOUR SHARED TABLE</p><h2>${escapeHtml(room.title)}</h2><span class="caption">${room.is_host?"你是發起人，可定案與管理邀請。":"你是成員，可填寫自己的條件。"} · 成員狀態以更新時為準</span></div><div class="button-row"><button class="outline small" data-action="invite">分享邀請</button><button class="text-button small" data-action="room-refresh">更新狀態</button></div></div><ol class="room-progress"><li class="${room.area?"done":""}">01 選集合點 ${room.area?"✓":""}</li><li class="${complete===room.members.length?"done":""}">02 填條件 ${complete}/${room.members.length}</li><li class="${comparison?"done":""}">03 比較</li><li class="${room.snapshot?"done":""}">04 定案 ${room.snapshot?"✓":""}</li></ol><div class="members">${room.members.map(member=>`<span class="member ${member.ready?"ready":""}">${escapeHtml(member.nickname)} · ${member.ready?"條件已填":"待填寫"}</span>`).join("")}</div>
  ${room.area?`<div class="room-area">◎ ${escapeHtml(room.area.label)} · 直線 ${distanceLabel(room.area.radius_m)}內<br><span class="caption">共同集合點，不是所有成員的即時位置。</span></div>`:'<p class="notice">還沒設定共同集合點。先選位置，才能根據實際直線距離比較。</p>'}
  ${room.snapshot?`<div class="summary-ticket"><span class="decision-stamp">這一餐，已決定</span>${candidate(room.snapshot.selected,true)}<p class="caption">保留的是定案當下的菜單與金額，日後改價不會改寫此紀錄；實際供應仍須確認。</p><button class="outline" data-action="export">下載決策紀錄 JSON</button></div>`:
  `${sharedAreaForm()}<section class="form-section"><h3>我的條件</h3><p class="muted">原始偏好只顯示給你；比較時會與成員分享可行餐點與預算餘額。</p>${preferencesForm(room.preferences)}</section><section class="form-section"><div class="toolbar"><h3>大家都能接受的選擇</h3><button data-action="compare" ${!room.area||complete!==room.members.length?"disabled":""}>比較全員可行餐點</button></div>${comparison?`<p class="caption">不會為了找到結果而放寬任何人的硬條件；距離皆以共同集合點為準。</p>${comparison.eligible.map(item=>candidate(item)).join("")||'<p class="notice warning">目前沒有符合全員條件的選項。請一起討論調整距離／預算，或補充已查核菜單。</p>'}<details><summary>哪些選項沒有通過？（${comparison.rejected.length} 間）</summary>${comparison.rejected.map(item=>`<div class="exclusion"><h4>${escapeHtml(item.name)}</h4><ul>${item.reasons.map(reason=>`<li>${escapeHtml(reason)}</li>`).join("")}</ul></div>`).join("")}</details>`:'<p class="muted">集合點與每個人的條件都準備好後，就能開始比較。真實 OSM 店家若沒有已查核菜單，不會自動加入這份決策。</p>'}</section>`}
  ${room.is_host?`<details><summary>邀請與隱私設定</summary><p class="muted">邀請連結等同入場權限，只分享給同行者。更新後舊連結失效，但不會移除既有成員。</p><button class="outline small" data-action="rotate-invite">更新邀請碼，使舊連結失效</button></details>`:""}`;
}
function roomsView() {
  return heading("把每個人的條件，放上同一張桌。","不是平均評分最高，而是沒有任何一個人被忽略。")+
  `<div class="room-layout"><aside class="room-sidebar"><h2>我的餐桌</h2><div class="room-list">${rooms.map(room=>`<button class="room-item ${room.id===activeRoom?.id?"active":""}" data-action="room" data-id="${escapeHtml(room.id)}">${escapeHtml(room.title)}<small>${room.frozen?"已定案":"條件收集中"}</small></button>`).join("")||'<p class="muted">登入後可建立及加入餐桌。</p>'}</div><details id="create-details"><summary>＋ 建立新餐桌</summary><form id="create-room" class="form-stack"><label>這次的餐桌名稱<input name="title" placeholder="週五午餐" maxlength="70" required></label><label class="check"><input type="checkbox" name="share_area">以目前搜尋點作集合點，並同意將座標與範圍分享給成員。</label><button>建立決策室</button></form></details><hr><details ${inviteFromUrl()?"open":""}><summary>用朋友的邀請碼加入</summary><form id="join-room" class="form-stack"><label>邀請碼<input name="invite" minlength="20" maxlength="100" value="${escapeHtml(inviteFromUrl())}" required></label><button class="outline">加入餐桌</button></form></details></aside><section class="room-content">${roomContent()}</section></div>`;
}
function catalogView() {
  return heading("好的決定，從看得見的依據開始。","每一份菜單，都標示資料來源與日期。")+
  `<p class="notice">請逐筆查看來源與日期；標示「虛構示範」的店名、菜單與座標不是實際商家。維護者資料不代表平台實地查核；OSM 探索不會自動補造價格或飲食分類。</p><div class="menu-library">${catalog.restaurants.map(item=>`<article class="menu-record"><span class="data-label">${item.fictional?"虛構示範":"維護者資料"}</span><h3>${escapeHtml(item.name)}</h3><p class="muted">${escapeHtml(item.source_label)}<br>菜單日期 ${escapeHtml(item.verified_on)}</p>${dishTable(item)}<details><summary>回報待確認資訊</summary><form data-report="${escapeHtml(item.id)}" class="form-stack"><label>哪裡需要再確認？<textarea name="note" minlength="5" maxlength="500" required placeholder="例如：餐點價格或飲食分類需要查核"></textarea></label><button class="outline small">送出待查核回報</button><span class="caption">須登入。回報不會自動改寫菜單；由維護者人工查證。</span></form></details></article>`).join("")}</div>`;
}
function dishTable(item) {
  return `<div class="table-scroll"><table class="menu-table"><thead><tr><th>餐點</th><th>飲食資訊</th><th>NT$</th></tr></thead><tbody>${item.dishes.map(dish=>`<tr><td>${escapeHtml(dish.name)}</td><td>${dish.diet==="vegetarian"?"蛋奶素":dish.diet==="unknown"?"未確認":"葷食"} · ${dish.spicy===null?"辣度未確認":dish.spicy?"含辣":"不辣"}</td><td>${dish.price}</td></tr>`).join("")}</tbody></table></div>`;
}
function render() {
  renderIdentity(user);
  document.querySelectorAll("[data-view]").forEach(button=>button.setAttribute("aria-current",button.dataset.view===view?"page":"false"));
  main.innerHTML=!catalog?'<p class="empty">菜單尚未匯入。請先執行 seed.py，或連線後重新整理。</p>':view==="rooms"?roomsView():view==="catalog"?catalogView():exploreView();
}
async function searchNearby() {
  const requestSequence=++sequence;
  searching=true;sourceError="";restaurants=[];render();
  try {
    const result=await api(source==="osm"?"/nearby/openstreetmap":"/nearby/catalog","POST",{...areaPayload(),...(source==="osm"?{external_consent:placesConsent}:{})});
    if(requestSequence!==sequence)return;
    restaurants=result.restaurants;
  }catch(error){
    if(requestSequence!==sequence)return;
    restaurants=[];sourceError=error.message;toast(error.message);
  }finally{if(requestSequence===sequence){searching=false;render();}}
}
async function load(roomId) {
  const requestSequence=++loadSequence;
  const resolved=await api("/me").catch(()=>null);
  if(requestSequence!==loadSequence)return;
  user=resolved;
  if(!user){rooms=[];activeRoom=null;comparison=null;clearSensitiveDialogs();if(catalog)render();}
  const nextCatalog=await api("/catalog");
  if(requestSequence!==loadSequence)return;
  const nextRooms=user?await api("/rooms"):[];
  if(requestSequence!==loadSequence)return;
  catalog=nextCatalog;rooms=nextRooms;
  const selected=roomId||activeRoom?.id||new URLSearchParams(location.hash.slice(1)).get("room")||rooms[0]?.id;
  const nextRoom=user&&rooms.some(room=>room.id===selected)?await api("/rooms/"+selected):null;
  if(requestSequence!==loadSequence)return;
  activeRoom=nextRoom;
  comparison=null;
  if(source==="catalog")await searchNearby();else render();
}
function setView(next) {
  view=next;
  const parameters=new URLSearchParams({view});
  if(activeRoom&&view==="rooms")parameters.set("room",activeRoom.id);
  if(inviteFromUrl()&&view==="rooms")parameters.set("invite",inviteFromUrl());
  location.hash=parameters.toString();render();
}
function clearSensitiveDialogs(){
  document.querySelectorAll("dialog[open]").forEach(target=>target.close());
  document.querySelector("#restaurant-dialog").innerHTML="";
  pendingConfirmation=null;
}
function clearPrivateState(){
  loadSequence++;sequence++;
  user=null;rooms=[];activeRoom=null;comparison=null;view="explore";
  area={...presets.demo,radius_m:1000};accuracy=null;restaurants=[];source="catalog";sourceError="";
  mapConsent=false;placesConsent=false;pendingExternal=null;searching=false;
  clearSensitiveDialogs();render();
}
function openLocation() {
  const form=document.querySelector("#location-form");
  for(const key of ["latitude","longitude","label"])form.elements[key].value=area[key];
  document.querySelector("#location-preset").value="manual";
  document.querySelector("#location-dialog").showModal();
}
function externalConsent(kind) {
  pendingExternal=kind;
  document.querySelector("#external-description").textContent=kind==="places"
    ?"本服務會把約 1 公里格網的搜尋中心與擴大半徑，送至 overpass-api.de 查詢 OpenStreetMap 店家；不傳送你的帳號、地點名稱或原始定位座標。回傳後依你選定的中心計算距離。未查核菜單不會當作可行餐點。"
    :"將載入 OpenStreetMap 街道圖。你的瀏覽器會將約略搜尋區域及網路位址傳給 OpenStreetMap，不會標出你的定位點；只有你按同意後才載入。這不等於完全匿名。";
  document.querySelector("#external-dialog").showModal();
}
function confirmAction(description, callback) {
  pendingConfirmation=callback;
  document.querySelector("#confirm-description").textContent=description;
  document.querySelector("#confirm-dialog").showModal();
}
document.querySelector("#confirm-yes").addEventListener("click",async()=>{
  const callback=pendingConfirmation;pendingConfirmation=null;document.querySelector("#confirm-dialog").close();
  try{if(callback)await callback();}catch(error){toast(error.message);}
});
document.querySelector("#external-confirm").addEventListener("click",async()=>{
  document.querySelector("#external-dialog").close();
  if(pendingExternal==="places"){placesConsent=true;source="osm";cuisine="";await searchNearby();}
  else if(pendingExternal==="map"){mapConsent=true;render();}
});
document.querySelector("#location-preset").addEventListener("change",event=>{
  const point=presets[event.target.value];if(!point)return;
  const form=document.querySelector("#location-form");
  for(const key of ["latitude","longitude","label"])form.elements[key].value=point[key];
});
document.querySelector("#location-form").addEventListener("submit",async event=>{
  event.preventDefault();
  const values=Object.fromEntries(new FormData(event.target));
  area={latitude:Number(values.latitude),longitude:Number(values.longitude),label:values.label,radius_m:area.radius_m};
  accuracy=null;document.querySelector("#location-dialog").close();await searchNearby();toast("搜尋點已更新；不會自動分享給餐桌成員。");
});
document.addEventListener("click",event=>{
  const close=event.target.closest("[data-close]");
  if(close){document.getElementById(close.dataset.close).close();return;}
  const navigation=event.target.closest("[data-view]");if(navigation)setView(navigation.dataset.view);
});
async function handleAction(button) {
  const action=button.dataset.action;
  if(action==="auth"){dialog.showModal();return;}
  if(action==="location"){openLocation();return;}
  if(action==="locate"){
    toast("正在向裝置請求位置；你可以拒絕，改用手動選點。");
    const position=await MealLocation.locate();
    area={latitude:position.latitude,longitude:position.longitude,radius_m:area.radius_m,label:"目前位置（約略）"};
    accuracy=position.accuracy;
    document.querySelector("#location-dialog").close();
    await searchNearby();toast("已取得本次位置；尚未分享給決策室成員。");return;
  }
  if(action==="source"){
    if(button.dataset.source==="osm"&&!placesConsent){externalConsent("places");return;}
    source=button.dataset.source;cuisine="";await searchNearby();return;
  }
  if(action==="external-map"){externalConsent("map");return;}
  if(action==="cuisine"){cuisine=button.dataset.value;render();return;}
  if(action==="create-focus"){setView("rooms");document.querySelector("#create-details").open=true;document.querySelector("#create-room input").focus();return;}
  if(action==="restaurant"){
    const item=restaurants.find(restaurant=>restaurant.id===button.dataset.id)||catalog.restaurants.find(restaurant=>restaurant.id===button.dataset.id);
    if(!item)return;
    const target=document.querySelector("#restaurant-dialog");
    target.innerHTML=`<button class="dialog-close" data-close="restaurant-dialog" aria-label="關閉餐廳詳情">×</button><span class="data-label ${item.fictional?"":"osm"}">${item.fictional?"虛構示範":"OpenStreetMap 店家"}</span><h2>${escapeHtml(item.name)}</h2><p class="muted">${escapeHtml(item.cuisine)} · ${distanceLabel(item.distance_m)}（直線）</p>${item.dishes.length?dishTable(item):'<p class="notice warning">目前沒有已查核菜單與價格。只能作為附近探索，不能宣稱符合任何人的飲食或預算條件。</p>'}<p class="caption">${escapeHtml(item.source_label)}${item.verified_on?" · "+escapeHtml(item.verified_on):""}</p>${item.source_url?`<a href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener noreferrer">查看原始店家資料 ↗</a>`:""}${item.dishes.length?'<div class="button-row"><button data-action="go-rooms">和朋友一起比較</button></div>':""}`;
    target.showModal();return;
  }
  if(action==="go-rooms"){document.querySelector("#restaurant-dialog").close();setView("rooms");return;}
  if(!user){dialog.showModal();return;}
  if(action==="room"){view="rooms";location.hash="view=rooms&room="+button.dataset.id;await load(button.dataset.id);return;}
  if(action==="room-refresh"){await load(activeRoom.id);toast("已取得最新成員狀態。");return;}
  if(action==="invite"){
    const link=location.origin+"/#view=rooms&invite="+activeRoom.invite;
    try{await navigator.clipboard.writeText(link);toast("邀請連結已複製。請私下分享給同行者。");}
    catch{const target=document.querySelector("#restaurant-dialog");target.innerHTML=`<button class="dialog-close" data-close="restaurant-dialog" aria-label="關閉分享">×</button><h2>邀請朋友一起選餐</h2><label>手動複製邀請連結<input readonly value="${escapeHtml(link)}"></label>`;target.showModal();}
    return;
  }
  if(action==="rotate-invite"){
    confirmAction("更新後舊邀請連結將失效；既有成員仍保留權限。確定更新？",async()=>{await api("/rooms/"+activeRoom.id+"/rotate-invite","POST");await load(activeRoom.id);toast("舊連結已失效，請重新分享邀請。");});return;
  }
  if(action==="compare"){
    activeRoom=await api("/rooms/"+activeRoom.id);
    comparison=await api("/rooms/"+activeRoom.id+"/recommendations");
    render();return;
  }
  if(action==="freeze"){
    const restaurantId=button.dataset.id;
    confirmAction("定案後無法再修改本次條件。會保存目前菜單、集合點與每人的餐點。確定選這間？",async()=>{
      await api("/rooms/"+activeRoom.id+"/freeze","POST",{restaurant_id:restaurantId,room_version:comparison.room_version,catalog_version:comparison.catalog_version});
      await load(activeRoom.id);toast("這一餐已定案，當時的決策依據已保留。");
    });return;
  }
  if(action==="export"){
    const url=URL.createObjectURL(new Blob([JSON.stringify(activeRoom.snapshot,null,2)],{type:"application/json"}));
    const anchor=document.createElement("a");anchor.href=url;anchor.download="mealbridge-decision.json";anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
}
document.addEventListener("click",async event=>{
  const button=event.target.closest("[data-action]");if(!button)return;
  button.disabled=true;
  try{await handleAction(button);}catch(error){toast(error.message);}finally{button.disabled=false;}
});
main.addEventListener("keydown",event=>{
  const marker=event.target.closest("g[data-action]");if(marker&&["Enter"," "].includes(event.key)){event.preventDefault();marker.dispatchEvent(new MouseEvent("click",{bubbles:true}));}
});
main.addEventListener("submit",async event=>{
  event.preventDefault();
  const form=event.target,button=event.submitter;button.disabled=true;
  try{
    const values=Object.fromEntries(new FormData(form));
    if(form.id==="discover-filter"){keyword=values.keyword.trim();area.radius_m=Number(values.radius_m);await searchNearby();return;}
    if(!user){dialog.showModal();return;}
    if(form.id==="create-room"){
      const room=await api("/rooms","POST",{title:values.title,...(values.share_area?{area:areaPayload()}:{})});
      view="rooms";location.hash="view=rooms&room="+room.id;await load(room.id);toast("餐桌已建立，先填自己的條件，再分享邀請。");
    }else if(form.id==="join-room"){
      const room=await api("/rooms/join","POST",{invite:values.invite});view="rooms";location.hash="view=rooms&room="+room.id;await load(room.id);
    }else if(form.id==="shared-area"){
      if(!values.consent)throw new Error("請先同意分享這個共同集合點。");
      await api("/rooms/"+activeRoom.id+"/area","PUT",areaPayload());await load(activeRoom.id);toast("共同集合點已更新，先前比較結果已失效。");
    }else if(form.id==="preferences"){
      const payload={budget:Number(values.budget),max_distance_m:Number(values.max_distance_m),max_walk:15,cuisines:values.cuisines.split(",").map(item=>item.trim()).filter(Boolean)};
      for(const key of ["vegetarian","no_beef","no_pork","no_spicy"])payload[key]=form.elements[key].checked;
      await api("/rooms/"+activeRoom.id+"/preferences","PUT",payload);await load(activeRoom.id);toast("你的條件已儲存，可以更新成員狀態後比較。");
    }else if(form.dataset.report){
      const result=await api("/reports","POST",{restaurant_id:form.dataset.report,note:values.note});form.reset();toast(result.message);
    }
  }catch(error){toast(error.message);}finally{button.disabled=false;}
});
load().catch(error=>{render();toast(error.message);});

