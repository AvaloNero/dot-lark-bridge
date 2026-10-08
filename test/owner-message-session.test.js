import { createOwnerMessageRuntime } from '../src/owner-message-runtime.js';
import { mcpRequest } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLarkOwnerMessageSession } from '../src/owner-message-session.js';
const source=process.env.OWNER_MESSAGE_TRANSPORT_SOURCE ?? fileURLToPath(new URL('../../dot-qq-bridge/packages/dot-bridge-transport/experimental/owner-message.js', import.meta.url));
const credentials={version:1,status:'paired',appId:'cli_0123456789abcdef',appSecret:'synthetic-app-secret',tenantKey:'tenant',ownerOpenId:'owner',ownerChatId:'chat'};
function event(now,text='exact test'){return{schema:'2.0',header:{event_id:'e',event_type:'im.message.receive_v1',create_time:String(now),app_id:credentials.appId,tenant_key:'tenant'},event:{sender:{sender_id:{open_id:'owner'},sender_type:'user',tenant_key:'tenant'},message:{message_id:'m',chat_id:'chat',chat_type:'p2p',message_type:'text',create_time:String(now),content:JSON.stringify({text})}}};}
async function run(makeTransport,recognize,{failReply=false,cancelAfterEvent=false,cancelDuringReply=false,httpEntry=false,anyText=false}={}){
 const now=Date.now(),deadlineMs=now+60000,proxyEnv={HTTPS_PROXY:'http://proxy.example:8080'},calls=[];let providerReplies=0;
 const callbackTransport=makeTransport({approvedOwnerMessageExperiment:true,channel:'lark',...(anyText?{acceptAnyOwnerText:true}:{expectedText:'exact test'}),deadlineMs,proxyEnv,now:()=>now,connect:async(_url,_proxy,request)=>{
  await request.beforeConnect?.();const body=JSON.parse(request.body.toString());calls.push(body.type==='verification'?'challenge':body.name);
  return{status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(body.type==='verification'?{challenge:body.challenge}:{}))};
 }});
 const session=createLarkOwnerMessageSession({credentials,expectedAppId:credentials.appId,...(anyText?{acceptAnyOwnerText:true}:{expectedText:'exact test'}),fixedReply:'fixed reply',authenticatedCallbackDiscovery:true,callbackTransport,recognizeTransport:recognize,proxyEnv,deadlineMs,clock:()=>now,providerSend:async(url,options)=>{
  options.beforeConnect();
  if(url.endsWith('/tenant_access_token/internal'))return{status:200,body:Buffer.from(JSON.stringify({code:0,tenant_access_token:'synthetic-token',expire:7200}))};
  assert.equal(url,'https://open.feishu.cn/open-apis/im/v1/messages/m/reply');assert.equal(JSON.parse(JSON.parse(options.body).content).text,'fixed reply');providerReplies++;if(cancelDuringReply)session.close();if(failReply)throw new Error('synthetic-private-error');
  return{status:200,body:Buffer.from(JSON.stringify({code:0,data:{message_id:'reply',chat_id:'chat'}}))};
 }});
 const principal={id:'tunnel-owner:dot-bridge',validUntil:deadlineMs};
 if(httpEntry){
  let dispatcher,closed=0,released=0;
  const runtime=createOwnerMessageRuntime({session,approved:true,deadlineMs,clock:()=>now,authConfig:{authMode:'tunnel-service',tunnelServiceOperation:'readiness',principal:'tunnel-owner:dot-bridge',host:'127.0.0.1',port:0},connectionConfig:{larkAppId:credentials.appId},lockDirectory:'/unused-synthetic',authenticateFactory:()=>async req=>{if(req.headers['x-test-auth']!=='owner')throw Error();return principal;},modeLock:()=>()=>{released++;},connectionFactory:(_config,target,options)=>{assert.equal(options.autoReconnect,false);dispatcher=target;return{async start(){},close(){closed++;}};}});
  const address=await runtime.start();
  const call=async(method,params,auth='owner')=>{const request=mcpRequest(method,params);const res=await fetch(`http://127.0.0.1:${address.port}/mcp`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28','mcp-method':method,...(method==='tools/call'?{'mcp-name':params.name}:{}),'x-test-auth':auth},body:JSON.stringify(request)});return{status:res.status,body:await res.json()};};
  try{
   assert.equal((await call('events/list',{},'stranger')).status,400);assert.equal(calls.length,0);
   assert.equal((await call('events/subscribe',{name:'lark.message.created',arguments:{conversation:'owner'},delivery:{mode:'webhook',url:'https://receiver.example.com/private-callback',secret:'whsec_'+Buffer.alloc(32,7).toString('base64')}})).status,200);
   assert.equal((await dispatcher.invoke(event(now))).outcome,'delivered');
   const unauthorized=await call('tools/call',{name:'check_lark_setup',arguments:{}},'stranger');assert.equal(unauthorized.status,400);assert.equal(JSON.stringify(unauthorized.body).includes('message_id'),false);
   const recovered=await call('tools/call',{name:'check_lark_setup',arguments:{}});assert.deepEqual(recovered.body.result.structuredContent.pending_message,{message_id:'m',reply_deadline:new Date(now+60000).toISOString()});assert.equal(JSON.stringify(recovered.body).includes('exact test'),false);
   const replied=await call('tools/call',{name:'reply_to_lark',arguments:{message_id:'m',text:'fixed reply'}});assert.equal(replied.status,200);assert.equal(providerReplies,1);
   assert.deepEqual(calls,['challenge','lark.message.created']);
  }finally{await runtime.close();assert.ok(closed>=1);assert.equal(released,1);callbackTransport.close?.();}
  return;
 }

 await assert.rejects(session.subscribe({url:'https://receiver.example.com/private-callback',secret:'whsec_'+Buffer.alloc(32,7).toString('base64')},{id:'stranger',validUntil:deadlineMs}));assert.equal(calls.length,0);
 await session.subscribe({url:'https://receiver.example.com/private-callback',secret:'whsec_'+Buffer.alloc(32,7).toString('base64')},principal);
 if(anyText){const wrong=event(now,'任意文字');wrong.event.sender.sender_id.open_id='stranger';assert.equal((await session.receive(wrong)).outcome,'rejected');}else assert.equal((await session.receive(event(now,'not exact'))).outcome,'rejected');assert.equal(calls.length,1);
 assert.equal((await session.receive(event(now,anyText?'来了，随便一句普通话':'exact test'))).outcome,'delivered');
 if(cancelAfterEvent){session.close();await assert.rejects(session.reply('m','fixed reply',principal));assert.equal(providerReplies,0);callbackTransport.close?.();return;}
 await assert.rejects(session.reply('m','arbitrary',principal));assert.equal(providerReplies,0);
 assert.equal((await session.reply('m','fixed reply',principal)).status,(failReply||cancelDuringReply)?'uncertain':'sent');await assert.rejects(session.reply('m','fixed reply',principal));
 assert.deepEqual(calls,['challenge','lark.message.created']);assert.equal(providerReplies,1);assert.equal(session.status().ordinary_callback_ready,false);
 session.close();callbackTransport.close?.();
}
test('isolated candidate exercises signed challenge, verified inbound event and fixed-message reply with inert adapters',async()=>{
 await run(options=>async(url,request)=>options.connect(url,{},request),()=>({mode:'owner_single_message_proxy',ready:true}));
});
test('shared reviewed owner transport drives complete candidate path without live network',{},async()=>{
 const shared=await import(pathToFileURL(source));await run(shared.makeOwnerMessageExperimentTransport,shared.ownerMessageExperimentStatus);
});

test('shared scope revocation after event and unknown reply acknowledgements never resend',{},async()=>{
 const shared=await import(pathToFileURL(source));
 await run(shared.makeOwnerMessageExperimentTransport,shared.ownerMessageExperimentStatus,{cancelAfterEvent:true});
 await run(shared.makeOwnerMessageExperimentTransport,shared.ownerMessageExperimentStatus,{failReply:true});
 await run(shared.makeOwnerMessageExperimentTransport,shared.ownerMessageExperimentStatus,{cancelDuringReply:true});
});

test('actual loopback MCP entry drives shared callback and injected WSS lifecycle',{},async()=>{
 const shared=await import(pathToFileURL(source));await run(shared.makeOwnerMessageExperimentTransport,shared.ownerMessageExperimentStatus,{httpEntry:true});
});
test('unconfirmed launcher is plan-only without consulting credential environment',async()=>{
 const {startOwnerMessageCandidate}=await import('../scripts/owner-message-candidate.js');
 const result=await startOwnerMessageCandidate({approved:'false',env:new Proxy({}, {get(){throw Error('must not inspect env');}})});assert.equal(result.credential_read,false);
});
test('runtime refuses unapproved start and safely closes a pending listener without reopening',async()=>{
 let factories=0,released=0;const options={session:{close(){},status(){return{};}},authConfig:{authMode:'tunnel-service',tunnelServiceOperation:'readiness',principal:'tunnel-owner:dot-bridge',host:'127.0.0.1',port:0},connectionConfig:{larkAppId:credentials.appId},deadlineMs:Date.now()+60000,authenticateFactory(){factories++;return async()=>{};},modeLock:()=>()=>{released++;}};
 const refused=createOwnerMessageRuntime({...options,approved:'false'});await assert.rejects(refused.start());assert.equal(factories,0);
 const runtime=createOwnerMessageRuntime({...options,approved:true});const started=runtime.start(),stopped=runtime.close();await Promise.allSettled([started,stopped]);await runtime.close();assert.equal(released,1);await assert.rejects(runtime.start());
});
test('requested subscription TTL is validated and closes gateway before global deadline',async()=>{
 let subscriptions=0,validUntil,closed=0,released=0;const globalDeadline=Date.now()+10000;
 const runtime=createOwnerMessageRuntime({approved:true,deadlineMs:globalDeadline,session:{close(){},status(){return{};},async subscribe(_input,principal){subscriptions++;validUntil=principal.validUntil;return{id:'sub',refreshBefore:new Date(validUntil).toISOString()};}},authConfig:{authMode:'tunnel-service',tunnelServiceOperation:'readiness',principal:'tunnel-owner:dot-bridge',host:'127.0.0.1',port:0},connectionConfig:{larkAppId:credentials.appId},authenticateFactory:()=>async()=>({id:'tunnel-owner:dot-bridge',validUntil:globalDeadline}),modeLock:()=>()=>{released++;},connectionFactory:()=>({async start(){},close(){closed++;}})});
 const address=await runtime.start();
 const call=async ttlMs=>{const request=mcpRequest('events/subscribe',{name:'lark.message.created',arguments:{conversation:'owner'},delivery:{mode:'webhook',url:'https://fixture.example/cb',secret:'synthetic'},ttlMs});return fetch(`http://127.0.0.1:${address.port}/mcp`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28','mcp-method':'events/subscribe'},body:JSON.stringify(request)});};
 try{
  const bad=await call(-1);await bad.text();assert.equal(bad.status,400);assert.equal(subscriptions,0);
  const good=await call(30);await good.text();assert.equal(good.status,200);assert.ok(validUntil<globalDeadline);
  await new Promise(resolve=>setTimeout(resolve,80));assert.ok(closed>=1);assert.equal(released,1);
 }finally{await runtime.close();}
});
test('expired shorter subscription never constructs gateway after callback continuation',async()=>{
 let now=Date.now(),gatewayStarts=0;const deadlineMs=now+60000;
 const runtime=createOwnerMessageRuntime({approved:true,deadlineMs,clock:()=>now,session:{close(){},status(){return{};},async subscribe(_input,principal){const expiry=principal.validUntil;now=expiry+1;return{id:'sub',refreshBefore:new Date(expiry).toISOString()};}},authConfig:{authMode:'tunnel-service',tunnelServiceOperation:'readiness',principal:'tunnel-owner:dot-bridge',host:'127.0.0.1',port:0},connectionConfig:{larkAppId:credentials.appId},authenticateFactory:()=>async()=>({id:'tunnel-owner:dot-bridge',validUntil:deadlineMs}),modeLock:()=>()=>{},connectionFactory:()=>{gatewayStarts++;return{async start(){},close(){}};}});
 const address=await runtime.start();const request=mcpRequest('events/subscribe',{name:'lark.message.created',arguments:{conversation:'owner'},delivery:{mode:'webhook',url:'https://fixture.example/cb',secret:'synthetic'},ttlMs:10});
 try{const result=await fetch(`http://127.0.0.1:${address.port}/mcp`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28','mcp-method':'events/subscribe'},body:JSON.stringify(request)});await result.text();assert.equal(result.status,400);assert.equal(gatewayStarts,0);}finally{await runtime.close();}
});

test('shared experiment relays one verified owner text without prescribed words',{},async()=>{
 const shared=await import(pathToFileURL(source));await run(shared.makeOwnerMessageExperimentTransport,shared.ownerMessageExperimentStatus,{anyText:true});
});

test('waiting runtime survives fifteen minutes and expired lease while gateway pauses until renewal',async()=>{
 let now=Date.now(),starts=0,closed=0,released=0;const reports=[],signals=[];
 const runtime=createOwnerMessageRuntime({approved:true,waitForOwner:true,clock:()=>now,providerSend:async(_url,options)=>{options.beforeConnect();signals.push(options.signal);return{};},session:{close(){},status(){return{incoming_claimed:false};},async subscribe(_input,principal){return{id:'sub',refreshBefore:new Date(principal.validUntil).toISOString()};}},authConfig:{authMode:'tunnel-service',tunnelServiceOperation:'readiness',principal:'tunnel-owner:dot-bridge',host:'127.0.0.1',port:0},connectionConfig:{larkAppId:credentials.appId},authenticateFactory:()=>async()=>({id:'tunnel-owner:dot-bridge',validUntil:now+60000}),modeLock:()=>()=>{released++;},connectionFactory:(_c,_d,options)=>{reports.push(options.report);return{async start(){starts++;await options.send('https://open.feishu.cn/callback/ws/endpoint',{purpose:'provider'});},close(){closed++;}};}});
 const address=await runtime.start();
 const call=async(method,params)=>{const request=mcpRequest(method,params);const response=await fetch(`http://127.0.0.1:${address.port}/mcp`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28','mcp-method':method},body:JSON.stringify(request)});await response.text();return response.status;};
 const params={name:'lark.message.created',arguments:{conversation:'owner'},delivery:{mode:'webhook',url:'https://fixture.example/cb',secret:'synthetic'},ttlMs:30};
 try{
  now+=16*60000;assert.equal(await call('events/list',{}),200);assert.equal(starts,0);
  assert.equal(await call('events/subscribe',params),200);assert.equal(starts,1);
  await new Promise(resolve=>setTimeout(resolve,80));assert.equal(closed,1);assert.equal(released,0);assert.equal(signals[0].aborted,true);
  now+=100;assert.equal(await call('events/list',{}),200);
  assert.equal(await call('events/subscribe',{...params,ttlMs:1000}),200);assert.equal(starts,2);assert.equal(signals[1].aborted,false);
  reports[0]('lark_connection_failed');await new Promise(resolve=>setImmediate(resolve));assert.equal(released,0);
  reports[1]('lark_connection_failed');await new Promise(resolve=>setTimeout(resolve,20));assert.equal(released,1);
 }finally{await runtime.close();}assert.equal(released,1);
});

test('renewable shared session waits for owner, renews only identical binding and never extends accepted message',async()=>{
 const shared=await import(pathToFileURL(source));let now=Date.now(),callbacks=0;
 const proxyEnv={HTTPS_PROXY:'http://proxy.example:8080'};
 const transport=shared.makeOwnerMessageExperimentTransport({approvedOwnerMessageExperiment:true,channel:'lark',acceptAnyOwnerText:true,waitForOwner:true,proxyEnv,now:()=>now,connect:async(_u,_p,r)=>{callbacks++;await r.beforeConnect();const body=JSON.parse(r.body);return{status:200,headers:{},body:Buffer.from(JSON.stringify(body.type==='verification'?{challenge:body.challenge}:{}))};}});
 const session=createLarkOwnerMessageSession({credentials,expectedAppId:credentials.appId,acceptAnyOwnerText:true,fixedReply:'fixed reply',waitForOwner:true,authenticatedCallbackDiscovery:true,callbackTransport:transport,recognizeTransport:shared.ownerMessageExperimentStatus,proxyEnv,providerSend:async()=>{throw Error('no provider');},clock:()=>now});
 const input={url:'https://fixture.example/cb',secret:'whsec_'+Buffer.alloc(32,11).toString('base64url')};
 const principal=()=>({id:'tunnel-owner:dot-bridge',validUntil:now+3600000});
 try{
  now+=16*60000;assert.equal(callbacks,0);
  assert.equal(session.setup().callback_transport.reason,'awaiting_subscription');assert.equal(session.setup().callback_transport.ready,false);assert.equal(session.setup().callback_transport.destination_binding,'unverified');
  await assert.rejects(session.subscribe(input,{id:'stranger',validUntil:now+60000}));assert.equal(callbacks,0);
  const first=await session.subscribe(input,principal());assert.equal(callbacks,1);assert.equal(session.setup().pending_message,null);
  now+=61*60000;
  await assert.rejects(session.receive(event(now,'before renewal')));
  await assert.rejects(session.subscribe({...input,url:'https://other.example/cb'},principal()));
  await assert.rejects(session.subscribe({...input,secret:'whsec_'+Buffer.alloc(32,12).toString('base64url')},principal()));
  const renewed=await session.subscribe(input,principal());assert.equal(renewed.id,first.id);assert.equal(callbacks,1);
  assert.equal((await session.receive(event(now,'普通消息，不是口令'))).outcome,'delivered');assert.equal(callbacks,2);
  const before=session.readMessage('m',principal()).reply_deadline;assert.deepEqual(session.setup().pending_message,{message_id:'m',reply_deadline:before});
  await assert.rejects(session.subscribe(input,principal()));
  assert.equal(session.readMessage('m',principal()).reply_deadline,before);
  now=Date.parse(before)+1;assert.throws(()=>session.readMessage('m',principal()));assert.equal(session.setup().pending_message,undefined);assert.equal(session.setup().callback_transport.reason,'scope_expired');
  session.close();assert.equal(session.setup().callback_transport.reason,'scope_closed');
 }finally{session.close();}
});


test('waiting mode requires literal booleans and never starts for truthy aliases',async()=>{
 let starts=0;
 for(const waitForOwner of [1,'true','false',null]){
  const runtime=createOwnerMessageRuntime({waitForOwner,approved:true,deadlineMs:Date.now()+60000,session:{close(){},status(){return{};}},authConfig:{authMode:'tunnel-service',tunnelServiceOperation:'readiness',principal:'tunnel-owner:dot-bridge',host:'127.0.0.1',port:0},authenticateFactory(){starts++;},connectionFactory(){starts++;}});
  await assert.rejects(runtime.start());
  assert.throws(()=>createLarkOwnerMessageSession({credentials,expectedAppId:credentials.appId,waitForOwner,deadlineMs:Date.now()+60000,callbackHosts:['fixture.example'],callbackTransport:async()=>{},recognizeTransport:()=>{},providerSend:async()=>{}}));
 }
 assert.equal(starts,0);
});

test('late start from an expired gateway cannot close a renewed generation',async()=>{
 for(const rejectOld of [false,true]){
  let settleOld,starts=0,released=0;const closed=[0,0];
  const runtime=createOwnerMessageRuntime({approved:true,waitForOwner:true,session:{close(){},status(){return{incoming_claimed:false};},async subscribe(_i,p){return{id:'sub',refreshBefore:new Date(p.validUntil).toISOString()};}},authConfig:{authMode:'tunnel-service',tunnelServiceOperation:'readiness',principal:'tunnel-owner:dot-bridge',host:'127.0.0.1',port:0},connectionConfig:{larkAppId:credentials.appId},authenticateFactory:()=>async()=>({id:'tunnel-owner:dot-bridge',validUntil:Date.now()+60000}),modeLock:()=>()=>{released++;},connectionFactory:()=>{const index=starts++;return{start(){if(index)return Promise.resolve();return new Promise((resolve,reject)=>{settleOld=()=>rejectOld?reject(Error('synthetic')):resolve();});},close(){closed[index]++;}};}});
  const address=await runtime.start();
  const call=async ttlMs=>{const request=mcpRequest('events/subscribe',{name:'lark.message.created',arguments:{conversation:'owner'},delivery:{mode:'webhook',url:'https://fixture.example/cb',secret:'synthetic'},ttlMs});const response=await fetch(`http://127.0.0.1:${address.port}/mcp`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28','mcp-method':'events/subscribe'},body:JSON.stringify(request)});await response.text();return response.status;};
  try{
   const old=call(30);await new Promise(resolve=>setTimeout(resolve,80));assert.equal(starts,1);assert.ok(closed[0]>=1);
   assert.equal(await call(1000),200);assert.equal(starts,2);
   settleOld();assert.equal(await old,400);await new Promise(resolve=>setImmediate(resolve));assert.equal(closed[1],0);assert.equal(released,0);
  }finally{settleOld?.();await runtime.close();}assert.equal(released,1);assert.ok(closed[1]>=1);
 }
});

test('launcher preserves explicit timed mode and waiting mode never reads the old window',async()=>{
 const {ownerMessagePlan,ownerMessageScope,startOwnerMessageCandidate}=await import('../scripts/owner-message-candidate.js');
 const noRead=new Proxy({}, {get(){throw Error('must not inspect environment');}});
 assert.deepEqual(ownerMessageScope({waitForOwner:true,env:noRead}),{waitForOwner:true});
 assert.deepEqual(ownerMessageScope({waitForOwner:false,env:{OWNER_MESSAGE_WINDOW_SECONDS:'900'},clock:()=>1000}),{waitForOwner:false,deadlineMs:901000});
 assert.equal(ownerMessagePlan().wait_for_owner,false);assert.equal(ownerMessagePlan().supports_wait_for_owner,true);
 assert.equal((await startOwnerMessageCandidate({waitForOwner:false,env:noRead})).wait_for_owner,false);
 for(const waitForOwner of ['true','false',1,null]){
  assert.throws(()=>ownerMessageScope({waitForOwner,env:noRead}));
  await assert.rejects(startOwnerMessageCandidate({approved:true,waitForOwner,env:noRead}));
 }
 assert.throws(()=>ownerMessageScope({waitForOwner:false,env:{OWNER_MESSAGE_WINDOW_SECONDS:'901'}}));
});


test('public CLI preserves plan and timed defaults and requires the explicit waiting flag',async()=>{
 const {ownerMessageCliMode}=await import('../scripts/owner-message-candidate.js');
 assert.deepEqual(ownerMessageCliMode([]),{approved:false,waitForOwner:false});
 assert.deepEqual(ownerMessageCliMode(['--confirm-owner-single-message-experiment']),{approved:true,waitForOwner:false});
 assert.deepEqual(ownerMessageCliMode(['--confirm-owner-single-message-experiment','--wait-for-owner']),{approved:true,waitForOwner:true});
 for(const args of [['--wait-for-owner'],['--wait-for-owner','--confirm-owner-single-message-experiment'],['--confirm-owner-single-message-experiment','true'],['--confirm-owner-single-message-experiment','--wait-for-owner','extra']])assert.throws(()=>ownerMessageCliMode(args));
 const {spawnSync}=await import('node:child_process');
 const plan=spawnSync(process.execPath,['scripts/owner-message-candidate.js'],{encoding:'utf8',env:{LARK_CREDENTIALS_FILE:'/does-not-exist',OWNER_MESSAGE_WINDOW_SECONDS:'invalid'}});
 assert.equal(plan.status,0);const value=JSON.parse(plan.stdout);assert.equal(value.credential_read,false);assert.equal(value.wait_for_owner,false);assert.equal(value.supports_wait_for_owner,true);
});

test('runtime closes durable storage before releasing the application lock',async()=>{
 const order=[];
 const runtime=createOwnerMessageRuntime({approved:true,waitForOwner:true,session:{close(){},status(){return{};}},authConfig:{authMode:'tunnel-service',tunnelServiceOperation:'readiness',principal:'tunnel-owner:dot-bridge',host:'127.0.0.1',port:0},connectionConfig:{larkAppId:credentials.appId},authenticateFactory:()=>async()=>{},modeLock:()=>()=>order.push('release'),onClose:()=>order.push('store_closed')});
 await runtime.start();await runtime.close();assert.deepEqual(order,['store_closed','release']);
});

test('authenticated reply response finishes before shutdown and receives its dedicated socket budget',async t=>{
 const http=await import('node:http');const order=[],timeouts=[];let phase='awaiting_fixed_reply';
 const originalEnd=http.ServerResponse.prototype.end,originalTimeout=http.ServerResponse.prototype.setTimeout;
 t.mock.method(http.ServerResponse.prototype,'end',function(...args){this.once('finish',()=>order.push('response_finished'));return originalEnd.apply(this,args);});
 t.mock.method(http.ServerResponse.prototype,'setTimeout',function(ms,...args){timeouts.push(ms);return originalTimeout.call(this,ms,...args);});
 const runtime=createOwnerMessageRuntime({approved:true,waitForOwner:true,session:{close(){},status(){return{phase};},async reply(){phase='closed';return{status:'sent'};}},authConfig:{authMode:'tunnel-service',tunnelServiceOperation:'readiness',principal:'tunnel-owner:dot-bridge',host:'127.0.0.1',port:0},connectionConfig:{larkAppId:credentials.appId},authenticateFactory:()=>async req=>{if(req.headers['x-test-owner']!=='yes')throw Error();return{id:'tunnel-owner:dot-bridge',validUntil:Date.now()+60000};},modeLock:()=>()=>order.push('lock_released'),onClose:()=>order.push('store_closed')});
 const address=await runtime.start();const request=mcpRequest('tools/call',{name:'reply_to_lark',arguments:{message_id:'m',text:'fixed reply'}});
 const call=async owner=>{const response=await fetch(`http://127.0.0.1:${address.port}/mcp`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28','mcp-method':'tools/call','mcp-name':'reply_to_lark','x-test-owner':owner},body:JSON.stringify(request)});return{status:response.status,body:await response.json()};};
 try{
  assert.equal((await call('no')).status,400);assert.deepEqual(timeouts,[]);order.length=0;
  const result=await call('yes');assert.equal(result.status,200);assert.equal(result.body.result.structuredContent.status,'sent');await runtime.close();
  assert.deepEqual(timeouts,[30000]);assert.deepEqual(order,['response_finished','store_closed','lock_released']);
 }finally{await runtime.close();}
});

test('caller disconnect during one reply still records completion and closes without retry',async()=>{
 const http=await import('node:http');let phase='awaiting_fixed_reply',replyCalls=0,complete,started,finished;
 const replyStarted=new Promise(resolve=>started=resolve),closed=new Promise(resolve=>finished=resolve);
 const runtime=createOwnerMessageRuntime({approved:true,waitForOwner:true,session:{close(){},status(){return{phase};},async reply(){replyCalls++;started();await new Promise(resolve=>complete=resolve);phase='closed';return{status:'sent'};}},authConfig:{authMode:'tunnel-service',tunnelServiceOperation:'readiness',principal:'tunnel-owner:dot-bridge',host:'127.0.0.1',port:0},connectionConfig:{larkAppId:credentials.appId},authenticateFactory:()=>async()=>({id:'tunnel-owner:dot-bridge',validUntil:Date.now()+60000}),modeLock:()=>()=>{},onClose:finished});
 const address=await runtime.start(),body=JSON.stringify(mcpRequest('tools/call',{name:'reply_to_lark',arguments:{message_id:'m',text:'fixed'}}));
 const request=http.request({host:'127.0.0.1',port:address.port,path:'/mcp',method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28','mcp-method':'tools/call','mcp-name':'reply_to_lark','content-length':Buffer.byteLength(body)}});request.on('error',()=>{});request.end(body);
 try{await replyStarted;request.destroy();await new Promise(resolve=>setImmediate(resolve));complete();await closed;assert.equal(replyCalls,1);assert.equal(phase,'closed');}finally{complete?.();await runtime.close();}
});
