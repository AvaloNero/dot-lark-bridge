import { pathToFileURL } from 'node:url';
export function ownerMessagePlan(){return{mode:'OFFLINE_OWNER_SINGLE_MESSAGE_CANDIDATE',channel:'lark',credential_read:false,provider_started:false,max_incoming:1,max_reply_attempts:1,ordinary_callback_ready:false,final_destination_ip_verified:false};}
export async function startOwnerMessageCandidate({approved=false,env=process.env}={}){
 if(approved!==true)return ownerMessagePlan();
 // Fixed review dependency, never an environment-selected module or network path.
 const shared=await import('../../dot-qq-bridge/packages/dot-bridge-transport/experimental/owner-message.js');
 const [{loadCredentials},{readTunnelReadinessConfig},{makeOwnerMessageProvider},{createLarkOwnerMessageSession},{createOwnerMessageRuntime}]=await Promise.all([
  import('../src/credentials.js'),import('../src/config.js'),import('../src/owner-message-provider.js'),import('../src/owner-message-session.js'),import('../src/owner-message-runtime.js')]);
 const duration=Number(env.OWNER_MESSAGE_WINDOW_SECONDS||300);
 if(!Number.isInteger(duration)||duration<30||duration>900||!env.OWNER_MESSAGE_FIXED_REPLY||!env.LARK_EXPECTED_APP_ID||!env.LARK_CREDENTIALS_FILE||!env.BRIDGE_LOCK_DIRECTORY)throw new Error('Explicit bounded candidate configuration required');
 const authConfig=readTunnelReadinessConfig({AUTH_MODE:'tunnel-service',BRIDGE_MODE:'tunnel',TUNNEL_SERVICE_OPERATION:'readiness',TUNNEL_SERVICE_OWNER_ID:'tunnel-owner:dot-bridge',HOST:'127.0.0.1',PORT:env.OWNER_MESSAGE_PORT||'3102',TUNNEL_SERVICE_KEY_FILE:env.TUNNEL_SERVICE_KEY_FILE});
 const credentials=loadCredentials(env.LARK_CREDENTIALS_FILE,{paired:true});if(credentials.appId!==env.LARK_EXPECTED_APP_ID)throw new Error('Approved application mismatch');
 const deadlineMs=Date.now()+duration*1000;
 const callbackTransport=shared.makeOwnerMessageExperimentTransport({approvedOwnerMessageExperiment:true,channel:'lark',acceptAnyOwnerText:true,deadlineMs,proxyEnv:env});
 const providerSend=makeOwnerMessageProvider({proxyEnv:env,deadlineMs});
 const session=createLarkOwnerMessageSession({credentials,expectedAppId:env.LARK_EXPECTED_APP_ID,acceptAnyOwnerText:true,fixedReply:env.OWNER_MESSAGE_FIXED_REPLY,authenticatedCallbackDiscovery:true,callbackTransport,recognizeTransport:shared.ownerMessageExperimentStatus,proxyEnv:env,providerSend,deadlineMs});
 const runtime=createOwnerMessageRuntime({session,authConfig,connectionConfig:{larkAppId:credentials.appId,larkAppSecret:credentials.appSecret,tenantKey:credentials.tenantKey,ownerOpenId:credentials.ownerOpenId,ownerChatId:credentials.ownerChatId},lockDirectory:env.BRIDGE_LOCK_DIRECTORY,deadlineMs,providerSend,approved:true});
 try{await runtime.start();}catch{await runtime.close();throw new Error('Candidate startup refused');}
 return runtime;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length===2)process.stdout.write(JSON.stringify(ownerMessagePlan())+'\n');
 else if(process.argv.length!==3||process.argv[2]!=='--confirm-owner-single-message-experiment'){
  process.stderr.write('Candidate requires its exact explicit confirmation; no credentials read.\n');process.exitCode=1;
 }else{
  try{const runtime=await startOwnerMessageCandidate({approved:true});const stop=()=>runtime.close().catch(()=>{process.exitCode=1;});process.once('SIGINT',stop);process.once('SIGTERM',stop);process.stdout.write('Owner single-message candidate listening; provider waits for authenticated subscription.\n');}
  catch{process.stderr.write('Owner-message candidate refused or failed; no secrets or identifiers printed.\n');process.exitCode=1;}
 }
}
