import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readConfig} from '../src/config.js';
import {createApp} from '../src/server.js';
import {createLarkDispatcher} from '../src/lark-runtime.js';
import {makePublicRequester} from '../src/network.js';
import {subscriptionParams} from './helpers.js';
import {makeOwnerScopedProxyTransport} from '../../dot-qq-bridge/packages/dot-bridge-transport/owner-scoped.js';
import {privateMkdtempSync,cleanupPrivateFixture} from '../../dot-qq-bridge/packages/dot-bridge-platform/test-fixtures.js';
function fixture(t){
 const dir=privateMkdtempSync(path.join(os.tmpdir(),'formal-owner-'));cleanupPrivateFixture(t,dir);
 const service=path.join(dir,'service'),storage=path.join(dir,'storage'),paired=path.join(dir,'paired');
 fs.writeFileSync(service,Buffer.alloc(32,21).toString('base64url'),{mode:0o600});fs.writeFileSync(storage,Buffer.alloc(32,22).toString('base64url'),{mode:0o600});
 const identity={version:1,status:'paired',appId:'cli_0123456789abcdef',appSecret:'synthetic-formal-secret',tenantKey:'tenant',ownerOpenId:'owner',ownerChatId:'chat'};fs.writeFileSync(paired,JSON.stringify(identity),{mode:0o600});
 const env={AUTH_MODE:'tunnel-service',BRIDGE_MODE:'tunnel',TUNNEL_SERVICE_OPERATION:'live',CALLBACK_TRANSPORT_MODE:'owner-scoped-proxy',TUNNEL_SERVICE_OWNER_ID:'tunnel-owner:dot-bridge',TUNNEL_SERVICE_KEY_FILE:service,LARK_CREDENTIALS_FILE:paired,LARK_EXPECTED_APP_ID:identity.appId,STORAGE_KEY_FILE:storage,DATABASE_PATH:path.join(dir,'messages.sqlite'),BRIDGE_LOCK_DIRECTORY:dir,LARK_TRANSPORT:'long-connection',TEXT_RETENTION_SECONDS:'3600',INBOUND_PER_MINUTE:'20',MAX_DELIVERY_ATTEMPTS:'1'};
 const config=readConfig(env);let now=Date.now(),app,transport,failEvent=false,revokeAfterEvent=false,holdChallenge=false,releaseChallenge;const events=[],replies=[],challenges=[];
 function open(){
  const proxyEnv={HTTPS_PROXY:'http://proxy.example:8080'};
  transport=makeOwnerScopedProxyTransport({channel:'lark',proxyEnv,now:()=>now,connect:async(_url,_proxy,request)=>{await request.beforeConnect();const body=JSON.parse(request.body);if(body.type==='verification'){challenges.push(body.challenge);if(holdChallenge){holdChallenge=false;await new Promise(resolve=>releaseChallenge=resolve);}return{status:200,headers:{},body:Buffer.from(JSON.stringify({challenge:body.challenge}))};}events.push(body);if(revokeAfterEvent)app.bridge.store.unsubscribe(app.bridge.store.activeSubscription(now).id);if(failEvent)throw Error('synthetic uncertain');return{status:202,headers:{},body:Buffer.from('{}')};}});
  const send=makePublicRequester({proxyEnv,callbackTransport:transport,providerSend:async(url,options)=>{options.beforeConnect();if(url.endsWith('/tenant_access_token/internal'))return{status:200,body:Buffer.from(JSON.stringify({code:0,tenant_access_token:'synthetic-token',expire:7200}))};const body=JSON.parse(options.body);replies.push({url,text:JSON.parse(body.content).text});return{status:200,body:Buffer.from(JSON.stringify({code:0,data:{message_id:'out-'+replies.length,chat_id:'chat'}}))};}});
  app=createApp(config,{send,clock:()=>now,worker:false,approvedLive:true});return app;
 }
 async function close(){await app?.close();app=undefined;transport?.close?.();}
 t.after(close);
 const principal=()=>({id:config.principal,validUntil:now+3600000});
 const receive=async(id,text)=>{const p={schema:'2.0',header:{event_id:'e-'+id,event_type:'im.message.receive_v1',create_time:String(now),app_id:identity.appId,tenant_key:'tenant'},event:{sender:{sender_id:{open_id:'owner'},sender_type:'user',tenant_key:'tenant'},message:{message_id:id,chat_id:'chat',chat_type:'p2p',message_type:'text',create_time:String(now),content:JSON.stringify({text})}}};return createLarkDispatcher(config,app.bridge.store,()=>now).invoke(p,{needCheck:false});};
 return{open,close,receive,config,env,principal,events,replies,challenges,holdNextChallenge(){holdChallenge=true;},releaseChallenge(){releaseChallenge?.();},get app(){return app;},get now(){return now;},set now(v){now=v;},set failEvent(v){failEvent=v;},set revokeAfterEvent(v){revokeAfterEvent=v;}};
}
test('formal Bridge handles continuous owner texts and independent non-fixed replies through durable queue',async t=>{
 const f=fixture(t);f.open();await f.app.bridge.rpc('events/subscribe',subscriptionParams(),f.principal());
 assert.equal((await f.receive('z-first','第一条数据')).outcome,'queued');assert.equal((await f.receive('a-second','第二条数据')).outcome,'queued');assert.equal((await f.receive('z-first','第一条数据')).outcome,'duplicate');
 await f.app.bridge.tick();await f.app.bridge.tick();assert.deepEqual(f.events.map(e=>e.data.message_id),['z-first','a-second']);
 const pending=(await f.app.bridge.rpc('tools/call',{name:'check_lark_setup',arguments:{}},f.principal())).structuredContent.pending_messages;assert.deepEqual(pending.map(m=>m.message_id),['z-first','a-second']);assert.equal(JSON.stringify(pending).includes('第一条数据'),false);
 for(const [id,text]of [['z-first','第一条不同回复'],['a-second','第二条另一回复']]){const queued=await f.app.bridge.rpc('tools/call',{name:'reply_to_lark',arguments:{message_id:id,text}},f.principal());assert.equal(queued.structuredContent.status,'pending');await f.app.bridge.tick();assert.equal(f.app.bridge.store.replyStatus(id).status,'sent');}
 assert.deepEqual(f.replies.map(r=>r.text),['第一条不同回复','第二条另一回复']);assert.ok(f.replies.every(r=>r.url.endsWith('/reply')));
 await assert.rejects(f.app.bridge.rpc('tools/call',{name:'reply_to_lark',arguments:{message_id:'z-first',text:'变更已发送答案'}},f.principal()));
 const again=await f.app.bridge.rpc('tools/call',{name:'reply_to_lark',arguments:{message_id:'z-first',text:'第一条不同回复'}},f.principal());assert.equal(again.structuredContent.status,'sent');assert.equal(f.replies.length,2);assert.deepEqual((await f.app.bridge.rpc('tools/call',{name:'check_lark_setup',arguments:{}},f.principal())).structuredContent.pending_messages,[]);
});
test('formal subscription and queued messages survive restart with original deadlines and encrypted text',async t=>{
 const f=fixture(t);f.open();const granted=await f.app.bridge.rpc('events/subscribe',subscriptionParams(),f.principal());await f.receive('m','PRIVATE_FORMAL_BODY_CANARY');const deadline=f.app.bridge.store.message('m').expires;await f.close();
 f.now+=1000;f.open();assert.equal(f.app.bridge.store.activeSubscription(f.now).id,granted.id);assert.equal(f.app.bridge.store.message('m').expires,deadline);await f.app.bridge.tick();assert.equal(f.events.length,1);assert.equal(f.events[0].data.text,'PRIVATE_FORMAL_BODY_CANARY');
 const db=fs.readFileSync(f.config.dbPath);assert.equal(db.includes(Buffer.from('PRIVATE_FORMAL_BODY_CANARY')),false);
 f.app.bridge.unsubscribe({name:'lark.message.created',arguments:{conversation:'owner'},delivery:{mode:'webhook',url:subscriptionParams().delivery.url}},f.principal());await assert.rejects(f.app.bridge.rpc('tools/call',{name:'reply_to_lark',arguments:{message_id:'m',text:'不能发送'}},f.principal()));assert.equal(f.replies.length,0);
});
test('formal unknown event outcome and interrupted event jobs are never automatically resent',async t=>{
 const f=fixture(t);f.open();await f.app.bridge.rpc('events/subscribe',subscriptionParams(),f.principal());await f.receive('m','one');f.failEvent=true;await f.app.bridge.tick();assert.equal(f.app.bridge.store.get("SELECT state FROM jobs WHERE kind='event'").state,'uncertain');f.now+=120000;await f.app.bridge.tick();assert.equal(f.events.length,1);
 await f.receive('n','two');const job=f.app.bridge.store.claim(f.now);assert.equal(job.kind,'event');await f.close();f.now+=120000;f.open();await f.app.bridge.tick();assert.equal(f.events.length,1);assert.equal(f.app.bridge.store.get('SELECT state FROM jobs WHERE id=?',job.id).state,'uncertain');
});
test('formal callback mode rejects other auth and readiness before reading file references',()=>{
 for(const env of [{},{AUTH_MODE:'dev'},{AUTH_MODE:'tunnel-service',BRIDGE_MODE:'tunnel',TUNNEL_SERVICE_OPERATION:'readiness',TUNNEL_SERVICE_OWNER_ID:'tunnel-owner:dot-bridge'}])assert.throws(()=>readConfig({...env,CALLBACK_TRANSPORT_MODE:'owner-scoped-proxy',LARK_CREDENTIALS_FILE:'/must-not-read'}));
 assert.throws(()=>readConfig({CALLBACK_TRANSPORT_MODE:'automatic'}));
});

