import http from 'node:http';
import { TextDecoder } from 'node:util';
import { createAuthenticator } from './auth.js';
import { validateMcp } from './server.js';
import { expectedBackendTools, liveEventDefinitions } from '../../dot-qq-bridge/packages/dot-bridge-tunnel/src/catalog.js';
import { createLarkConnection } from './lark-runtime.js';
import { acquireModeLock } from './bridge-mode.js';
import { object, rpcResult, toolResult } from './common.js';

// No environment adapter/module selection and no default activation. The caller
// supplies the separately approved isolated session and verified file config.
export function createOwnerMessageRuntime({session,authConfig,connectionConfig,lockDirectory,deadlineMs,providerSend,approved=false,
  clock=Date.now,authenticateFactory=createAuthenticator,connectionFactory=createLarkConnection,modeLock=acquireModeLock}={}) {
 let server,gateway,release,timer,closing,started=false,stopping=false,authenticate,startSettled,finishStart,effectiveDeadline=deadlineMs;
 function active(){if(stopping||clock()>=effectiveDeadline)throw new Error('Candidate stopped');}
 const close=()=>{
  if(!closing)closing=(async()=>{stopping=true;clearTimeout(timer);session.close();gateway?.close();await startSettled;if(server)await new Promise(resolve=>server.close(resolve));release?.();})();return closing;
 };
 const laterClose=()=>setImmediate(()=>close().catch(()=>{}));
 async function rpc(method,params,principal){
  active();
  const catalog={ttlMs:0,cacheScope:'private'};
  if(method==='server/discover'){object(params,['_meta']);return{supportedVersions:['2026-07-28'],capabilities:{tools:{},events:{}},...catalog};}
  if(method==='ping'){object(params,['_meta']);return{};}
  if(method==='tools/list'){object(params,['cursor','_meta']);if(params.cursor!=null)throw Error();return{tools:expectedBackendTools('lark',true),...catalog};}
  if(method==='events/list'){object(params,['cursor','_meta']);if(params.cursor!=null)throw Error();return{events:[liveEventDefinitions.lark],...catalog};}
  if(method==='events/subscribe'||method==='events/unsubscribe'){
   object(params,['name','arguments','delivery','ttlMs','cursor','_meta'],['name','arguments','delivery']);object(params.arguments,['conversation'],['conversation']);
   if(params.name!=='lark.message.created'||params.arguments.conversation!=='owner'||params.cursor!=null)throw Error();
   const sub=method==='events/subscribe';object(params.delivery,sub?['mode','url','secret']:['mode','url'],sub?['mode','url','secret']:['mode','url']);if(params.delivery.mode!=='webhook')throw Error();
   if(!sub){session.unsubscribe(params.delivery.url,principal);gateway?.close();laterClose();return{};}
   if(params.ttlMs!=null&&(!Number.isSafeInteger(params.ttlMs)||params.ttlMs<=0))throw Error();
   const scopedPrincipal=params.ttlMs==null?principal:{...principal,validUntil:Math.min(principal.validUntil,clock()+params.ttlMs)};
   const result=await session.subscribe({url:params.delivery.url,secret:params.delivery.secret},scopedPrincipal);
   const subscriptionDeadline=Date.parse(result.refreshBefore);if(!Number.isFinite(subscriptionDeadline))throw Error();
   effectiveDeadline=Math.min(effectiveDeadline,subscriptionDeadline);active();
   clearTimeout(timer);timer=setTimeout(laterClose,Math.max(1,effectiveDeadline-clock()));
   gateway=connectionFactory(connectionConfig,{invoke:envelope=>session.receive(envelope)},{autoReconnect:false,...(providerSend?{send:providerSend}:{})});
   await gateway.start();active();return{...result,cursor:null,truncated:false};
  }
  if(method==='tools/call'){
   object(params,['name','arguments','_meta'],['name','arguments']);
   if(params.name==='check_lark_setup'){object(params.arguments,['callback_url']);return toolResult(session.setup(params.arguments.callback_url));}
   if(params.name==='get_lark_message'){object(params.arguments,['message_id'],['message_id']);return toolResult(session.readMessage(params.arguments.message_id,principal));}
   if(params.name==='reply_to_lark'){object(params.arguments,['message_id','text'],['message_id','text']);const result=await session.reply(params.arguments.message_id,params.arguments.text,principal);laterClose();return toolResult({message_id:params.arguments.message_id,...result,error:null});}
  }
  throw new Error('Unsupported candidate method');
 }
 return Object.freeze({close,status:()=>({started,stopping,gateway_connected:gateway?.status?.()==='connected',...session.status()}),
  async start(){
   if(approved!==true||started||stopping||authConfig?.authMode!=='tunnel-service'||authConfig?.tunnelServiceOperation!=='readiness'||
    authConfig?.principal!=='tunnel-owner:dot-bridge'||!['127.0.0.1','::1'].includes(authConfig.host)||!Number.isSafeInteger(deadlineMs)||deadlineMs<=clock()||deadlineMs>clock()+900000)throw new Error('Explicit isolated runtime approval and bounded loopback configuration required');
   started=true;startSettled=new Promise(resolve=>{finishStart=resolve;});
   try{
    authenticate=authenticateFactory(authConfig,async()=>{throw new Error('No OAuth network');},clock);
    release=modeLock(lockDirectory,'lark',connectionConfig.larkAppId,'tunnel');
    server=http.createServer(async(req,res)=>{
     let id=null;
     const respond=(status,value)=>{if(!res.destroyed&&!res.headersSent){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}};
     try{
      active();if(req.method!=='POST'||req.url!=='/mcp'||req.headers.origin!==undefined||!['127.0.0.1','localhost','[::1]'].includes(new URL(`http://${req.headers.host}`).hostname))throw Error();
      const principal=await authenticate(req);if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')||req.headers['content-encoding'])throw Error();
      let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>32768)throw Error();chunks.push(chunk);}
      const request=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));id=request.id??null;
      const params=validateMcp(request,req.headers);if(!Object.hasOwn(request,'id'))throw Error();
      respond(200,rpcResult(id,await rpc(request.method,params,principal)));
     }catch{if(clock()>=effectiveDeadline)laterClose();respond(400,{jsonrpc:'2.0',id,error:{code:-32012,message:'Isolated owner-message request rejected'}});}
    });
    server.requestTimeout=10000;server.headersTimeout=10000;server.timeout=15000;server.keepAliveTimeout=1000;
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(authConfig.port,authConfig.host,resolve);});
    active();timer=setTimeout(laterClose,Math.max(1,deadlineMs-clock()));return server.address();
   }catch{finishStart?.();await close();throw new Error('Isolated runtime startup failed');}finally{finishStart?.();}
  }
 });
}
