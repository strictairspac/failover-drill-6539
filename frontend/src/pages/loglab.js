import * as sim from '../utils/logsim.js';
import {esc} from '../utils/html.js';

// 日志空间沙盘：全部状态在模块级，持久化到 localStorage，中断（刷新/崩溃重启）后原样恢复。
const KEY='loglab-v1';
const ls=typeof localStorage==='undefined'?{getItem:()=>null,setItem:()=>{},removeItem:()=>{}}:localStorage;
let st,events,seq,lastReq,traffic,speed,running=true,timer=null;

function fresh(){
 st=sim.createState();events=[];seq=0;lastReq=null;traffic=false;speed=600;
 pushEvents([
  {type:'system',text:`沙盘就绪：日志容量 ${st.capacity}B；R1 为重点副本（未确认的日志必须保留），R2/R3 为普通副本`},
  {type:'system',text:'建议剧本：开自动流量 → 暂停 R2 → 看写入为何等待 → 将 R2 转全量重建腾空间'},
 ]);
}
function load(){
 const raw=ls.getItem(KEY);
 if(!raw){fresh();return;}
 try{
  const d=JSON.parse(raw);
  st=d.st;events=d.events||[];seq=d.seq||0;lastReq=d.lastReq||null;traffic=!!d.traffic;speed=d.speed||600;
  pushEvents([{type:'system',text:'重启完成：从中断点恢复 —— LSN、副本位点、等待队列与去重表均与中断前一致'}]);
 }catch(e){fresh();}
}
function save(){try{ls.setItem(KEY,JSON.stringify({st,events:events.slice(0,200),seq,lastReq,traffic,speed}));}catch(e){}}
function pushEvents(evs){for(const e of evs)events.unshift({tick:st.tick,type:e.type,text:e.text});if(events.length>200)events.length=200;}
load();

function writeOnce(){
 seq++;const reqId='w-'+seq,size=30+Math.floor(Math.random()*150);
 lastReq={reqId,size};
 pushEvents(sim.submitWrite(st,reqId,size).events);
}
function tickOnce(){
 if(traffic&&Math.random()<0.8)writeOnce(); // 追加与副本确认在同一拍内并发推进
 pushEvents(sim.step(st));
 save();paint();
}
function ensureTimer(){
 if(timer)return;
 timer=setInterval(()=>{
  if(!document.querySelector('#sim-dynamic')){clearInterval(timer);timer=null;return;}
  if(running)tickOnce();
 },speed);
}
function retime(){if(timer){clearInterval(timer);timer=null;}ensureTimer();}
function paint(){const el=typeof document==='undefined'?null:document.querySelector('#sim-dynamic');if(el){el.innerHTML=dynamic();bindDynamic();}}

const pct=(v,t)=>Math.min(100,Math.max(0,v/t*100)).toFixed(2)+'%';

function strip(){
 const floor=sim.floorLsn(st),span=st.capacity,N=120;
 const buckets=new Array(N).fill(0); // 0 空闲 1 可回收 2 普通副本钉住 3 重点副本钉住
 for(const e of st.entries){
  const end=e.lsn+e.size;let s=1;
  for(const r of st.replicas)
   if((r.state==='streaming'||r.state==='rebuilding')&&r.confirmed<end)s=Math.max(s,r.key?3:2);
  const a=Math.max(0,Math.floor((e.lsn-floor)/span*N)),b=Math.min(N-1,Math.floor((end-0.001-floor)/span*N));
  for(let i=a;i<=b;i++)buckets[i]=Math.max(buckets[i],s);
 }
 let h='<div class="strip">';
 for(let i=0;i<N;i++)if(buckets[i])h+=`<i class="b${buckets[i]}" style="left:${(i/N*100).toFixed(2)}%;width:${(100/N).toFixed(2)}%"></i>`;
 for(const r of st.replicas){
  const pos=Math.min(1,Math.max(0,(r.confirmed-floor)/span));
  h+=`<div class="mark m${esc(r.id.slice(-1))}" style="left:${(pos*100).toFixed(2)}%"><span>${esc(r.id)}</span></div>`;
 }
 return h+'</div>';
}