test('formal pending metadata is bounded, principal-scoped and excludes expired messages',async t=>{
 const f=fixture(t);f.open();await f.app.bridge.rpc('events/subscribe',subscriptionParams(),f.principal());
 for(let i=0;i<12;i++){await f.receive(`m-${i}`,'not included in metadata');await f.app.bridge.tick();}
 const read=()=>f.app.bridge.rpc('tools/call',{name:'check_lark_setup',arguments:{}},f.principal());
 const first=(await read()).structuredContent.pending_messages;assert.equal(first.length,10);assert.deepEqual(Object.keys(first[0]),['message_id','reply_deadline','reply_status']);
 await assert.rejects(f.app.bridge.rpc('tools/call',{name:'check_lark_setup',arguments:{}},{id:'stranger',validUntil:f.now+60000}));
 await f.app.bridge.rpc('tools/call',{name:'reply_to_lark',arguments:{message_id:'m-0',text:'ordinary response'}},f.principal());await f.app.bridge.tick();assert.equal((await read()).structuredContent.pending_messages[0].message_id,'m-1');
 f.now+=f.config.replyTtlMs+1;assert.deepEqual((await read()).structuredContent.pending_messages,[]);
});


test('formal callback busy before an event attempt safely reschedules instead of losing or duplicating it',async t=>{
 const f=fixture(t);f.open();await f.app.bridge.rpc('events/subscribe',subscriptionParams(),f.principal());await f.receive('m','待续订完成');
 f.app.bridge.store.run('UPDATE subscriptions SET verified_until=?',f.now-1);f.holdNextChallenge();const renewal=f.app.bridge.rpc('events/subscribe',subscriptionParams(),f.principal());
 await new Promise(resolve=>setImmediate(resolve));await f.app.bridge.tick();assert.equal(f.app.bridge.store.get("SELECT state FROM jobs WHERE kind='event'").state,'pending');assert.equal(f.events.length,0);assert.equal(f.app.bridge.store.message('m').attempted_at,null);assert.equal(f.app.bridge.store.get("SELECT attempts FROM jobs WHERE kind='event'").attempts,0);
 f.releaseChallenge();await renewal;f.now+=1001;await f.app.bridge.tick();assert.equal(f.events.length,1);assert.equal(f.app.bridge.store.get("SELECT state FROM jobs WHERE kind='event'").state,'delivered');
});


