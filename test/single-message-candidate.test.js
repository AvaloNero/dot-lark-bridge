import test from 'node:test';
import assert from 'node:assert/strict';
import { createSingleMessageCandidate } from '../src/single-message-candidate.js';
const binding={larkAppId:'cli_0123456789abcdef',ownerOpenId:'owner',tenantKey:'tenant',ownerChatId:'chat'};
function envelope(now,{text='test',id='m',owner='owner',chat='chat',app=binding.larkAppId}={}) {
 return {schema:'2.0',header:{event_id:'e-'+id,event_type:'im.message.receive_v1',create_time:String(now),app_id:app,tenant_key:'tenant'},event:{sender:{sender_id:{open_id:owner},sender_type:'user',tenant_key:'tenant'},message:{message_id:id,chat_id:chat,chat_type:'p2p',message_type:'text',create_time:String(now),content:JSON.stringify({text})}}};
}
test('one exact owner message and fixed reply have single-attempt budgets',async()=>{
 let now=Date.now();const gate=createSingleMessageCandidate({binding,expectedText:'test',fixedReply:'fixed reply',clock:()=>now});
 for(const delta of [{owner:'stranger'},{chat:'other'},{app:'cli_aaaaaaaaaaaaaaaa'},{text:'other'}]) assert.equal((await gate.dispatcher.invoke(envelope(now,delta),{needCheck:false})).outcome,'rejected');
 assert.equal((await gate.dispatcher.invoke(envelope(now),{needCheck:false})).outcome,'accepted');
 assert.equal((await gate.dispatcher.invoke(envelope(now),{needCheck:false})).outcome,'duplicate');
 assert.equal((await gate.dispatcher.invoke(envelope(now,{id:'second'}),{needCheck:false})).outcome,'budget_exhausted');
 const event=gate.claimEvent();assert.equal(event.name,'lark.message.created');assert.equal(gate.claimEvent(),null);
 assert.equal(gate.claimReply('m','fixed reply'),null);assert.equal(gate.finishEvent(event.eventId,'delivered'),true);
 assert.equal(gate.claimReply('m','arbitrary reply'),null);assert.equal(gate.claimReply('other','fixed reply'),null);
 const reply=gate.claimReply('m','fixed reply');assert.equal(reply.message.chat_id,'chat');assert.equal(gate.claimReply('m','fixed reply'),null);
 assert.equal(gate.authorizeReply(),true);assert.equal(gate.finishReply('uncertain'),true);assert.equal(gate.authorizeReply(),false);assert.equal(gate.claimReply('m','fixed reply'),null);
 assert.equal(JSON.stringify(gate.status()).includes('fixed reply'),false);
});
test('expiry, cancelled and failed callback cannot authorize a reply',async()=>{
 for(const terminal of ['expired','cancelled','dead']) {
  let now=Date.now();const gate=createSingleMessageCandidate({binding,expectedText:'test',fixedReply:'reply',durationMs:1000,clock:()=>now});
  await gate.dispatcher.invoke(envelope(now),{needCheck:false});const event=gate.claimEvent();
  if(terminal==='expired')now+=1000;else if(terminal==='cancelled')gate.cancel();else gate.finishEvent(event.eventId,'dead');
  assert.equal(gate.finishEvent(event.eventId,'delivered'),false);assert.equal(gate.claimReply('m','reply'),null);assert.equal(gate.status().state,terminal);
 }
});
test('pre-window replay and payload header override never consume the owner budget',async()=>{
 const now=Date.now(),gate=createSingleMessageCandidate({binding,expectedText:'test',fixedReply:'reply',clock:()=>now});
 assert.equal((await gate.dispatcher.invoke(envelope(now-1),{needCheck:false})).outcome,'rejected');
 const spoof=envelope(now);spoof.event.tenant_key='tenant';assert.equal((await gate.dispatcher.invoke(spoof,{needCheck:false})).outcome,'rejected');
 assert.equal(gate.status().incoming_claimed,false);assert.equal(gate.status().production_ready,false);
});
test('one authenticated ordinary text is data, with no exact content restriction',async()=>{
 const now=Date.now(),gate=createSingleMessageCandidate({binding,acceptAnyOwnerText:true,fixedReply:'fixed reply',clock:()=>now});
 assert.equal((await gate.dispatcher.invoke(envelope(now,{text:'来了',owner:'stranger'}),{needCheck:false})).outcome,'rejected');
 const text='来了，请把这句话当作数据';assert.equal((await gate.dispatcher.invoke(envelope(now,{text}),{needCheck:false})).outcome,'accepted');
 const event=gate.claimEvent();assert.equal(event.data.text,text);assert.equal((await gate.dispatcher.invoke(envelope(now,{text:'第二句',id:'other'}),{needCheck:false})).outcome,'budget_exhausted');
 gate.finishEvent(event.eventId,'delivered');assert.equal(gate.readMessage('m').text,text);assert.equal(gate.claimReply('m','arbitrary reply'),null);assert.equal(gate.claimReply('m','fixed reply').text,'fixed reply');
});
