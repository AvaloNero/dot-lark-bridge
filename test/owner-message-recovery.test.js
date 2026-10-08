import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.js';
import {createOwnerMessageLedger} from '../src/owner-message-ledger.js';
import {restoredTransportState} from '../src/owner-message-persistence.js';
import {createLarkOwnerMessageSession} from '../src/owner-message-session.js';
import {createOwnerMessageRuntime} from '../src/owner-message-runtime.js';
import {config} from './helpers.js';
import {hash} from '../src/common.js';
import * as shared from '../../dot-qq-bridge/packages/dot-bridge-transport/experimental/owner-message.js';
import {privateMkdtempSync,cleanupPrivateFixture} from '../../dot-qq-bridge/packages/dot-bridge-platform/test-fixtures.js';
const credentials={version:1,status:'paired',appId:'cli_0123456789abcdef',appSecret:'synthetic-app-secret',tenantKey:'tenant',ownerOpenId:'owner',ownerChatId:'chat'};
const input={url:'https://receiver.example/cb',secret:'whsec_'+Buffer.alloc(32,13).toString('base64')};
function event(now){return{schema:'2.0',header:{event_id:'e',event_type:'im.message.receive_v1',create_time:String(now),app_id:credentials.appId,tenant_key:'tenant'},event:{sender:{sender_id:{open_id:'owner'},sender_type:'user',tenant_key:'tenant'},message:{message_id:'m',chat_id:'chat',chat_type:'p2p',message_type:'text',create_time:String(now),content:JSON.stringify({text:'BODY_NEVER_PERSISTED'})}}};}
function fixture(t){
 const dir=privateMkdtempSync(path.join(os.tmpdir(),'owner-recovery-'));cleanupPrivateFixture(t,dir);
 const settings=config({dbPath:path.join(dir,'state.sqlite'),principal:'tunnel-owner:dot-bridge',larkAppId:credentials.appId,ownerOpenId:credentials.ownerOpenId,tenantKey:credentials.tenantKey,ownerChatId:credentials.ownerChatId});
 let now=Date.now(),store,ledger,session,providerReplies=0;const callbacks=[];
 const principal=()=>({id:'tunnel-owner:dot-bridge',validUntil:now+3600000});
 function open(){
  store=new Store(settings);ledger=createOwnerMessageLedger(store);const checkpoint=ledger.load();
  const proxyEnv={HTTPS_PROXY:'http://proxy.example:8080'};
  const transport=shared.makeOwnerMessageExperimentTransport({approvedOwnerMessageExperiment:true,channel:'lark',acceptAnyOwnerText:true,waitForOwner:true,proxyEnv,restoredState:restoredTransportState(checkpoint),now:()=>now,connect:async(_url,_proxy,r)=>{await r.beforeConnect();const body=JSON.parse(r.body);callbacks.push(body.type==='verification'?'challenge':'event');if(body.type!=='verification')assert.equal(ledger.load().phase,'event_attempted');return{status:200,headers:{},body:Buffer.from(JSON.stringify(body.type==='verification'?{challenge:body.challenge}:{}))};}});
  session=createLarkOwnerMessageSession({credentials,expectedAppId:credentials.appId,acceptAnyOwnerText:true,fixedReply:'fixed reply',waitForOwner:true,authenticatedCallbackDiscovery:true,callbackTransport:transport,recognizeTransport:shared.ownerMessageExperimentStatus,proxyEnv,clock:()=>now,ledger,restoredCheckpoint:checkpoint,providerSend:async(url,options)=>{options.beforeConnect();assert.equal(ledger.load().phase,'reply_attempted');if(url.endsWith('/tenant_access_token/internal'))return{status:200,body:Buffer.from(JSON.stringify({code:0,tenant_access_token:'synthetic-token',expire:7200}))};providerReplies++;return{status:200,body:Buffer.from(JSON.stringify({code:0,data:{message_id:'reply',chat_id:'chat'}}))};}});return session;
 }
 function close(){session?.close();session=undefined;store?.close();store=undefined;}
 t.after(close);
 return{open,close,principal,callbacks,settings,get ledger(){return ledger;},get now(){return now;},set now(value){now=value;},get providerReplies(){return providerReplies;}};
}
test('durable grant restores gateway without a new subscribe or challenge and delivered reply recovers without body',async t=>{
 const f=fixture(t);let session=f.open();const granted=await session.subscribe(input,f.principal());assert.equal(f.ledger.load().phase,'waiting');assert.equal(session.status().subscription_expires_at,granted.refreshBefore);f.close();
 session=f.open();assert.equal(session.recovery().needsGateway,true);assert.deepEqual(f.callbacks,['challenge']);
 let starts=0;
 const runtime=createOwnerMessageRuntime({session,waitForOwner:true,approved:true,clock:()=>f.now,authConfig:{authMode:'tunnel-service',tunnelServiceOperation:'readiness',principal:'tunnel-owner:dot-bridge',host:'127.0.0.1',port:0},connectionConfig:{larkAppId:credentials.appId},authenticateFactory:()=>async()=>f.principal(),modeLock:()=>()=>{},connectionFactory:()=>({async start(){starts++;},close(){}})});
 await runtime.start();assert.equal(starts,1);assert.deepEqual(f.callbacks,['challenge']);await runtime.close();f.close();
 session=f.open();assert.equal((await session.receive(event(f.now))).outcome,'delivered');assert.equal(f.ledger.load().phase,'event_delivered');assert.equal(JSON.stringify(f.ledger.load()).includes('BODY_NEVER_PERSISTED'),false);f.close();
 session=f.open();assert.equal(session.recovery().needsGateway,false);assert.equal(session.readMessage('m',f.principal()).text,null);assert.equal(session.setup().pending_message.message_id,'m');assert.deepEqual(f.callbacks,['challenge','event']);
 assert.equal((await session.reply('m','fixed reply',f.principal())).status,'sent');assert.equal(f.providerReplies,1);assert.equal(f.ledger.load().phase,'sent');f.close();
 session=f.open();assert.equal(session.recovery(),null);await assert.rejects(session.reply('m','fixed reply',f.principal()));await assert.rejects(session.receive(event(f.now)));assert.equal(f.providerReplies,1);
});
test('interrupted event and reply attempts become durable uncertain and cannot repeat after restart',async t=>{
 for(const phase of ['event_attempted','reply_attempted']){
  const f=fixture(t);let session=f.open();await session.subscribe(input,f.principal());let cp=f.ledger.load();const message={id:'m',sourceEventId:'e',eventId:`evt_${hash(`${credentials.appId}:m`)}`,timestamp:new Date(f.now).toISOString(),expires:f.now+300000};
  cp={...cp,phase:'event_attempted',message};f.ledger.save(cp);
  if(phase==='reply_attempted'){cp={...cp,phase:'event_delivered'};f.ledger.save(cp);cp={...cp,phase};f.ledger.save(cp);}
  f.close();session=f.open();assert.equal(f.ledger.load().phase,'uncertain');assert.equal(session.recovery(),null);await assert.rejects(session.reply('m','fixed reply',f.principal()));await assert.rejects(session.receive(event(f.now)));assert.equal(f.providerReplies,0);assert.deepEqual(f.callbacks,['challenge']);f.close();
 }
});
test('expired persisted lease does not start gateway and only same authenticated subscription can renew',async t=>{
 const f=fixture(t);let session=f.open();const first=await session.subscribe(input,f.principal());f.close();f.now+=3600001;
 session=f.open();assert.equal(session.recovery(),null);await assert.rejects(session.receive(event(f.now)));await assert.rejects(session.subscribe({...input,url:'https://other.example/cb'},f.principal()));
 const renewed=await session.subscribe(input,f.principal());assert.equal(renewed.id,first.id);assert.deepEqual(f.callbacks,['challenge']);assert.ok(Date.parse(renewed.refreshBefore)>Date.parse(first.refreshBefore));
 session.unsubscribe(input.url,f.principal());f.close();session=f.open();await assert.rejects(session.subscribe(input,f.principal()));assert.equal(f.ledger.load().phase,'cancelled');
});

test('failed cancellation persistence still closes current transport and blocks further business',async()=>{
 let now=Date.now(),checkpoint=null,closed=0;
 const ledger={load:()=>checkpoint,save(value){if(value.phase==='cancelled')throw Error('fixed storage failure');checkpoint=value;}};
 const callback=async(_url,r)=>{const body=JSON.parse(r.body);return{status:200,body:Buffer.from(JSON.stringify({challenge:body.challenge}))};};callback.close=()=>closed++;
 const session=createLarkOwnerMessageSession({credentials,expectedAppId:credentials.appId,acceptAnyOwnerText:true,fixedReply:'fixed',deadlineMs:now+60000,callbackHosts:['receiver.example'],callbackTransport:callback,recognizeTransport:()=>({ready:true,mode:'owner_single_message_proxy'}),providerSend:async()=>{throw Error('must not send');},clock:()=>now,ledger});
 const principal={id:'tunnel-owner:dot-bridge',validUntil:now+60000};await session.subscribe(input,principal);
 assert.throws(()=>session.unsubscribe(input.url,principal));assert.equal(closed,1);assert.equal(session.status().phase,'closed');await assert.rejects(session.receive(event(now)));await assert.rejects(session.reply('m','fixed',principal));
});
