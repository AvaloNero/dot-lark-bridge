export function ownerScopedProxy(config){return config.callbackTransportMode==='owner-scoped-proxy';}
export function assertCallbackMode(config){
 const mode=config.callbackTransportMode??'standard';
 if(!['standard','owner-scoped-proxy'].includes(mode)||(mode==='owner-scoped-proxy'&&(config.authMode!=='tunnel-service'||config.tunnelServiceOperation!=='live'||config.bridgeMode!=='tunnel'||config.principal!=='tunnel-owner:dot-bridge')))throw new Error('Explicit owner-scoped live callback mode required');
}
