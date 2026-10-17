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
  try { await api("/logout","POST"); location.hash=""; await load(); } catch (error) { toast(error.message); }
});

let user = null;
let catalog = null;
let rooms = [];
let activeRoom = null;
let comparison = null;
const inviteFromUrl = () => new URLSearchParams(location.hash.slice(1)).get("invite") || "";
function preferenceForm(preferences) {
  const values = preferences || {budget:140,max_walk:15,cuisines:[]};
  return `<form id="preferences" class="form-grid">
    <label>我的餐費上限（NT$）<input type="number" name="budget" min="50" max="3000" required value="${escapeHtml(values.budget)}"></label>
    <label>最多步行幾分鐘<input type="number" name="max_walk" min="0" max="60" required value="${escapeHtml(values.max_walk)}"></label>
    <label class="full">偏好料理（非必要，以逗號分隔）<input name="cuisines" maxlength="180" placeholder="台式,日式" value="${escapeHtml(values.cuisines.join(","))}"></label>
    ${[["vegetarian","蛋奶素（不是全素）"],["no_beef","不吃牛肉"],["no_pork","不吃豬肉"],["no_spicy","不吃辣"]].map(([key,label])=>`<label class="check"><input type="checkbox" name="${key}" ${values[key]?"checked":""}>${label}</label>`).join("")}
    <div class="full"><button type="submit">儲存我的條件</button></div></form>`;
}
function candidate(item, index, frozen=false) {
  return `<article class="candidate ${index===0?"best":""}">
    <div class="row between"><span class="badge">${frozen?"已定案":index===0?"優先推薦":"也能一起吃"}</span><span class="muted">${escapeHtml(item.cuisine)} · 步行 ${item.walk_minutes} 分</span></div>
    <h3>${escapeHtml(item.name)}</h3>
    <div class="score">${item.min_score} <small>最低個人分數 / 100</small></div>
    <p class="muted">全員餐費 NT$ ${item.group_total} · 平均分數 ${item.mean_score}</p>
    ${item.choices.map(choice=>`<div class="choice"><div><strong>${escapeHtml(choice.nickname)}</strong>${escapeHtml(choice.dish.name)}</div><div>NT$ ${choice.dish.price}<br><small>預算餘額 ${choice.remaining_budget}</small></div></div>`).join("")}
    <p><small>${item.fictional?"虛構示範":"維護者提供資料"} · 菜單日期 ${escapeHtml(item.verified_on)}<br>${escapeHtml(item.source_label)}</small></p>
    ${item.source_url?`<a href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener noreferrer">查看來源</a>`:""}
    ${!frozen&&activeRoom?.is_host?`<button data-action="freeze" data-id="${escapeHtml(item.id)}" class="secondary">選這間並保留決策快照</button>`:""}
  </article>`;
}
function roomView() {
  if (!activeRoom) return '<section class="panel"><div class="empty">先建立決策室，或貼上朋友的邀請碼。<br>每個人都填好條件後，再比較可行的一餐。</div></section>';
  const room = activeRoom;
  return `<section class="panel">
    <div class="row between"><div><p class="eyebrow">YOUR SHARED TABLE</p><h2>${escapeHtml(room.title)}</h2></div><span class="badge">${room.snapshot?"決策已定案":"條件收集中"}</span></div>
    <div class="row">${room.members.map(member=>`<span class="badge ${member.ready?"":"gray"}">${escapeHtml(member.nickname)} · ${member.ready?"已填好":"待填寫"}</span>`).join("")}</div>
    <p class="muted">成員只會看見自己的原始偏好；比較結果會分享每個人的可行餐點與預算餘額。</p>
    <button class="secondary" data-action="invite">複製邀請連結</button>
    ${room.snapshot?`<div class="divider"></div><h3>這一餐的決策紀錄</h3><p class="notice">快照不隨新菜單改寫。現場供應與價格仍須向店家確認。</p>${candidate(room.snapshot.selected,0,true)}<div class="actions"><button data-action="export" class="secondary">匯出決策 JSON</button></div>`:
      `<div class="divider"></div><h3>我的條件</h3>${preferenceForm(room.preferences)}<div class="divider"></div>
      <div class="row between"><h3>找出全員可接受的選擇</h3><button data-action="compare" ${room.members.some(member=>!member.ready)?"disabled":""}>開始比較</button></div>
      <p class="muted">先排除不符合硬條件的餐點，再優先提高最不滿意成員的分數；不會為了多數人的偏好犧牲任何人的預算或忌口。</p>
      ${comparison?`<div class="cards">${comparison.eligible.map((item,index)=>candidate(item,index)).join("")||'<div class="notice warning">目前沒有全員都能接受的餐廳。請協調預算／距離，或補充新菜單；系統不會偷偷放寬條件。</div>'}</div>
      <details><summary>為什麼其他 ${comparison.rejected.length} 間沒有通過？</summary>${comparison.rejected.map(item=>`<h4>${escapeHtml(item.name)}</h4><ul>${item.reasons.map(reason=>`<li>${escapeHtml(reason)}</li>`).join("")}</ul>`).join("")}</details>
      <small>資料版本 ${comparison.catalog_version} · 決策室版本 ${comparison.room_version} · 分數為可解釋啟發式，非滿意度機率。</small>`:""}`}
  </section>`;
}
function catalogView() {
  if (!catalog) return "";
  return `<section class="panel"><div class="row between"><div><p class="eyebrow">EVIDENCE BEFORE RATINGS</p><h2>看得到依據的菜單庫</h2></div><span class="badge gray">${catalog.restaurants.length} 間 · v${catalog.version}</span></div>
    <p class="notice warning">以下店家、餐點與價格皆為原創虛構資料，不代表真實營業、交通時間或食品成分。日期只用來示範過期排除機制。</p>
    <div class="cards">${catalog.restaurants.map(restaurant=>`<article class="candidate"><span class="badge gray">${escapeHtml(restaurant.cuisine)}</span><h3>${escapeHtml(restaurant.name)}</h3>
      <p class="muted">步行 ${restaurant.walk_minutes} 分 · 菜單 ${escapeHtml(restaurant.verified_on)}</p>
      ${restaurant.dishes.map(dish=>`<div class="choice"><div>${escapeHtml(dish.name)}<br><small>${dish.diet==="vegetarian"?"蛋奶素":dish.diet==="unknown"?"成分未確認":"葷食"} · ${dish.spicy===null?"辣度未確認":dish.spicy?"含辣":"不辣"}</small></div><b>NT$ ${dish.price}</b></div>`).join("")}
      <details><summary>回報資訊待確認</summary><form data-report="${escapeHtml(restaurant.id)}" class="stack"><label>需要查核的內容<textarea name="note" minlength="5" maxlength="500" required placeholder="例如：價格或飲食分類需要確認"></textarea></label><button class="secondary" ${user?"":"disabled"}>送出待查核回報</button><small>回報不會自動修改菜單；由維護者查證後匯入新版。</small></form></details></article>`).join("")}</div></section>`;
}
function render() {
  renderIdentity(user);
  main.innerHTML = `<section class="hero"><div><p class="eyebrow">LESS SCROLLING. MORE SHARED MEALS.</p><h1>一起吃飯，<br>不是少數人將就。</h1><p>有人吃素、有人預算有限。把每個人的條件放進同一張桌，從實際餐點找到全員可行的一餐。</p></div><div class="hero-note"><strong>每一位，都算數。</strong>硬條件優先<br>最低滿意分數優先<br>菜單證據保留</div></section>
    <div class="layout"><aside>
    <section class="panel"><h3>我的決策室</h3>${user?`<div class="stack">${rooms.map(room=>`<button class="room-button ${activeRoom?.id===room.id?"active":""}" data-action="room" data-id="${escapeHtml(room.id)}">${escapeHtml(room.title)} ${room.frozen?"· 已定案":""}</button>`).join("")||'<p class="muted">還沒有決策室。</p>'}</div><div class="divider"></div><form id="create-room" class="stack"><label>這次聚餐叫什麼？<input name="title" maxlength="70" placeholder="週五中午，一起吃" required></label><button>建立決策室</button></form>`:'<p class="muted">登入即可建立或加入。無需電話、定位或付費地圖金鑰。</p><button data-action="auth">開始使用</button>'}</section>
    <section class="panel"><h3>有朋友邀請你？</h3><form id="join-room" class="stack"><label>邀請碼<input name="invite" class="copy-field" value="${escapeHtml(inviteFromUrl())}" minlength="20" maxlength="100" required></label><button class="secondary">加入朋友的決策室</button></form><p class="muted">邀請連結等同入場權限，請只分享給要一起吃飯的人。</p></section></aside><div>${roomView()}${catalogView()}</div></div>`;
}
async function load(roomId) {
  user = await api("/me").catch(()=>null);
  catalog = await api("/catalog");
  rooms = user ? await api("/rooms") : [];
  const hashRoom = new URLSearchParams(location.hash.slice(1)).get("room");
  const selected = roomId || activeRoom?.id || hashRoom || rooms[0]?.id;
  activeRoom = user && selected && rooms.some(room=>room.id===selected) ? await api("/rooms/"+selected) : null;
  comparison = null;
  render();
}
main.addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.target;
  const button = event.submitter;
  button.disabled = true;
  try {
    if (!user) { dialog.showModal(); return; }
    const values = Object.fromEntries(new FormData(form));
    if (form.id === "create-room") {
      const room = await api("/rooms","POST",values);
      location.hash = "room="+room.id;
      await load(room.id);
      toast("已建立，先填妥自己的條件，再分享邀請。");
    } else if (form.id === "join-room") {
      const room = await api("/rooms/join","POST",values);
      location.hash="room="+room.id;
      await load(room.id);
    } else if (form.id === "preferences") {
      values.budget = Number(values.budget); values.max_walk = Number(values.max_walk);
      values.cuisines = values.cuisines.split(",").map(value=>value.trim()).filter(Boolean);
      for (const key of ["vegetarian","no_beef","no_pork","no_spicy"]) values[key]=form.elements[key].checked;
      await api("/rooms/"+activeRoom.id+"/preferences","PUT",values);
      await load(activeRoom.id); toast("條件已更新，請重新比較。");
    } else if (form.dataset.report) {
      const result=await api("/reports","POST",{restaurant_id:form.dataset.report,note:values.note});
      form.reset(); toast(result.message);
    }
  } catch (error) { toast(error.message); }
  finally { button.disabled=false; }
});
main.addEventListener("click", async event => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  button.disabled = true;
  try {
    const action=button.dataset.action;
    if (action==="auth") dialog.showModal();
    if (action==="room") { location.hash="room="+button.dataset.id; await load(button.dataset.id); }
    if (action==="invite") {
      const link=location.origin+"/#invite="+activeRoom.invite;
      try { await navigator.clipboard.writeText(link); toast("邀請連結已複製，請私下分享。"); }
      catch { toast("邀請連結："+link); }
    }
    if (action==="compare") {
      activeRoom=await api("/rooms/"+activeRoom.id);
      comparison=await api("/rooms/"+activeRoom.id+"/recommendations"); render();
    }
    if (action==="freeze") {
      await api("/rooms/"+activeRoom.id+"/freeze","POST",{restaurant_id:button.dataset.id,room_version:comparison.room_version,catalog_version:comparison.catalog_version});
      await load(activeRoom.id); toast("已定案，保留當時的菜單與每人餐點。");
    }
    if (action==="export") {
      const url=URL.createObjectURL(new Blob([JSON.stringify(activeRoom.snapshot,null,2)],{type:"application/json"}));
      const anchor=document.createElement("a"); anchor.href=url; anchor.download="mealbridge-decision.json"; anchor.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
    }
  } catch (error) { toast(error.message); }
  finally { button.disabled=false; }
});
load().catch(error => { main.innerHTML='<div class="panel empty">暫時無法載入。請確認伺服器已啟動並匯入示範菜單，再重新整理。</div>'; toast(error.message); });

