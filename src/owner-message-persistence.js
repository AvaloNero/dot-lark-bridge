import path from 'node:path';
import {Store} from './store.js';
import {readPrivateKey} from './tunnel-service-auth.js';
import {assertLiveStorage} from './live-storage.js';
import {createOwnerMessageLedger} from './owner-message-ledger.js';

// Storage-only reuse of the existing encrypted SQLite store, never a server
// configuration. Caller holds the application's existing exclusive mode lock.
export function openOwnerMessagePersistence({databasePath,storageKeyFile,serviceKeyFile,lockDirectory,credentials}){
 if(typeof databasePath!=='string'||!path.isAbsolute(databasePath)||!storageKeyFile||!serviceKeyFile)throw new Error('Private durable owner state references required');
 let store;
 try{
  const storage=readPrivateKey(storageKeyFile);if(storage===readPrivateKey(serviceKeyFile))throw new Error();
  const config={authMode:'deny',larkTransport:'disabled',bridgeMode:'tunnel',dbPath:databasePath,bridgeLockDirectory:lockDirectory,storageKey:Buffer.from(storage,'base64url').toString('base64'),principal:'tunnel-owner:dot-bridge',larkAppId:credentials.appId,ownerOpenId:credentials.ownerOpenId,tenantKey:credentials.tenantKey,ownerChatId:credentials.ownerChatId};
  assertLiveStorage(config);store=new Store(config);let closed=false;
  return{ledger:createOwnerMessageLedger(store),close:()=>{if(!closed){closed=true;store.close();}}};
 }catch{store?.close();throw new Error('Private durable owner state unavailable');}
}
export function restoredTransportState(checkpoint){
 if(!checkpoint)return undefined;
 const attempted=checkpoint.message!==null;
 return{url:checkpoint.subscription.url,subscription_id:checkpoint.subscription.id,valid_until:Math.min(checkpoint.subscription.validUntil,checkpoint.message?.expires??Infinity),challenge_verified:true,event_attempted:attempted,event_accepted:['event_delivered','reply_attempted','sent'].includes(checkpoint.phase),closed:!['waiting','event_delivered'].includes(checkpoint.phase)};
}
