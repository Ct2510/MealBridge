import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const source=readFileSync(new URL("./sw.js",import.meta.url),"utf8");
function worker(online=true) {
  const handlers={};
  const requests=[];
  const cached={offline:true};
  const context={
    URL,
    self:{location:{origin:"https://portfolio.example"},clients:{claim:async()=>{}},
      addEventListener:(type,handler)=>{handlers[type]=handler;}},
    caches:{open:async()=>({addAll:async paths=>{requests.push(...paths);}}),
      keys:async()=>[],delete:async()=>true,match:async path=>{requests.push(path);return cached;}},
    fetch:async()=>{if(!online)throw new Error("offline");return {online:true};}
  };
  vm.runInNewContext(source,context);
  return {handlers,requests,cached};
}
test("PWA manifest and actual PNG dimensions",()=>{
  const manifest=JSON.parse(readFileSync(new URL("./manifest.webmanifest",import.meta.url),"utf8"));
  assert.equal(manifest.display,"standalone");
  assert.equal(manifest.start_url,"/");
  for(const size of [192,512]){
    const icon=manifest.icons.find(item=>item.sizes===size+"x"+size);
    assert.ok(icon);
    const bytes=readFileSync(new URL("."+icon.src,import.meta.url));
    assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);
  }
});
test("Install caches only explicitly public shell",async()=>{
  const {handlers,requests}=worker();
  let completion;
  handlers.install({waitUntil:promise=>{completion=promise;}});
  await completion;
  assert.ok(requests.includes("/"));
  assert.ok(requests.every(path=>!path.startsWith("/api/")));
});
test("Private API, mutations and foreign origins are never intercepted",()=>{
  const {handlers}=worker(false);
  for(const [url,method] of [["https://portfolio.example/api/me","GET"],["https://portfolio.example/api/events","POST"],["https://other.example/app.js","GET"],["https://portfolio.example/","POST"]]){
    let intercepted=false;
    handlers.fetch({request:{url,method},respondWith:()=>{intercepted=true;}});
    assert.equal(intercepted,false);
  }
});
test("Public shell has an offline fallback",async()=>{
  const {handlers,cached}=worker(false);
  let response;
  handlers.fetch({request:{url:"https://portfolio.example/app.js",method:"GET"},respondWith:promise=>{response=promise;}});
  assert.equal(await response,cached);
});
test("Network remains authoritative while online",async()=>{
  const {handlers,requests}=worker(true);
  let response;
  handlers.fetch({request:{url:"https://portfolio.example/",method:"GET"},respondWith:promise=>{response=promise;}});
  assert.equal((await response).online,true);assert.equal(requests.length,0);
});

function locationClient(){
  const context={};
  vm.runInNewContext(readFileSync(new URL("./geolocation.js",import.meta.url),"utf8"),context);
  return context.MealLocation;
}
test("Geolocation success rounds coordinates and does not silently request on load",async()=>{
  const client=locationClient();
  let calls=0,options;
  const result=await client.locate({getCurrentPosition:(success,failure,settings)=>{
    calls++;options=settings;success({coords:{latitude:25.033123,longitude:121.565489,accuracy:37.8}});
  }},true);
  assert.equal(calls,1);assert.equal(result.latitude,25.033);assert.equal(result.longitude,121.565);
  assert.equal(result.accuracy,38);assert.equal(options.timeout,12000);
});
for(const code of [1,2,3])test("Geolocation error "+code+" gives a manual alternative",async()=>{
  await assert.rejects(locationClient().locate({getCurrentPosition:(success,failure)=>failure({code})},true),/手動/);
});
test("Geolocation needs a secure context and support",async()=>{
  await assert.rejects(locationClient().locate({},false),/HTTPS/);
  await assert.rejects(locationClient().locate(null,true),/不支援/);
});
test("Invalid device coordinates are rejected",async()=>{
  await assert.rejects(locationClient().locate({getCurrentPosition:success=>success({coords:{latitude:NaN,longitude:0}})},true),/無效/);
});
test("Nearby requests never enter the offline cache",()=>{
  const {handlers}=worker(false);
  let intercepted=false;
  handlers.fetch({request:{url:"https://portfolio.example/api/nearby/openstreetmap",method:"POST"},respondWith:()=>{intercepted=true;}});
  assert.equal(intercepted,false);
});

