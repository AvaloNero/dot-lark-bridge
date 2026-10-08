import fs from 'node:fs';import path from 'node:path';
import {loadCredentials} from '../src/credentials.js';
import {assertPrivateDestination} from '../src/private-files.js';
import {pairScannedOwner,pairScannedOwnerTestMessage,SCANNED_OWNER_TEST_TEXT} from '../src/setup.js';
import {acquireModeLock} from '../src/bridge-mode.js';
const [appId,input,bindingFile,directory,lockDirectory,approval]=process.argv.slice(2);
if(process.argv.length!==8||!['--confirm-scan-owner-pairing','--confirm-scanned-owner-test-message'].includes(approval)){process.stderr.write('Exact scanned-owner pairing approval and private paths required.\n');process.exit(1);}
let release,timer,seq=0;const controller=new AbortController();const state={phase:'starting',terminal:false,paired_saved:false,heartbeat_count:0,process_exit_hook_seen:false};
function write(name,value){const temp=path.join(directory,`.${++seq}.tmp`);const fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,path.join(directory,name));}
function status(){state.updated_at=new Date().toISOString();write('status.json',state);}
try{
 assertPrivateDestination(directory);fs.mkdirSync(directory,{mode:0o700});assertPrivateDestination(bindingFile);
 const c=loadCredentials(input);if(c.appId!==appId||c.status!=='unbound'||!c.ownerOpenId)throw Error();
 release=acquireModeLock(lockDirectory,'lark',appId,'tunnel');
 process.once('exit',code=>{try{state.process_exit_hook_seen=true;state.exit_code=code;status();}catch{}});
 for(const name of ['SIGINT','SIGTERM','SIGHUP'])process.once(name,()=>controller.abort());
 timer=setInterval(()=>{try{state.heartbeat_count++;state.heartbeat_at=new Date().toISOString();status();if(fs.existsSync(path.join(directory,'stop.request')))controller.abort();}catch{state.report_failed=true;controller.abort();}},2000);timer.unref();status();
 const testMessage=approval==='--confirm-scanned-owner-test-message';
 const result=await (testMessage?pairScannedOwnerTestMessage:pairScannedOwner)({credentials:c,expectedAppId:appId,confirmed:true,bindingFile,signal:controller.signal,connectionTimeoutMs:60000,timeoutMs:300000,report(value){
  if(['lark_connected','lark_reconnected','lark_connection_failed','owner_private_chat_bound'].includes(value.phase))state.phase=value.phase;
  if(value.phase==='owner_binding_event'&&['closed','envelope_rejected','app_or_event_rejected','owner_rejected','tenant_rejected','conversation_rejected','message_type_rejected','freshness_or_challenge_rejected','accepted','message_validation_rejected'].includes(value.classification)){state.binding_event_count=(state.binding_event_count||0)+1;state.last_binding_classification=value.classification;}
  if(value.phase==='owner_message_ready'){
   const expires_at=new Date(Date.now()+value.expires_in_seconds*1000).toISOString();write('handoff.json',{accepts_any_plain_text:true,expires_at});state.phase='awaiting_owner_message';state.expires_at=expires_at;state.handoff_ready=true;
  }
  if(value.phase==='pairing_challenge'){
   if(testMessage?value.private_text_to_send!==SCANNED_OWNER_TEST_TEXT:!/^pair [A-Za-z0-9_-]{32}$/.test(value.private_text_to_send))throw Error();
   const expires_at=new Date(Date.now()+value.expires_in_seconds*1000).toISOString();write('handoff.json',{private_text_to_send:value.private_text_to_send,expires_at});state.phase=testMessage?'awaiting_owner_test_message':'awaiting_owner_challenge';state.expires_at=expires_at;state.handoff_ready=true;
  }
  status();
 }});
 state.paired_saved=result.owner_binding_complete===true;state.terminal=true;state.success=state.paired_saved;status();if(!state.success)process.exitCode=1;
}catch{state.phase='pairing_failed';state.terminal=true;state.success=false;process.exitCode=1;try{status();}catch{}process.stderr.write('Pairing failed; no identifiers, messages or secrets printed.\n');}
finally{clearInterval(timer);try{release?.();}catch{state.lock_release_failed=true;try{status();}catch{}}}
