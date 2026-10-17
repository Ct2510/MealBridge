import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {startUI,flush} from "./ui_test_helper.mjs";

const directory=new URL("./",import.meta.url);
test("Any API response started before logout is rejected, not handed to its caller",async()=>{
  const fixture=fixtures();fixture.login();
  let hold=false,release;
  const respond=async(path,options)=>{
    const result=await fixture.respond(path,options);
    if(path==="/api/rooms"&&hold){hold=false;return new Promise(resolve=>{release=()=>resolve(result);});}
    return result;
  };
  const ui=await startUI(directory,respond);
  hold=true;
  const pending=vm.runInContext("api('/rooms')",ui.context);
  await flush();await ui.click("#logout");
  const rejected=assert.rejects(pending,/工作階段已變更/);
  release();await rejected;
});
test("An earlier in-flight session response cannot restore identity after logout",async()=>{
  const fixture=fixtures();fixture.login();
  let hold=false,release;
  const respond=async(path,options)=>{
    const result=await fixture.respond(path,options);
    if(path==="/api/me"&&hold){hold=false;return new Promise(resolve=>{release=()=>resolve(result);});}
    return result;
  };
  const ui=await startUI(directory,respond);
  hold=true;
  const pending=vm.runInContext("load()",ui.context);
  await flush();
  await ui.click("#logout");
  release();await pending;await flush();
  assert.equal(ui.document.querySelector("#identity").textContent,"訪客");
});
function fixtures(){
  let signedIn=false,broken=false;
  const room={id:"room1",title:"私人午餐名稱",is_host:false,members:[],preferences:null,area:null,snapshot:null};
  const respond=async path=>{
    if(path==="/api/logout"){signedIn=false;broken=true;return {};}
    if(path==="/api/me")return signedIn?{nickname:"私人暱稱"}:null;
    if(path==="/api/catalog")return broken?{error:"測試網路失敗"}:{restaurants:[],version:1};
    if(path==="/api/rooms")return [{...room,frozen:false}];
    if(path==="/api/rooms/room1")return room;
    if(path.startsWith("/api/nearby/"))return {restaurants:[]};
    throw new Error("Unexpected request "+path);
  };
  return {respond,login:()=>{signedIn=true;}};
}
test("Initial exploration does not request GPS, external places or an iframe",async()=>{
  const fixture=fixtures();
  const ui=await startUI(directory,fixture.respond);
  assert.match(ui.document.querySelector("main").textContent,/今天這一餐/);
  assert.ok(ui.calls.some(call=>call.path==="/api/nearby/catalog"));
  assert.ok(ui.calls.every(call=>!call.path.includes("openstreetmap")));
  assert.equal(ui.document.querySelectorAll("iframe").length,0);
});
test("OSM source and street map each require an explicit consent action",async()=>{
  const ui=await startUI(directory,fixtures().respond);
  await ui.click('[data-source="osm"]');
  assert.ok(ui.document.querySelector("#external-dialog").hasAttribute("open"));
  assert.ok(!ui.calls.some(call=>call.path.includes("openstreetmap")));
  await ui.click("#external-confirm");
  assert.equal(ui.calls.find(call=>call.path.includes("openstreetmap")).body.external_consent,true);
  assert.match(ui.document.querySelector("main").textContent,/OpenStreetMap contributors/);
  await ui.click('[data-action="external-map"]');
  assert.equal(ui.document.querySelectorAll("iframe").length,0);
  await ui.click("#external-confirm");
  const source=ui.document.querySelector("iframe").getAttribute("src");
  assert.match(source,/^https:\/\/www.openstreetmap.org\/export\/embed.html/);
  assert.ok(!source.includes("marker="));
});
test("Radius filter posts coordinates in a body rather than the URL",async()=>{
  const ui=await startUI(directory,fixtures().respond);
  const options=ui.document.querySelectorAll('[name="radius_m"] option');
  options.forEach(option=>option.selected=option.value==="5000");
  await ui.submit("#discover-filter");
  const request=ui.calls.filter(call=>call.path==="/api/nearby/catalog").at(-1);
  assert.equal(request.body.radius_m,5000);
  assert.equal(request.method,"POST");
  assert.ok(!request.path.includes("latitude"));
});
test("Logout clears private room text even when the next catalog request fails",async()=>{
  const fixture=fixtures();fixture.login();
  const ui=await startUI(directory,fixture.respond,"#view=rooms&room=room1");
  assert.match(ui.document.querySelector("main").textContent,/私人午餐名稱/);
  await ui.click("#logout");
  assert.ok(!ui.document.body.textContent.includes("私人午餐名稱"));
  assert.equal(ui.document.querySelector("#identity").textContent,"訪客");
});
