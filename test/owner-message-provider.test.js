import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { makeOwnerMessageProvider } from '../src/owner-message-provider.js';
test('candidate cancellation aborts queued provider write using native request signal',async()=>{
 let writes=0,destroyed=0;
 const send=makeOwnerMessageProvider({deadlineMs:Date.now()+1000,proxyEnv:{},agentFactory:()=>({destroy(){destroyed++;}}),request(_url,options){
  const req=new EventEmitter();let timer;
  options.signal.addEventListener('abort',()=>{clearTimeout(timer);const error=new Error('synthetic abort');error.code='ABORT_ERR';req.emit('error',error);},{once:true});
  req.end=()=>{timer=setTimeout(()=>{writes++;},40);};req.destroy=error=>{clearTimeout(timer);if(error)req.emit('error',error);};return req;
 }});
 const pending=send('https://open.feishu.cn/open-apis/im/v1/messages/m/reply',{purpose:'provider',hosts:['open.feishu.cn'],headers:{},body:Buffer.from('{}'),beforeConnect(){}});
 send.close();await assert.rejects(pending);await new Promise(resolve=>setTimeout(resolve,60));assert.equal(writes,0);assert.equal(destroyed,1);
 await assert.rejects(async()=>send('https://open.feishu.cn/x',{purpose:'provider',hosts:['open.feishu.cn']}));
});
test('candidate provider rejects non-provider route and expired scope before request',()=>{
 let calls=0;let now=Date.now();const send=makeOwnerMessageProvider({deadlineMs:now+1000,clock:()=>now,request(){calls++;}});
 assert.throws(()=>send('https://example.com',{purpose:'callback'}));now+=1000;assert.throws(()=>send('https://open.feishu.cn/x',{purpose:'provider'}));assert.equal(calls,0);send.close();
});
