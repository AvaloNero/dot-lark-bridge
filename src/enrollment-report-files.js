import fs from 'node:fs';
import path from 'node:path';
const phases=new Set(['starting','registration_http_started','registration_http','registration_transport_error','awaiting_owner_scan','confirmed_awaiting_storage_approval','saved_unbound_after_explicit_storage_approval','registration_failed','abort','access_denied','expired_token','unsupported_tenant_brand','verification_link_refused','finished']);
const failures=new Set(['enrollment_runner_failed','report_write_failed','registration_timeout','registration_connection_refused','registration_proxy_refused','registration_proxy_required','registration_http_refused','registration_response_failed','registration_response_invalid','registration_response_limit','registration_target_refused','registration_parameters_refused']);
export function createEnrollmentFileReporter({directory,appId,onFailure=()=>{}}){
 if(!path.isAbsolute(directory)||!/^cli_[a-fA-F0-9]{16}$/.test(appId))throw new Error('Invalid report destination');
 for(let p=path.dirname(directory);;p=path.dirname(p)){const s=fs.lstatSync(p);if(s.isSymbolicLink())throw new Error('Unsafe report path');if(path.dirname(p)===p)break;}
 const parent=fs.statSync(path.dirname(directory));if(parent.uid!==process.getuid()||(parent.mode&0o777)!==0o700)throw new Error('Private report parent required');
 fs.mkdirSync(directory,{mode:0o700});let counter=0,failed=false;
 const state={phase:'starting',terminal:false,process_exit_hook_seen:false,credentials_saved:false,handoff_ready:false,heartbeat_count:0,pid:process.pid,started_at:new Date().toISOString()};
 function write(name,value){
  const temp=path.join(directory,`.${name}.${++counter}.tmp`);const fd=fs.openSync(temp,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temp,path.join(directory,name));
 }
 function report(value){
  try{
   if(value.verification_url!==undefined){
    const url=new URL(value.verification_url);const expiry=Date.parse(value.expires_at);
    if(url.protocol!=='https:'||!['open.feishu.cn','accounts.feishu.cn'].includes(url.hostname)||url.username||url.password||url.hash||(url.port&&url.port!=='443')||url.searchParams.getAll('clientID').length!==1||url.searchParams.get('clientID')!==appId||url.searchParams.getAll('createOnly').includes('true')||[...url.searchParams.keys()].some(k=>/^(app_secret|client_secret|device_code|access_token|refresh_token)$/i.test(k))||!Number.isFinite(expiry)||expiry<=Date.now()||expiry>Date.now()+3615000||state.handoff_ready)throw new Error();
    write('handoff.json',{verification_url:value.verification_url,expires_at:value.expires_at});state.handoff_ready=true;state.expires_at=value.expires_at;
   }
   if(phases.has(value.phase))state.phase=value.phase;
   if(value.phase==='registration_http_started'){state.request_in_flight=true;state.last_request_started_at=new Date().toISOString();}
   if(value.phase==='registration_http'){state.request_in_flight=false;state.last_response_at=new Date().toISOString();}
   if(['begin','poll'].includes(value.action))state.action=value.action;
   if(Number.isInteger(value.status)&&[200,400].includes(value.status))state.http_status=value.status;
   for(const key of ['request_number','elapsed_ms','poll_updates','remaining_seconds'])if(Number.isInteger(value[key])&&value[key]>=0)state[key]=value[key];
   if(['ERR_PROXY_TUNNEL','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','ENOTFOUND','EHOSTUNREACH','ENETUNREACH','EPIPE','ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNKNOWN','REQUEST_TIMEOUT','RESPONSE_ABORTED'].includes(value.errno)){state.errno=value.errno;state.request_in_flight=false;state.last_error_at=new Date().toISOString();}
   if(Number.isInteger(value.proxy_status_code)&&value.proxy_status_code>=100&&value.proxy_status_code<=599)state.proxy_status_code=value.proxy_status_code;
   if(typeof value.proxy_tunnel_timeout==='boolean')state.proxy_tunnel_timeout=value.proxy_tunnel_timeout;
   if(failures.has(value.failure_code))state.failure_code=value.failure_code;
   if(value.credentials_saved===true)state.credentials_saved=true;
   state.updated_at=new Date().toISOString();write('status.json',state);
  }catch{failed=true;state.failure_code='report_write_failed';try{onFailure();}catch{}}
 }
 report({phase:'starting'});
 return {report,heartbeat(){state.heartbeat_count++;state.heartbeat_at=new Date().toISOString();state.uptime_seconds=Math.floor(process.uptime());report({});},status:()=>({...state,report_failed:failed}),finish(success){state.terminal=true;state.success=success===true&&!failed;report({phase:'finished'});},closed(code){state.process_exit_hook_seen=true;state.exit_code=Number.isInteger(code)?code:1;report({});},shouldStop(){return fs.existsSync(path.join(directory,'stop.request'));}};
}