function repCard(r){
 const lag=sim.lagOf(st,r),cand=sim.isCandidate(r);
 const stateTxt=r.state==='rebuilding'?`重建中 ${Math.round(r.progress)}%`:(r.paused?'已暂停':'追赶中');
 const note=r.state==='rebuilding'
  ?`快照点 LSN ${r.snapshotLsn}，完成后从该点续追；完成前不可参选`
  :r.paused?`已暂停确认，仍钉住 LSN ${r.confirmed}`
  :lag?`可继续追赶，落后 ${lag}B`:'已追平，可继续跟随';
 const btns=[];
 if(r.state==='streaming')btns.push(`<button class="secondary" data-pause="${esc(r.id)}">${r.paused?'恢复追赶':'暂停追赶'}</button>`);
 if(!r.key&&r.state==='streaming')btns.push(`<button class="secondary" data-rebuild="${esc(r.id)}">转全量重建</button>`);
 return `<div class="rep">
  <div class="rep-top"><b>${esc(r.id)} · ${r.key?'重点副本':'普通副本'}</b>
   <span class="badge">${stateTxt}</span>
   <span class="badge ${cand?'completed':'failed'}">${cand?'可参选':'不可参选'}</span></div>
  <div class="rep-meta">确认位点 LSN ${r.confirmed} · 落后 ${lag}B · 确认速度 ${r.rate}B/拍</div>
  ${r.state==='rebuilding'?`<div class="capbar slim"><i style="width:${pct(r.progress,100)}"></i></div>`:''}
  <div class="rep-note">${note}</div>
  ${btns.length?`<div class="rep-btns">${btns.join('')}</div>`:''}
 </div>`;
}

function whoSummary(){
 const ok=[],no=[];
 for(const r of st.replicas){
  if(r.state==='rebuilding')no.push(`${r.id}（重建中）`);
  else if(r.paused)no.push(`${r.id}（已暂停）`);
  else ok.push(r.id);
 }
 return `可接着追：${ok.join('、')||'无'} · 暂不可：${no.join('、')||'无'}`;
}

function pendingList(){
 if(!st.pending.length)return '<p class="empty">没有等待中的写入。空间腾不出来时，写入会在此排队并说明原因。</p>';
 return st.pending.map(w=>`<div class="wait"><b>⏳ ${esc(w.reqId)}</b> · ${w.size}B<div>${esc(sim.waitReason(st,w.size))}</div></div>`).join('');
}

const EV_LABEL={append:'落盘',confirm:'确认',recycle:'回收',wait:'等待',dup:'幂等',rebuild:'重建','rebuild-done':'重建',pause:'暂停',resume:'恢复',error:'拒绝',system:'系统'};

function dynamic(){
 const used=sim.usedBytes(st),floor=sim.floorLsn(st),recyclable=sim.recyclableBytes(st);
 return `
 <div class="section-title"><h2>主库复制日志</h2><span>第 ${st.tick} 拍 · 去重表 ${Object.keys(st.dedup).length} 条 · 累计回收 ${st.recycledBytes}B</span></div>
 <div class="sim-stats">
  <div><b>${used} / ${st.capacity}B</b>已用 / 空间上限</div>
  <div><b>${st.capacity-used}B</b>空闲</div>
  <div><b>${recyclable}B</b>可回收（全体已确认）</div>
  <div><b>LSN ${floor}</b>保留基线</div>
  <div><b>LSN ${st.head}</b>最新写入位点</div>
 </div>
 <div class="capbar"><i style="width:${pct(used,st.capacity)}"></i><em style="width:${pct(recyclable,st.capacity)}"></em></div>
 ${strip()}
 <div class="strip-axis"><span>保留基线 LSN ${floor}</span><span>窗口 = 基线 + 容量 ${st.capacity}B</span></div>
 <div class="legend"><span><i class="lg1"></i>全体已确认，可回收</span><span><i class="lg2"></i>普通副本未确认</span><span><i class="lg3"></i>重点副本未确认</span><span><i class="lg4"></i>空闲空间</span></div>
 ${st.pending.length?`<div class="notice error">写入为何等待：${esc(sim.waitReason(st,st.pending[0].size))}</div>`:''}
 <div class="split">
  <div><div class="section-title"><h2>副本</h2><span>${whoSummary()}</span></div>${st.replicas.map(repCard).join('')}</div>
  <div><div class="section-title"><h2>等待队列</h2><span>${st.pending.length} 笔等待</span></div>${pendingList()}</div>
 </div>
 <div class="section-title"><h2>事件流</h2><span>最新在最上 · 共 ${events.length} 条</span></div>
 <div class="evlog">${events.slice(0,60).map(e=>`<div class="ev ev-${esc(e.type)}"><span>[${e.tick}·${EV_LABEL[e.type]||'事件'}]</span>${esc(e.text)}</div>`).join('')||'<p class="empty">暂无事件</p>'}</div>`;
}

