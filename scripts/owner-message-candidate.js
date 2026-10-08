import { pathToFileURL } from 'node:url';
export function ownerMessagePlan({waitForOwner=false}={}){if(typeof waitForOwner!=='boolean')throw new Error('Invalid owner wait mode');return{mode:'OFFLINE_OWNER_SINGLE_MESSAGE_CANDIDATE',wait_for_owner:waitForOwner,supports_wait_for_owner:true,channel:'lark',credential_read:false,provider_started:false,durable_subscription_required:true,max_incoming:1,max_reply_attempts:1,ordinary_callback_ready:false,final_destination_ip_verified:false};}
export function ownerMessageScope({waitForOwner=false,env=process.env,clock=Date.now}={}){
 if(typeof waitForOwner!=='boolean')throw new Error('Invalid owner wait mode');
 if(waitForOwner)return{waitForOwner:true};
 const duration=Number(env.OWNER_MESSAGE_WINDOW_SECONDS||300);
 if(!Number.isInteger(duration)||duration<30||duration>900)throw new Error('Invalid bounded owner window');
 return{waitForOwner:false,deadlineMs:clock()+duration*1000};
}
export async function startOwnerMessageCandidate({approved=false,waitForOwner=false,env=process.env}={}){
 if(typeof waitForOwner!=='boolean')throw new Error('Invalid owner wait mode');
 if(approved!==true)return ownerMessagePlan({waitForOwner});
 const scope=ownerMessageScope({waitForOwner,env});
 // Fixed review dependency, never an environment-selected module or network path.
 const shared=await import('../../dot-qq-bridge/packages/dot-bridge-transport/experimental/owner-message.js');
 const [{loadCredentials},{readTunnelReadinessConfig},{makeOwnerMessageProvider},{createLarkOwnerMessageSession},{createOwnerMessageRuntime}]=await Promise.all([
  import('../src/credentials.js'),import('../src/config.js'),import('../src/owner-message-provider.js'),import('../src/owner-message-session.js'),import('../src/owner-message-runtime.js')]);
 if(!env.OWNER_MESSAGE_DATABASE_PATH||!env.STORAGE_KEY_FILE||!env.OWNER_MESSAGE_FIXED_REPLY||!env.LARK_EXPECTED_APP_ID||!env.LARK_CREDENTIALS_FILE||!env.BRIDGE_LOCK_DIRECTORY)throw new Error('Explicit bounded candidate configuration required');
 const authConfig=readTunnelReadinessConfig({AUTH_MODE:'tunnel-service',BRIDGE_MODE:'tunnel',TUNNEL_SERVICE_OPERATION:'readiness',TUNNEL_SERVICE_OWNER_ID:'tunnel-owner:dot-bridge',HOST:'127.0.0.1',PORT:env.OWNER_MESSAGE_PORT||'3102',TUNNEL_SERVICE_KEY_FILE:env.TUNNEL_SERVICE_KEY_FILE});
 const credentials=loadCredentials(env.LARK_CREDENTIALS_FILE,{paired:true});if(credentials.appId!==env.LARK_EXPECTED_APP_ID)throw new Error('Approved application mismatch');
 const {acquireModeLock}=await import('../src/bridge-mode.js');
 const {openOwnerMessagePersistence,restoredTransportState}=await import('../src/owner-message-persistence.js');
 const release=acquireModeLock(env.BRIDGE_LOCK_DIRECTORY,'lark',credentials.appId,'tunnel');let persistence,runtime,session;
 try{
  persistence=openOwnerMessagePersistence({databasePath:env.OWNER_MESSAGE_DATABASE_PATH,storageKeyFile:env.STORAGE_KEY_FILE,serviceKeyFile:env.TUNNEL_SERVICE_KEY_FILE,lockDirectory:env.BRIDGE_LOCK_DIRECTORY,credentials});
  const checkpoint=persistence.ledger.load();
  const callbackTransport=shared.makeOwnerMessageExperimentTransport({approvedOwnerMessageExperiment:true,channel:'lark',acceptAnyOwnerText:true,...scope,restoredState:restoredTransportState(checkpoint),proxyEnv:env});
  const providerSend=makeOwnerMessageProvider({proxyEnv:env,...(scope.deadlineMs===undefined?{}:{deadlineMs:scope.deadlineMs})});
  session=createLarkOwnerMessageSession({credentials,expectedAppId:env.LARK_EXPECTED_APP_ID,acceptAnyOwnerText:true,fixedReply:env.OWNER_MESSAGE_FIXED_REPLY,authenticatedCallbackDiscovery:true,callbackTransport,recognizeTransport:shared.ownerMessageExperimentStatus,proxyEnv:env,providerSend,...scope,ledger:persistence.ledger,restoredCheckpoint:checkpoint});
  runtime=createOwnerMessageRuntime({session,authConfig,connectionConfig:{larkAppId:credentials.appId,larkAppSecret:credentials.appSecret,tenantKey:credentials.tenantKey,ownerOpenId:credentials.ownerOpenId,ownerChatId:credentials.ownerChatId},lockDirectory:env.BRIDGE_LOCK_DIRECTORY,...scope,providerSend,approved:true,modeLock:()=>release,onClose:()=>persistence.close()});
  await runtime.start();
 }catch{if(runtime)await runtime.close();else{session?.close();persistence?.close();release();}throw new Error('Candidate startup refused');}
 return runtime;
}
export function ownerMessageCliMode(args){
 if(args.length===0)return{approved:false,waitForOwner:false};
 if(args[0]!=='--confirm-owner-single-message-experiment'||args.length>2||(args.length===2&&args[1]!=='--wait-for-owner'))throw new Error('Exact candidate confirmation required');
 return{approved:true,waitForOwner:args.length===2};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const mode=ownerMessageCliMode(process.argv.slice(2));
  if(!mode.approved)process.stdout.write(JSON.stringify(ownerMessagePlan())+'\n');
  else{const runtime=await startOwnerMessageCandidate(mode);const stop=()=>runtime.close().catch(()=>{process.exitCode=1;});process.once('SIGINT',stop);process.once('SIGTERM',stop);process.stdout.write('Owner single-message candidate listening; provider waits for authenticated subscription.\n');}
 }catch{process.stderr.write('Owner-message candidate refused or failed; no secrets or identifiers printed.\n');process.exitCode=1;}
}