test('revocation after a callback starts retains an uncertain outcome rather than a safe cancellation',async t=>{
 const f=fixture(t);f.open();await f.app.bridge.rpc('events/subscribe',subscriptionParams(),f.principal());await f.receive('m','data');f.revokeAfterEvent=true;await f.app.bridge.tick();
 assert.equal(f.events.length,1);assert.equal(f.app.bridge.store.get("SELECT state FROM jobs WHERE kind='event'").state,'uncertain');f.now+=60000;await f.app.bridge.tick();assert.equal(f.events.length,1);
 await assert.rejects(f.app.bridge.rpc('tools/call',{name:'reply_to_lark',arguments:{message_id:'m',text:'not authorized'}},f.principal()));assert.equal(f.replies.length,0);
});


test('formal database pins callback policy so restart cannot silently restore retry semantics',async t=>{
 const f=fixture(t);f.open();await f.app.bridge.rpc('events/subscribe',subscriptionParams(),f.principal());await f.receive('m','data');f.app.bridge.store.claim(f.now);await f.close();
 const {Store}=await import('../src/store.js');assert.throws(()=>new Store(readConfig({...f.env,CALLBACK_TRANSPORT_MODE:'standard'})),/callback mode differs/);
 f.now+=120000;f.open();await f.app.bridge.tick();assert.equal(f.app.bridge.store.get("SELECT state FROM jobs WHERE kind='event'").state,'uncertain');assert.equal(f.events.length,0);
});


test('failed owner binding validation cannot stamp a callback mode into a legacy empty database',async t=>{
 const f=fixture(t);f.open();f.app.bridge.store.run("DELETE FROM metadata WHERE key='callback_transport_mode'");await f.close();
 const alternate=path.join(path.dirname(f.env.LARK_CREDENTIALS_FILE),'other-paired');const identity=JSON.parse(fs.readFileSync(f.env.LARK_CREDENTIALS_FILE,'utf8'));identity.ownerOpenId='different-owner';fs.writeFileSync(alternate,JSON.stringify(identity),{mode:0o600});
 const {Store}=await import('../src/store.js');assert.throws(()=>new Store(readConfig({...f.env,LARK_CREDENTIALS_FILE:alternate})),/binding differs/);
 const {DatabaseSync}=await import('node:sqlite');const check=new DatabaseSync(f.config.dbPath,{readOnly:true});try{assert.equal(check.prepare("SELECT value FROM metadata WHERE key='callback_transport_mode'").get(),undefined);}finally{check.close();}
 f.open();assert.equal(f.app.bridge.store.get("SELECT value FROM metadata WHERE key='callback_transport_mode'").value,'owner-scoped-proxy');
});