function controls(){
 return `<div class="sim-controls">
 <div class="toolbar">
  <button id="sim-append">追加一笔</button>
  <button id="sim-burst" class="secondary">突发 5 笔</button>
  <button id="sim-retry" class="secondary">重试上一笔（幂等）</button>
  <button id="sim-step" class="secondary">单步一拍</button>
 </div>
 <div class="sim-opts">
  <label class="check"><input id="sim-traffic" type="checkbox" ${traffic?'checked':''}> 自动流量</label>
  <label class="check"><input id="sim-run" type="checkbox" ${running?'checked':''}> 自动运行</label>
  <label>节奏 <input id="sim-speed" type="range" min="150" max="1200" step="50" value="${speed}"></label>
  <label>日志容量 <input id="sim-cap" type="range" min="1200" max="6000" step="100" value="${st.capacity}"> <span id="sim-cap-val">${st.capacity}B</span></label>
 </div>
 <div class="toolbar">
  <button id="sim-scn-r2" class="secondary">夜班剧本 · R2 停摆</button>
  <button id="sim-scn-r1" class="secondary">重点副本 R1 停摆</button>
  <button id="sim-crash" class="secondary">模拟崩溃并重启</button>
  <button id="sim-reset" class="secondary">重置沙盘</button>
 </div></div>`;
}

export function loglabPage(){
 return `<div id="loglab-root"><div id="sim-dynamic">${dynamic()}</div>${controls()}</div>`;
}

function bindDynamic(){
 document.querySelectorAll('[data-pause]').forEach(b=>b.onclick=()=>{
  const r=st.replicas.find(x=>x.id===b.dataset.pause);
  if(r){pushEvents(sim.setPaused(st,r.id,!r.paused));save();paint();}
 });
 document.querySelectorAll('[data-rebuild]').forEach(b=>b.onclick=()=>{
  pushEvents(sim.convertToRebuild(st,b.dataset.rebuild).events);save();paint();
 });
}

function bindControls(){
 const q=s=>document.querySelector(s);
 q('#sim-append').onclick=()=>{writeOnce();save();paint();};
 q('#sim-burst').onclick=()=>{for(let i=0;i<5;i++)writeOnce();save();paint();};
 q('#sim-retry').onclick=()=>{
  if(!lastReq)pushEvents([{type:'error',text:'还没有可重试的写入，先追加一笔'}]);
  else pushEvents(sim.submitWrite(st,lastReq.reqId,lastReq.size).events);
  save();paint();
 };
 q('#sim-step').onclick=()=>tickOnce();
 q('#sim-traffic').onchange=e=>{traffic=e.target.checked;pushEvents([{type:'system',text:traffic?'自动流量开启':'自动流量关闭'}]);save();paint();};
 q('#sim-run').onchange=e=>{running=e.target.checked;};
 q('#sim-speed').oninput=e=>{speed=Number(e.target.value);retime();save();};
 q('#sim-cap').oninput=e=>{st.capacity=Number(e.target.value);q('#sim-cap-val').textContent=st.capacity+'B';pushEvents([{type:'system',text:`日志容量调整为 ${st.capacity}B`}]);save();paint();};
 q('#sim-scn-r2').onclick=()=>{pushEvents(sim.setPaused(st,'R2',true));traffic=true;q('#sim-traffic').checked=true;pushEvents([{type:'system',text:'夜班剧本：R2 停摆、流量继续，观察空间如何被钉死'}]);save();paint();};
 q('#sim-scn-r1').onclick=()=>{pushEvents(sim.setPaused(st,'R1',true));traffic=true;q('#sim-traffic').checked=true;pushEvents([{type:'system',text:'重点副本 R1 停摆：它未确认的日志必须保留，写满后写入只能等'}]);save();paint();};
 q('#sim-crash').onclick=()=>{pushEvents([{type:'system',text:'模拟崩溃：主库进程终止，已落盘日志与去重表保留在持久层'}]);save();setTimeout(()=>location.reload(),250);};
 q('#sim-reset').onclick=()=>{ls.removeItem(KEY);fresh();save();q('#sim-traffic').checked=false;q('#sim-cap').value=st.capacity;q('#sim-cap-val').textContent=st.capacity+'B';q('#sim-speed').value=speed;retime();paint();};
}

export function bindLoglab(){
 bindControls();
 bindDynamic();
 ensureTimer();
}

// 供单测在无 DOM 环境下驱动页面状态（页面本身不使用）
export const __test={state:()=>st,writeOnce,tickOnce};
