import { cleanupPrivateFixture, beforeFixtureCleanup, privateMkdtempSync, fixtureChmodSync } from '../../dot-qq-bridge/packages/dot-bridge-platform/test-fixtures.js';
import { BridgeError } from '../src/common.js';
import { createLarkDispatcher } from '../src/lark-runtime.js';
import { preflightCallbackTransport } from '../../dot-qq-bridge/packages/dot-bridge-transport/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { makePublicRequester } from '../src/network.js';
import { subscriptionParams, config as fixtureConfig, larkPayload } from './helpers.js';
function live(t) {
 const dir=privateMkdtempSync(path.join(os.tmpdir(),'lark-callback-fixture-'));fixtureChmodSync(dir,0o700);cleanupPrivateFixture(t,dir);
 const key=path.join(dir,'service'),storage=path.join(dir,'storage'),credential=path.join(dir,'paired');
 fs.writeFileSync(key,Buffer.alloc(32,17).toString('base64url'),{mode:0o600});fs.writeFileSync(storage,Buffer.alloc(32,18).toString('base64url'),{mode:0o600});
 fs.writeFileSync(credential,JSON.stringify({version:1,status:'paired',appId:'cli_0123456789abcdef',appSecret:'synthetic-secret-only',tenantKey:'tenant',ownerOpenId:'owner',ownerChatId:'chat'}),{mode:0o600});
 return readConfig({AUTH_MODE:'tunnel-service',BRIDGE_MODE:'tunnel',TUNNEL_SERVICE_OPERATION:'live',TUNNEL_SERVICE_OWNER_ID:'tunnel-owner:dot-bridge',TUNNEL_SERVICE_KEY_FILE:key,LARK_CREDENTIALS_FILE:credential,LARK_EXPECTED_APP_ID:'cli_0123456789abcdef',STORAGE_KEY_FILE:storage,DATABASE_PATH:path.join(dir,'db'),BRIDGE_LOCK_DIRECTORY:dir,LARK_TRANSPORT:'long-connection',MCP_CALLBACK_ALLOWED_HOSTS:'receiver.example.com'});
}
test('real live Bridge challenge and queued callback enter shared direct transport with synthetic network',async t=>{
 const config=live(t),now=Date.now();const kinds=[];let lookups=0,providerCalls=0;
 const request=(url,options,onResponse)=>{
  assert.equal(url.hostname,'receiver.example.com');assert.equal(options.rejectUnauthorized,true);
  const req=new EventEmitter();req.destroy=error=>{if(error)req.emit('error',error);req.emit('close');};
  req.end=body=>queueMicrotask(()=>{
    const payload=JSON.parse(body.toString());kinds.push(payload.type==='verification'?'challenge':'event');
    const res=new EventEmitter();res.statusCode=200;res.headers={};res.rawHeaders=[];res.complete=true;res.destroy=error=>res.emit('error',error);
    onResponse(res);res.emit('data',Buffer.from(JSON.stringify(payload.type==='verification'?{challenge:payload.challenge}:{})));res.emit('end');req.emit('close');
  });return req;
 };
 const send=makePublicRequester({proxyEnv:{},lookup:async()=>{lookups++;return [{address:'8.8.8.8',family:4}];},request,providerSend:async()=>{providerCalls++;throw Error('must not call provider');}});
 const app=createApp(config,{send,worker:false,approvedLive:true});beforeFixtureCleanup(t,()=>app.close());
 const principal={id:config.principal,validUntil:now+60000};await app.bridge.rpc('events/subscribe',subscriptionParams(),principal);
 app.bridge.store.ingest({id:'m',sourceEventId:'e',owner:'owner',tenantKey:'tenant',chatId:'chat',text:'synthetic only',timestamp:new Date(now).toISOString(),expires:now+60000},'replay',now);
 await app.bridge.tick();assert.deepEqual(kinds,['challenge','event']);assert.equal(lookups,2);assert.equal(providerCalls,0);
 assert.equal(app.readiness().callback_transport.network_checked,false);
});
test('managed proxy without adapter refuses live challenge before DNS/request and keeps safe reason',async t=>{
 const config=live(t);let dns=0,requests=0;
 const send=makePublicRequester({proxyEnv:{HTTPS_PROXY:'http://proxy.example:8080'},lookup:async()=>{dns++;throw Error('forbidden');},request:()=>{requests++;throw Error('forbidden');}});
 const app=createApp(config,{send,worker:false,approvedLive:true});beforeFixtureCleanup(t,()=>app.close());
 await assert.rejects(app.bridge.rpc('events/subscribe',subscriptionParams(),{id:config.principal,validUntil:Date.now()+60000}),error=>{
  assert.equal(error.code,-32015);assert.equal(error.data.reason,'proxy_policy_unverified');assert.equal(error.data.callback_transport.ready,false);
  const visible=JSON.stringify(error);assert.equal(visible.includes('current-dot'),false);assert.equal(visible.includes('whsec_'),false);assert.equal(visible.includes('proxy.example'),false);return true;
 });assert.equal(dns,0);assert.equal(requests,0);assert.equal(app.bridge.ready(),false);
});
test('unrecognized callback errors never expose injected secrets or arbitrary reason text',async t=>{
 const config=live(t);const callbackSend=async()=>{const error=new Error('synthetic-secret-in-cause');error.code='synthetic-secret-code';throw error;};
 callbackSend.preflight=()=>preflightCallbackTransport({proxyEnv:{}});
 const send=makePublicRequester({callbackSend,proxyEnv:{}});const app=createApp(config,{send,worker:false,approvedLive:true});beforeFixtureCleanup(t,()=>app.close());
 await assert.rejects(app.bridge.rpc('events/subscribe',subscriptionParams(),{id:config.principal,validUntil:Date.now()+60000}),error=>error.code===-32015&&error.data.reason==='connection_failed'&&!JSON.stringify(error).includes('synthetic-secret'));
 assert.equal(makePublicRequester({callbackSend:async()=>{},proxyEnv:{}}).callbackTransportStatus().reason,'transport_unverified');
});
test('cached same-secret subscription cannot renew while callback transport is blocked',async t=>{
 const config=live(t),now=Date.now();let calls=0;
 const send=makePublicRequester({proxyEnv:{HTTPS_PROXY:'http://proxy.example:8080'},lookup:async()=>{calls++;throw Error();},request:()=>{calls++;throw Error();}});
 const app=createApp(config,{send,worker:false,approvedLive:true});beforeFixtureCleanup(t,()=>app.close());
 const params=subscriptionParams(),id=app.bridge.subscriptionId(config.principal,params.delivery.url,params.name,params.arguments),expires=now+10000;
 app.bridge.store.saveSubscription({id,principal:config.principal,url:params.delivery.url,secret:params.delivery.secret,expires,verified_until:now+60000},now);
 await assert.rejects(app.bridge.rpc('events/subscribe',params,{id:config.principal,validUntil:now+120000}),e=>e.code===-32015&&e.data.reason==='proxy_policy_unverified');
 assert.equal(app.bridge.store.subscription(id).expires,expires);assert.equal(calls,0);await app.larkRuntime.start();assert.equal(app.larkRuntime.status(),'disabled');
});
test('local authorization cancellation survives sanitized adapter gate error',async()=>{
 const callbackSend=async(_raw,options)=>{try{await options.beforeConnect();}catch{const e=new Error('redacted');e.code='gate_failed';throw e;}};
 callbackSend.preflight=()=>preflightCallbackTransport({proxyEnv:{}});
 const send=makePublicRequester({callbackSend,proxyEnv:{}});
 await assert.rejects(send('https://receiver.example.com/path',{purpose:'callback',hosts:['receiver.example.com'],beforeConnect(){throw new BridgeError('synthetic-private-reason',{code:-32012});}}),e=>e.code===-32012&&!e.retryable&&!JSON.stringify(e).includes('synthetic-private-reason'));
});
test('inbound live dispatcher checks current delivery authorization immediately before persistence',async()=>{
 let ingested=0;const now=Date.now();
 const dispatcher=createLarkDispatcher(fixtureConfig(),{get(){return undefined;},ingest(){ingested++;}},()=>now,{authorize(){throw new BridgeError('Callback delivery authorization inactive',{code:-32012});}});
 await assert.rejects(dispatcher.invoke(larkPayload(now),{needCheck:false}),e=>e.code===-32012);assert.equal(ingested,0);
});
test('real live challenge and event use injected managed adapter without direct request fallback',async t=>{
 const config=live(t),now=Date.now();const kinds=[];let direct=0,lookups=0;
 const managedAdapter={async send(target,options){
  assert.equal(target.hostname,'receiver.example.com');assert.deepEqual(target.addresses,[{address:'8.8.8.8',family:4}]);assert.equal(target.tls.rejectUnauthorized,true);
  assert.equal(target.destinationBinding,'delegated_unverified');await options.beforeConnect();
  const payload=JSON.parse(options.body.toString());kinds.push(payload.type==='verification'?'challenge':'event');
  return {status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(payload.type==='verification'?{challenge:payload.challenge}:{}))};
 }};
 const send=makePublicRequester({proxyEnv:{HTTPS_PROXY:'http://proxy.example:8080'},managedAdapter,lookup:async()=>{lookups++;return [{address:'8.8.8.8',family:4}];},request:()=>{direct++;throw Error('no direct network');}});
 const app=createApp(config,{send,worker:false,approvedLive:true});beforeFixtureCleanup(t,()=>app.close());
 await app.bridge.rpc('events/subscribe',subscriptionParams(),{id:config.principal,validUntil:now+60000});
 app.bridge.store.ingest({id:'m',sourceEventId:'e',owner:'owner',tenantKey:'tenant',chatId:'chat',text:'synthetic only',timestamp:new Date(now).toISOString(),expires:now+60000},'replay',now);
 await app.bridge.tick();assert.deepEqual(kinds,['challenge','event']);assert.equal(lookups,2);assert.equal(direct,0);
 assert.equal(app.readiness().callback_transport.mode,'managed');assert.equal(app.readiness().callback_transport.network_checked,false);
});
test('provider discovery budgets do not alter callback factory limits',()=>{
 const send=makePublicRequester({timeoutMs:30000,maxBytes:262144,proxyEnv:{}});
 assert.equal(send.callbackTransportStatus().ready,true);assert.equal(send.callbackTransportStatus().network_checked,false);
});
test('synchronous authorization remains synchronous through application callback wrapper',async()=>{
 let gateCalled=0;const callbackSend=async(_raw,options)=>{assert.equal(options.beforeConnect(),undefined);return {status:200,body:Buffer.from('{}')};};
 callbackSend.preflight=()=>preflightCallbackTransport({proxyEnv:{}});
 const send=makePublicRequester({callbackSend,proxyEnv:{}});
 await send('https://receiver.example.com/path',{purpose:'callback',hosts:['receiver.example.com'],beforeConnect(){gateCalled++;}});assert.equal(gateCalled,1);
});
test('malformed callback preflight fails closed in setup and lifecycle projections',async t=>{
 const config=live(t);const send=async()=>{throw Error('not called');};send.callbackTransportStatus=()=>({ready:true,extra:'private-value'});
 const app=createApp(config,{send,worker:false,approvedLive:true});beforeFixtureCleanup(t,()=>app.close());
 assert.deepEqual(app.readiness().callback_transport,{ready:false,mode:'blocked',reason:'transport_unverified',proxy_configured:null,destination_binding:'unverified',network_checked:false});
 const result=await app.bridge.rpc('tools/call',{name:'check_lark_setup',arguments:{}},{id:config.principal});
 assert.equal(result.structuredContent.delivery_configured,false);assert.equal(JSON.stringify(result).includes('private-value'),false);
});
