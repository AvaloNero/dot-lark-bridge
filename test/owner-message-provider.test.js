import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { makeOwnerMessageProvider } from '../src/owner-message-provider.js';
for(const bounded of [true,false])test(`candidate cancellation aborts queued provider write ${bounded?'with a deadline':'while waiting for the owner'}`,async()=>{
 let writes=0,destroyed=0;
 const send=makeOwnerMessageProvider({...(bounded?{deadlineMs:Date.now()+1000}:{}),proxyEnv:{},agentFactory:()=>({destroy(){destroyed++;}}),request(_url,options){
  const req=new EventEmitter();let timer;
  options.signal.addEventListener('abort',()=>{clearTimeout(timer);const error=new Error('synthetic abort');error.code='ABORT_ERR';req.emit('error',error);},{once:true});
  req.end=()=>{timer=setTimeout(()=>{writes++;},40);};req.destroy=error=>{clearTimeout(timer);if(error)req.emit('error',error);};return req;
 }});
 const pending=send('https://open.feishu.cn/open-apis/im/v1/messages/m/reply',{purpose:'provider',hosts:['open.feishu.cn'],headers:{},body:Buffer.from('{}'),beforeConnect(){}});
 send.close();await assert.rejects(pending);await new Promise(resolve=>setTimeout(resolve,60));assert.equal(writes,0);assert.equal(destroyed,1);
 await assert.rejects(async()=>send('https://open.feishu.cn/x',{purpose:'provider',hosts:['open.feishu.cn']}));
});
test('provider without an overall deadline still authorizes each request after a long owner wait',async()=>{
 let now=Date.now(),calls=0,gates=0,destroyed=0;
 const send=makeOwnerMessageProvider({clock:()=>now,proxyEnv:{},agentFactory:()=>({destroy(){destroyed++;}}),request(_url,options,receive){
  calls++;assert.equal(options.signal.aborted,false);const req=new EventEmitter();req.destroy=error=>req.emit('error',error);
  req.end=()=>queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=200;res.headers={};receive(res);res.emit('data',Buffer.from('{}'));res.emit('end');});return req;
 }});
 const options={purpose:'provider',hosts:['open.feishu.cn'],body:Buffer.from('{}'),beforeConnect(){gates++;}};
 try{
  now+=16*60000;assert.equal((await send('https://open.feishu.cn/x',options)).status,200);
  now+=16*60000;assert.equal((await send('https://open.feishu.cn/x',options)).status,200);
  await assert.rejects(send('https://open.feishu.cn/x',{...options,beforeConnect(){throw Error('scope revoked');}}));
  assert.equal(calls,2);assert.equal(gates,2);assert.equal(destroyed,3);
 }finally{send.close();}
 assert.throws(()=>send('https://open.feishu.cn/x',options));
});
test('an explicitly provided provider deadline must still be valid',()=>{
 const now=Date.now();for(const deadlineMs of [null,NaN,0,now,now+900001])assert.throws(()=>makeOwnerMessageProvider({deadlineMs,clock:()=>now}));
});
test('candidate provider rejects non-provider route and expired scope before request',()=>{
 let calls=0;let now=Date.now();const send=makeOwnerMessageProvider({deadlineMs:now+1000,clock:()=>now,request(){calls++;}});
 assert.throws(()=>send('https://example.com',{purpose:'callback'}));now+=1000;assert.throws(()=>send('https://open.feishu.cn/x',{purpose:'provider'}));assert.equal(calls,0);send.close();
});

test('expired gateway aborts only its queued discovery request and renewal can request again',async()=>{
 let writes=0,requests=0;
 const send=makeOwnerMessageProvider({proxyEnv:{},agentFactory:()=>({destroy(){}}),request(_url,options,onResponse){
  requests++;const req=new EventEmitter();let timer;
  options.signal.addEventListener('abort',()=>{clearTimeout(timer);req.emit('error',Object.assign(new Error('cancelled'),{code:'ABORT_ERR'}));},{once:true});
  req.destroy=error=>{clearTimeout(timer);if(error)req.emit('error',error);};
  req.end=()=>{timer=setTimeout(()=>{writes++;const res=new EventEmitter();res.statusCode=200;res.headers={};onResponse(res);res.emit('data',Buffer.from('{}'));res.emit('end');},30);};return req;
 }});
 const old=new AbortController();const options={purpose:'provider',hosts:['open.feishu.cn'],body:Buffer.from('{}')};
 const pending=send('https://open.feishu.cn/callback/ws/endpoint',{...options,signal:old.signal});old.abort();await assert.rejects(pending);
 const current=new AbortController();const result=await send('https://open.feishu.cn/callback/ws/endpoint',{...options,signal:current.signal});assert.equal(result.status,200);assert.equal(requests,2);assert.equal(writes,1);send.close();
});
