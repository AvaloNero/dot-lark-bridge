import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createScannedOwnerPairingSession,pairScannedOwner} from '../src/setup.js';
const credentials={version:1,status:'unbound',appId:'cli_0123456789abcdef',appSecret:'synthetic-private-secret',ownerOpenId:'known_scanner'};
function payload(text,now,change={}){const p={schema:'2.0',header:{app_id:credentials.appId,tenant_key:'verified_tenant',event_type:'im.message.receive_v1',event_id:'event',create_time:String(now)},event:{sender:{sender_type:'user',sender_id:{open_id:credentials.ownerOpenId},tenant_key:'verified_tenant'},message:{message_id:'m',chat_id:'private_chat',chat_type:'p2p',message_type:'text',create_time:String(now),content:JSON.stringify({text})}}};change.apply?.(p);return p;}
test('scanned owner challenge proves matching event tenant and private chat without tenant API',async()=>{
 const now=Date.now(),s=createScannedOwnerPairingSession(credentials,{clock:()=>now});
 for(const change of [p=>p.header.app_id='cli_aaaaaaaaaaaaaaaa',p=>p.event.sender.sender_id.open_id='first_stranger',p=>p.event.sender.tenant_key='other',p=>p.event.message.chat_type='group',p=>p.event.message.mentions=[{}],p=>p.event.tenant_key='verified_tenant']){
  assert.notEqual((await s.dispatcher.invoke(payload(s.challenge,now,{apply:change}),{needCheck:false})).outcome,'paired');
 }
 assert.notEqual((await s.dispatcher.invoke(payload('wrong challenge',now),{needCheck:false})).outcome,'paired');
 assert.notEqual((await s.dispatcher.invoke(payload(s.challenge,now),{needCheck:true})).outcome,'paired');
 assert.equal((await s.dispatcher.invoke(payload(s.challenge,now),{needCheck:false})).outcome,'paired');
 const paired=await s.completion;assert.equal(paired.ownerOpenId,credentials.ownerOpenId);assert.equal(paired.tenantKey,'verified_tenant');assert.equal(paired.ownerChatId,'private_chat');
 assert.equal((await s.dispatcher.invoke(payload(s.challenge,now),{needCheck:false})).outcome,'ignored');
});
test('unknown scan owner and expired/cancelled challenge fail closed',async()=>{
 assert.throws(()=>createScannedOwnerPairingSession({...credentials,ownerOpenId:undefined}));let now=Date.now();const s=createScannedOwnerPairingSession(credentials,{clock:()=>now,timeoutMs:10});now+=10;assert.equal((await s.dispatcher.invoke(payload(s.challenge,now),{needCheck:false})).outcome,'ignored');
 const c=createScannedOwnerPairingSession(credentials);c.cancel();assert.equal((await c.dispatcher.invoke(payload(c.challenge,Date.now()),{needCheck:false})).outcome,'ignored');
});
test('bounded scanned-owner flow displays challenge only after real ready callback and saves paired file once',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scanned-owner-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let report,dispatcher,challenge,saved,closed=0;
 const result=pairScannedOwner({credentials,expectedAppId:credentials.appId,confirmed:true,bindingFile:path.join(dir,'paired.json'),report:event=>{if(event.private_text_to_send)challenge=event.private_text_to_send;},save(_file,c){assert.equal(saved,undefined);saved=c;},connectionFactory(_c,d,o){dispatcher=d;report=o.report;return{async start(){},close(){closed++;}};}});
 await Promise.resolve();assert.equal(challenge,undefined);assert.equal((await dispatcher.invoke(payload('anything',Date.now()),{needCheck:false})).outcome,'ignored');report('lark_connected');assert.ok(challenge);
 await dispatcher.invoke(payload(challenge,Date.now()),{needCheck:false});const status=await result;assert.equal(status.owner_binding_complete,true);assert.equal(closed,1);assert.equal(saved.status,'paired');assert.equal(saved.tenantKey,'verified_tenant');
});
test('arbitrary ordinary text binds only exact scanner and messages created after readiness',async()=>{
 const {createScannedOwnerTestMessageSession,SCANNED_OWNER_TEST_TEXT}=await import('../src/setup.js');
 const now=Date.now(),s=createScannedOwnerTestMessageSession(credentials,{clock:()=>now});assert.equal(s.challenge,SCANNED_OWNER_TEST_TEXT);
 for(const p of [payload(SCANNED_OWNER_TEST_TEXT,now-1),payload(SCANNED_OWNER_TEST_TEXT,now,{apply:p=>p.event.sender.sender_id.open_id='stranger'}),payload(SCANNED_OWNER_TEST_TEXT,now,{apply:p=>p.event.sender.tenant_key='other'}),payload(SCANNED_OWNER_TEST_TEXT,now,{apply:p=>p.event.message.chat_type='group'})])assert.notEqual((await s.dispatcher.invoke(p,{needCheck:false})).outcome,'paired');
 assert.equal((await s.dispatcher.invoke(payload('来了',now),{needCheck:false})).outcome,'paired');const result=await s.completion;assert.equal(result.ownerOpenId,credentials.ownerOpenId);assert.equal(result.tenantKey,'verified_tenant');
 assert.equal((await s.dispatcher.invoke(payload(SCANNED_OWNER_TEST_TEXT,now),{needCheck:false})).outcome,'ignored');
});
test('ordinary test-message flow does not arm or display text before actual SDK ready',async t=>{
 const {pairScannedOwnerTestMessage,SCANNED_OWNER_TEST_TEXT}=await import('../src/setup.js');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'test-owner-bind-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let now=Date.now(),report,dispatcher,text,saved;const run=pairScannedOwnerTestMessage({credentials,expectedAppId:credentials.appId,confirmed:true,bindingFile:path.join(dir,'paired.json'),clock:()=>now,report:event=>{if(event.phase==='owner_message_ready')text='any';},save(_p,c){saved=c;},connectionFactory(_c,d,o){report=o.report;dispatcher=d;return{async start(){},close(){}};}});
 await Promise.resolve();assert.equal(text,undefined);const early=payload(SCANNED_OWNER_TEST_TEXT,now);assert.equal((await dispatcher.invoke(early,{needCheck:false})).outcome,'ignored');now+=1000;report('lark_connected');assert.equal(text,'any');
 assert.notEqual((await dispatcher.invoke(early,{needCheck:false})).outcome,'paired');await dispatcher.invoke(payload(SCANNED_OWNER_TEST_TEXT,now),{needCheck:false});await run;assert.equal(saved.status,'paired');
});
