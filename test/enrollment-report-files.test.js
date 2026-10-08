import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createEnrollmentFileReporter} from '../src/enrollment-report-files.js';
const appId='cli_0123456789abcdef';
function setup(t){const parent=fs.mkdtempSync(path.join(os.tmpdir(),'lark-report-fixture-'));fs.chmodSync(parent,0o700);t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));return path.join(parent,'attempt');}
test('report collector separates official handoff from fixed status and records actual exit',t=>{
 const directory=setup(t),reporter=createEnrollmentFileReporter({directory,appId});
 const url=`https://open.feishu.cn/page/launcher?user_code=SYNTHETIC&clientID=${appId}`;
 reporter.report({phase:'awaiting_owner_scan',verification_url:url,expires_at:new Date(Date.now()+60000).toISOString(),client_secret:'NEVER_LOG',device_code:'NEVER_LOG'});
 reporter.report({phase:'registration_http',action:'poll',status:400,request_number:4,body:'NEVER_LOG'});reporter.report({credentials_saved:true});reporter.finish(true);
 let state=JSON.parse(fs.readFileSync(path.join(directory,'status.json')));assert.equal(state.process_exit_hook_seen,false);reporter.heartbeat();reporter.heartbeat();reporter.closed(0);
 state=JSON.parse(fs.readFileSync(path.join(directory,'status.json')));assert.equal(state.process_exit_hook_seen,true);assert.equal(state.credentials_saved,true);assert.equal(state.heartbeat_count,2);assert.ok(state.heartbeat_at);assert.ok(state.pid>0);assert.equal(JSON.stringify(state).includes('SYNTHETIC'),false);assert.equal(JSON.stringify(state).includes('NEVER_LOG'),false);
 assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'handoff.json'))).verification_url,url);
 for(const file of ['status.json','handoff.json'])assert.equal(fs.statSync(path.join(directory,file)).mode&0o777,0o600);
});
test('invalid handoff aborts without changing SDK transport or writing the URL',t=>{
 const directory=setup(t);let aborted=false;const reporter=createEnrollmentFileReporter({directory,appId,onFailure(){aborted=true;}});
 reporter.report({verification_url:'https://evil.example/?client_secret=NEVER_LOG',expires_at:new Date(Date.now()+60000).toISOString()});assert.equal(aborted,true);assert.equal(fs.existsSync(path.join(directory,'handoff.json')),false);
});
test('heartbeats advance independently while an HTTP request has no response',t=>{
 const directory=setup(t),reporter=createEnrollmentFileReporter({directory,appId});
 reporter.report({phase:'registration_http_started',action:'poll',request_number:7});reporter.heartbeat();reporter.heartbeat();
 let state=JSON.parse(fs.readFileSync(path.join(directory,'status.json')));assert.equal(state.heartbeat_count,2);assert.equal(state.request_in_flight,true);assert.ok(state.last_request_started_at);assert.equal(state.last_response_at,undefined);
 reporter.report({phase:'registration_http',action:'poll',status:400});state=JSON.parse(fs.readFileSync(path.join(directory,'status.json')));assert.equal(state.request_in_flight,false);assert.ok(state.last_response_at);
 reporter.report({failure_code:'SYNTHETIC_SECRET'});assert.equal(JSON.stringify(reporter.status()).includes('SYNTHETIC_SECRET'),false);
 reporter.report({failure_code:'registration_timeout'});reporter.finish(false);assert.equal(reporter.status().failure_code,'registration_timeout');
});
test('synthetic foreground child leaves heartbeat and exit-hook evidence with no stdout',async t=>{
 const {spawn}=await import('node:child_process');const directory=setup(t);
 const moduleUrl=new URL('../src/enrollment-report-files.js',import.meta.url).href;
 const code=`import {createEnrollmentFileReporter} from ${JSON.stringify(moduleUrl)};const r=createEnrollmentFileReporter({directory:${JSON.stringify(directory)},appId:${JSON.stringify(appId)}});process.once('exit',code=>r.closed(code));const timer=setInterval(()=>r.heartbeat(),20);setTimeout(()=>{clearInterval(timer);r.finish(false);},90);`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
 const timer=setTimeout(()=>child.kill('SIGTERM'),3000);const exit=await new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));clearTimeout(timer);
 assert.deepEqual(exit,{code:0,signal:null});assert.equal(output,'');const state=JSON.parse(fs.readFileSync(path.join(directory,'status.json')));assert.ok(state.heartbeat_count>=2);assert.equal(state.process_exit_hook_seen,true);assert.equal(state.terminal,true);assert.equal(state.success,false);
});
test('proxy tunnel diagnostics retain only bounded status and boolean timeout',async t=>{
 const {makeRegistrationPost}=await import('../src/registration-transport.js');const directory=setup(t);const reporter=createEnrollmentFileReporter({directory,appId});
 const post=makeRegistrationPost({report:reporter.report,agentFactory:()=>({destroy(){}}),request(){throw Object.assign(new Error('SYNTHETIC_SECRET'),{code:'ERR_PROXY_TUNNEL',statusCode:407,proxyTunnelTimeout:1});}});
 await assert.rejects(post('https://accounts.feishu.cn/oauth/v1/app/registration','action=begin&archetype=PersonalAgent&auth_method=client_secret&request_user_info=open_id'));
 const state=reporter.status();assert.equal(state.errno,'ERR_PROXY_TUNNEL');assert.equal(state.proxy_status_code,407);assert.equal(state.proxy_tunnel_timeout,true);assert.equal(JSON.stringify(state).includes('SYNTHETIC_SECRET'),false);
 reporter.report({proxy_status_code:9999,proxy_tunnel_timeout:'SYNTHETIC_SECRET'});assert.equal(reporter.status().proxy_status_code,407);
});
