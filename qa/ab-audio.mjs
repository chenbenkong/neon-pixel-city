import { spawn } from 'node:child_process';
import { join } from 'node:path';
const D='C:/Users/moli/WorkBuddy/2026-09-26-23-23-41/qa';
const EDGE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
class C{constructor(ws){this.ws=ws;this.id=0;this.p=new Map();ws.addEventListener('message',e=>{let m;try{m=JSON.parse(e.data)}catch{return}if(m.id!==undefined&&this.p.has(m.id)){const h=this.p.get(m.id);this.p.delete(m.id);m.error?h.rej(new Error(JSON.stringify(m.error))):h.res(m.result)}})}
send(m,p={}){const id=(this.id+=1);return new Promise((res,rej)=>{this.p.set(id,{res,rej});this.ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(this.p.has(id)){this.p.delete(id);rej(new Error('t/o'))}},60000)})}
async eval(x){const r=await this.send('Runtime.evaluate',{expression:x,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails).slice(0,200));return r.result.value}}
const kd=(c,code,vk)=>c.send('Input.dispatchKeyEvent',{type:'rawKeyDown',code,key:code.replace('Key','').toLowerCase(),windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk});
const ku=(c,code,vk)=>c.send('Input.dispatchKeyEvent',{type:'keyUp',code,key:code.replace('Key','').toLowerCase(),windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk});
const tap=async(c,code,vk,ms=50)=>{await kd(c,code,vk);await sleep(ms);await ku(c,code,vk)};
async function we(p){const d=Date.now()+30000;while(Date.now()<d){try{const r=await fetch('http://127.0.0.1:'+p+'/json/version');if(r.ok)return r.json()}catch{}await sleep(300)}throw 0}
const P=9650;
const edge=spawn(EDGE,['--headless=new','--remote-debugging-port='+P,'--user-data-dir='+join(D,'.edge-ab'+Date.now()),'--window-size=1280,720','--mute-audio','--no-first-run','--use-gl=angle','--use-angle=d3d11','about:blank'],{stdio:'ignore'});
try{
await we(P);
const list=await(await fetch('http://127.0.0.1:'+P+'/json/list')).json();
const ws=new WebSocket(list.find(t=>t.type==='page').webSocketDebuggerUrl);
await new Promise((r,j)=>{ws.addEventListener('open',r);ws.addEventListener('error',j)});
const c=new C(ws);
await c.send('Page.enable');await c.send('Runtime.enable');
await c.send('Page.navigate',{url:'http://127.0.0.1:8180/'});
await sleep(11000);
await c.eval("(function(){var b=document.getElementById('enter');if(b){b.disabled=false;b.click();}return 1;})()");
await sleep(5000);
async function run(label){
  await c.eval("(function(){var c=window.__neonDebug.city2d;c.enemies.reset();for(var i=0;i<7;i++)c.enemies.spawn(c.player.x+40+i*40,{});return 1;})()");
  await kd(c,'KeyD',68);
  for(let i=0;i<30;i++){await tap(c,'KeyJ',74);await sleep(140);}
  await ku(c,'KeyD',68);
  const p=JSON.parse(await c.eval('JSON.stringify(window.__neonDebug.stats.perf)'));
  console.log(label, 'avg='+p.avg.toFixed(2)+'ms p95='+p.p95.toFixed(2));
  return p.avg;
}
const withAudio = await run('有音效  ');
await sleep(3000);
// 把所有 sfx 入口打成空函数，只留画面
await c.eval("(function(){var A=window.__neonDebug.audio;window.__bak={};['sfxSwing','sfxHit','sfxKill','sfxHurt','sfxInvuln','sfxCombo','sfxWaveStart','sfxWaveClear','sfxDeath','sfxShard','sfxUiConfirm','sfxComboBreak'].forEach(function(k){window.__bak[k]=A[k];A[k]=function(){};});return 1;})()");
const noAudio = await run('无音效  ');
await c.eval("(function(){var A=window.__neonDebug.audio;for(var k in window.__bak)A[k]=window.__bak[k];return 1;})()");
console.log('差值 = ' + (withAudio - noAudio).toFixed(2) + 'ms');
}finally{try{spawn('taskkill',['/F','/T','/PID',String(edge.pid)],{stdio:'ignore'})}catch{}}
