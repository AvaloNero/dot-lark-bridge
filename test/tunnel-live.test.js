import { cleanupPrivateFixture, beforeFixtureCleanup, privateMkdtempSync, fixtureChmodSync } from '../../dot-qq-bridge/packages/dot-bridge-platform/test-fixtures.js';
import { makePublicRequester } from '../src/network.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig, readTunnelReadinessConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createLarkRuntime } from '../src/lark-runtime.js';
import { createPersistentService } from '../src/service.js';
import { verifyIdentityEvidence, importVerifiedIdentity } from '../src/identity-binding.js';
const fixtureSecret = 'synthetic-app-secret-not-real';
function fixture(t) {
 const dir=privateMkdtempSync(path.join(os.tmpdir(),'lark-live-'));fixtureChmodSync(dir,0o700);cleanupPrivateFixture(t,dir);
 const paired={version:1,status:'paired',appId:'cli_0123456789abcdef',appSecret:fixtureSecret,tenantKey:'tenant',ownerOpenId:'owner',ownerChatId:'chat'};
 const credentials=path.join(dir,'paired.json');fs.writeFileSync(credentials,JSON.stringify(paired),{mode:0o600});
 const key=path.join(dir,'key');fs.writeFileSync(key,Buffer.alloc(32,7).toString('base64url'),{mode:0o600});
 const storage=path.join(dir,'storage-key');fs.writeFileSync(storage,Buffer.alloc(32,8).toString('base64url'),{mode:0o600});
 return {dir,paired,env:{AUTH_MODE:'tunnel-service',BRIDGE_MODE:'tunnel',TUNNEL_SERVICE_OPERATION:'live',TUNNEL_SERVICE_OWNER_ID:'tunnel-owner:dot-bridge',TUNNEL_SERVICE_KEY_FILE:key,LARK_EXPECTED_APP_ID:paired.appId,LARK_CREDENTIALS_FILE:credentials,STORAGE_KEY_FILE:storage,DATABASE_PATH:path.join(dir,'db.sqlite'),BRIDGE_LOCK_DIRECTORY:dir,LARK_TRANSPORT:'long-connection'}};
}
test('explicit live files permit pending callback catalog but no unapproved startup or subscriptions',async t=>{
 const {env}=fixture(t);const c=readConfig(env);assert.equal(c.tunnelServiceOperation,'live');assert.equal(c.callbackHosts.length,0);
 assert.throws(()=>readTunnelReadinessConfig(env));assert.throws(()=>createApp(c),/approval/);assert.equal(fs.existsSync(c.dbPath),false);
 let outbound=0;const app=createApp(c,{approvedLive:true,worker:false,send:async()=>{outbound++;throw Error('network forbidden');}});beforeFixtureCleanup(t,()=>app.close());
 const principal={id:c.principal,validUntil:Date.now()+10000};assert.equal((await app.bridge.rpc('events/list',{},principal)).events[0].name,'lark.message.created');
 await assert.rejects(app.bridge.rpc('events/subscribe',{name:'lark.message.created',arguments:{conversation:'owner'},delivery:{mode:'webhook',url:'https://callback.example/path',secret:'whsec_'+Buffer.alloc(32,8).toString('base64')}},principal),e=>e.data.reason==='callback_policy_required'&&e.data.callback_hostname==='callback.example'&&!JSON.stringify(e).includes('/path'));
 await app.larkRuntime.start();assert.equal(outbound,0);assert.equal(app.larkRuntime.status(),'disabled');
 const inspected=await app.bridge.rpc('tools/call',{name:'check_lark_setup',arguments:{callback_url:'https://callback.example/private-path?secret=canary'}},principal);
 assert.equal(inspected.structuredContent.callback_hostname,'callback.example');assert.equal(inspected.structuredContent.callback_policy,'not_allowlisted');assert.equal(inspected.structuredContent.network_checked,false);assert.equal(JSON.stringify(inspected).includes('canary'),false);
});
test('live rejects missing pairing, mixed inline secrets and alternate mode inputs',t=>{
 const {env}=fixture(t);
 for(const delta of [{LARK_EXPECTED_APP_ID:'cli_aaaaaaaaaaaaaaaa'},{LARK_CREDENTIALS_FILE:''},{STORAGE_KEY_FILE:''},{BRIDGE_LOCK_DIRECTORY:''},{DATABASE_PATH:''},{TUNNEL_SERVICE_OPERATION:'auto'},{LARK_APP_SECRET:fixtureSecret},{SITES_ORIGIN:'https://foreign.example'},{HOST:'0.0.0.0'},{TUNNEL_SERVICE_OWNER_ID:'tunnel-owner:other'}]) assert.throws(()=>readConfig({...env,...delta}));
});
test('gateway waits for valid owner subscription and closes on expiry',async()=>{
 let active=null,starts=0,closes=0;let now=1000;
 class Dispatcher{register(){return this;}async invoke(){}}
 class WS{async start(){starts++;}getConnectionStatus(){return {state:'connected'};}close(){closes++;}}
 const sdk={EventDispatcher:Dispatcher,WSClient:WS,LoggerLevel:{warn:1},Domain:{Feishu:'feishu'}};
 const c={authMode:'tunnel-service',tunnelServiceOperation:'live',larkTransport:'long-connection',larkAppId:'cli_0123456789abcdef',larkAppSecret:fixtureSecret,principal:'tunnel-owner:dot-bridge',callbackHosts:['callback.example']};
 const runtime=createLarkRuntime(c,{activeSubscription:()=>active},()=>now,{sdk,send:makePublicRequester({proxyEnv:{},request(){throw new Error('synthetic no network');}})});
 await runtime.start();assert.equal(starts,0);
 active={principal:'wrong',expires:2000};await runtime.syncSubscription();assert.equal(starts,0);
 active={principal:c.principal,expires:2000,url:'https://callback.example/path'};await runtime.syncSubscription();assert.equal(starts,1);
 now=2001;await runtime.syncSubscription();assert.equal(closes,1);runtime.close();
});
test('identity import needs fresh official evidence and exact confirmation, never first sender',t=>{
 const {dir}=fixture(t);const unbound={version:1,status:'unbound',appId:'cli_0123456789abcdef',appSecret:fixtureSecret,ownerOpenId:'owner'};
 const now=Date.now(), evidence={version:1,source:'operator-reviewed-official-source',sourceUrl:'https://open.feishu.cn/app',verifiedAt:new Date(now).toISOString(),appId:unbound.appId,tenantKey:'tenant',ownerOpenId:'owner',confirmedAppId:unbound.appId,confirmedTenantKey:'tenant',confirmedOwnerOpenId:'owner'};
 assert.throws(()=>verifyIdentityEvidence(unbound,evidence));
 for(const delta of [{source:'first-message'},{sourceUrl:'https://evil.example/app'},{confirmedOwnerOpenId:'stranger'},{ownerOpenId:'stranger',confirmedOwnerOpenId:'stranger'},{verifiedAt:new Date(now-2*86400000).toISOString()}]) assert.throws(()=>verifyIdentityEvidence(unbound,{...evidence,...delta},{approved:true,clock:()=>now}));
 let result;const report=importVerifiedIdentity({credentials:unbound,evidence,outputFile:path.join(dir,'registered.json'),approved:true,save(_file,value){result=value;}});
 assert.equal(result.status,'registered');assert.equal(result.tenantKey,'tenant');assert.equal(report.bridge_started,false);assert.equal(fs.existsSync(path.join(dir,'registered.json')),false);
});
test('shutdown retains mode lock until pending startup has settled and resources close',async()=>{
 let resolve, released=0,closed=0;const pending=new Promise(r=>{resolve=r;});
 const service=createPersistentService({bridgeMode:'tunnel',authMode:'oauth',larkTransport:'long-connection'},{approved:true,modeLock:()=>()=>{released++;},emit(){},schedule(){},unschedule(){},appFactory:()=>({listen:()=>pending,async close(){closed++;},larkRuntime:{status:()=> 'disabled'},readiness:()=>({})})});
 const starting=service.start();const closing=service.close();await Promise.resolve();assert.equal(released,0);resolve();await starting;await closing;assert.equal(closed,1);assert.equal(released,1);assert.equal(service.snapshot().lifecycle,'stopped');
});
test('persistent payload encryption survives restart without plaintext canaries and rejects corruption',async t=>{
 const { Store }=await import('../src/store.js');const {env}=fixture(t);const c=readConfig(env),now=Date.now();
 const canaries=['MESSAGE_CANARY_distinct_9281','REPLY_CANARY_distinct_8172','https://callback.example/PRIVATE_CANARY_7182','whsec_CALLBACK_SECRET_CANARY_8372'];
 let store=new Store(c);
 store.saveSubscription({id:'sub',principal:c.principal,url:canaries[2],secret:canaries[3],expires:now+60000,verified_until:now+60000},now);
 store.ingest({id:'message',sourceEventId:'event',owner:c.ownerOpenId,tenantKey:c.tenantKey,chatId:c.ownerChatId,text:canaries[0],timestamp:new Date(now).toISOString(),expires:now+60000},'replay',now);
 store.run('UPDATE messages SET attempted_at=? WHERE id=?',now,'message');store.queueReply('message',canaries[1],c.principal,now);
 for(const file of [c.dbPath,c.dbPath+'-wal']) if(fs.existsSync(file)){const bytes=fs.readFileSync(file);for(const text of canaries) assert.equal(bytes.includes(Buffer.from(text)),false);}
 store.close();store=new Store(c);
 try {
 assert.equal(store.message('message').text,canaries[0]);assert.equal(store.replyText('message'),canaries[1]);assert.equal(store.subscription('sub').url,canaries[2]);assert.equal(store.subscription('sub').secret,canaries[3]);
 assert.throws(()=>new Store({...c,storageKey:Buffer.alloc(32,9).toString('base64')}));
 store.run("UPDATE messages SET text='tampered' WHERE id='message'");assert.throws(()=>store.message('message'));
 } finally {store.close();}
});
test('raw library live configuration cannot forge loaded file provenance or independent storage key',async t=>{
 const {Store}=await import('../src/store.js');const {env}=fixture(t),c=readConfig(env);
 for(const delta of [{credentialsFile:undefined,pairedCredentialsLoaded:true},{larkAppSecret:'inline-fake-secret'},{storageKey:Buffer.alloc(32,3).toString('base64')},{expectedAppId:'cli_aaaaaaaaaaaaaaaa'},{storageKeyFile:c.tunnelServiceKeyFile,storageKey:Buffer.alloc(32,7).toString('base64')}]) {
   assert.throws(()=>new Store({...c,...delta}));assert.equal(fs.existsSync(c.dbPath),false);
 }
});
test('local listener cannot resurrect after closure and closes safely during startup',async t=>{
 const {env}=fixture(t);const app=createApp(readConfig(env),{approvedLive:true,worker:false});
 const listening=app.listen(0);const closing=app.close();await listening;await closing;
 assert.equal(app.server.listening,false);await assert.rejects(app.listen(0),/cannot restart/);await app.close();
});
test('persisted subscriptions cannot start provider after callback policy is removed or changed',async t=>{
 const {Store}=await import('../src/store.js');const {env}=fixture(t);const c=readConfig({...env,MCP_CALLBACK_ALLOWED_HOSTS:'callback.example'}),now=Date.now();
 let store=new Store(c);store.saveSubscription({id:'sub',principal:c.principal,url:'https://callback.example/path',secret:'synthetic',expires:now+60000,verified_until:now+60000},now);store.close();
 store=new Store(c);let starts=0;
 class Dispatcher{register(){return this;}async invoke(){}}
 class WS{async start(){starts++;}getConnectionStatus(){return {state:'connected'};}close(){}}
 const sdk={EventDispatcher:Dispatcher,WSClient:WS,LoggerLevel:{warn:1},Domain:{Feishu:'feishu'}};
 try {
   for(const hosts of [[],['different.example']]) {
     const runtime=createLarkRuntime({...c,callbackHosts:hosts},store,()=>now,{sdk,send:makePublicRequester({proxyEnv:{},request(){throw new Error('synthetic no network');}})});await runtime.start();await runtime.syncSubscription();assert.equal(starts,0);runtime.close();
   }
 } finally {store.close();}
});
test('queued reply cannot send or expose text after persisted callback policy replacement',async t=>{
 const {Store}=await import('../src/store.js');const {Bridge}=await import('../src/bridge.js');
 const {env}=fixture(t);const c=readConfig({...env,MCP_CALLBACK_ALLOWED_HOSTS:'callback.example'}),now=Date.now();
 let store=new Store(c);store.saveSubscription({id:'sub',principal:c.principal,url:'https://callback.example/path',secret:'synthetic',expires:now+60000,verified_until:now+60000},now);
 store.ingest({id:'message',sourceEventId:'event',owner:c.ownerOpenId,tenantKey:c.tenantKey,chatId:c.ownerChatId,text:'synthetic',timestamp:new Date(now).toISOString(),expires:now+60000},'r',now);
 store.run("UPDATE jobs SET state='delivered' WHERE kind='event'");store.run('UPDATE messages SET attempted_at=?',now);store.queueReply('message','synthetic reply',c.principal,now);store.close();
 let sends=0;const bridge=new Bridge({...c,callbackHosts:['different.example']},{clock:()=>now,send:makePublicRequester({proxyEnv:{},lookup:async()=>{sends++;throw Error('no network');},request:()=>{sends++;throw Error('no network');}})});
 try {
 await assert.rejects(bridge.rpc('tools/call',{name:'get_lark_message',arguments:{message_id:'message'}},{id:c.principal}));
 await assert.rejects(bridge.rpc('tools/call',{name:'reply_to_lark',arguments:{message_id:'message',text:'synthetic reply'}},{id:c.principal}));
 await bridge.tick();assert.equal(sends,0);assert.equal(bridge.store.replyStatus('message').status,'cancelled');
 }finally{bridge.store.close();}
});
