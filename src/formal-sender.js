import {makeOwnerScopedProxyTransport} from '../../dot-qq-bridge/packages/dot-bridge-transport/owner-scoped.js';
import {createServiceSender,makePublicRequester} from './network.js';
import {assertCallbackMode,ownerScopedProxy} from './callback-mode.js';

// Explicit formal configuration selects a statically imported implementation.
// No module paths, credentials, readiness claims or arbitrary adapters from env.
export function createFormalServiceSender(config,{proxyEnv=process.env,transportFactory=makeOwnerScopedProxyTransport}={}){
 assertCallbackMode(config);
 if(!ownerScopedProxy(config))return createServiceSender({proxyEnv});
 return makePublicRequester({proxyEnv,callbackTransport:transportFactory({channel:'lark',proxyEnv})});
}
