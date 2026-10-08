import test from 'node:test';
import assert from 'node:assert/strict';
import {createLarkConnection,createFeishuAgent} from '../src/lark-runtime.js';

test('SDK discovery and every reconnect dial recheck current authorization',async()=>{
 let allowed=true,options,calls=0,closed=0;
 const sdk={Domain:{Feishu:'synthetic'},LoggerLevel:{warn:2},WSClient:class{constructor(value){options=value;}async start(){}close(){closed++;}}};
 const connection=createLarkConnection({larkAppId:'cli_0123456789abcdef',larkAppSecret:'synthetic-secret'}, {}, {sdk,authorize(){if(!allowed)throw Error('revoked');},send:async(_url,r)=>{r.beforeConnect();calls++;return{status:200,body:Buffer.from(JSON.stringify({code:0,data:{URL:'wss://socket.feishu.cn/endpoint'}}))};}});
 try{await connection.start();assert.equal(options.autoReconnect,true);await options.httpInstance.request({url:'https://open.feishu.cn/callback/ws/endpoint',method:'POST',headers:{},data:{}});assert.equal(calls,1);allowed=false;await assert.rejects(options.httpInstance.request({url:'https://open.feishu.cn/callback/ws/endpoint',method:'POST',headers:{},data:{}}));assert.equal(calls,1);assert.throws(()=>options.agent.addRequest({}, {hostname:'socket.feishu.cn',port:443,servername:'socket.feishu.cn'}));}finally{connection.close();}assert.equal(closed,1);
});
test('closing a connection aborts its in-flight discovery provider request',async()=>{
 let options,signal;
 const sdk={Domain:{Feishu:'synthetic'},LoggerLevel:{warn:2},WSClient:class{constructor(value){options=value;}async start(){}close(){}}};
 const connection=createLarkConnection({larkAppId:'cli_0123456789abcdef',larkAppSecret:'synthetic-secret'}, {}, {sdk,send:async(_url,r)=>{signal=r.signal;r.beforeConnect();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('stopped')),{once:true}));}});
 await connection.start();const pending=options.httpInstance.request({url:'https://open.feishu.cn/callback/ws/endpoint',method:'POST',headers:{},data:{}});connection.close();await assert.rejects(pending);assert.equal(signal.aborted,true);
});
test('direct DNS authorization is rechecked after resolution without a socket',async()=>{
 let allowed=true;const agent=createFeishuAgent(async()=>{allowed=false;return[{address:'8.8.8.8',family:4}];},{proxyEnv:{},authorize(){if(!allowed)throw Error('revoked');}});
 try{await assert.rejects(new Promise((resolve,reject)=>agent.options.lookup('socket.feishu.cn',{},error=>error?reject(error):resolve())));}finally{agent.destroy();}
});
