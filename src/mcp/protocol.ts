import { Bridge } from "../core/bridge.ts";
import { BridgeError } from "../core/errors.ts";
import { CallbackError } from "../events/subscriptions.ts";
import { eventDefinition } from "../events/catalog.ts";
import { tools } from "./catalog.ts";
import { callTool } from "./tools.ts";
import { Env } from "../core/config.ts";

const MODERN='2026-07-28';
const LEGACY=['2025-11-25','2025-06-18','2024-11-05'];
interface Rpc {jsonrpc?:string;id?:unknown;method?:string;params?:Record<string,any>}
const response=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
const error=(id:unknown,code:number,message:string,status=400,data?:unknown)=>response({jsonrpc:'2.0',id:id??null,error:{code,message,...(data?{data}:{})}},status);
function decode(value:string|null) {
  if (!value?.startsWith('=?base64?')) return value;
  try {return new TextDecoder().decode(Uint8Array.from(atob(value.slice(9,-2)),c=>c.charCodeAt(0)));} catch {return null;}
}
export async function mcp(request:Request,env:Env,rpc:Rpc) {
  if (rpc.jsonrpc!=='2.0' || typeof rpc.method!=='string' || Array.isArray(rpc)) return error(rpc.id,-32600,'Invalid request');
  const params=rpc.params??{};
  const meta=params._meta;
  const modern=rpc.method==='server/discover' || rpc.method.startsWith('events/') || meta?.['io.modelcontextprotocol/protocolVersion']!==undefined || request.headers.get('MCP-Protocol-Version')===MODERN;
  if (modern) {
    const version=meta?.['io.modelcontextprotocol/protocolVersion'];
    if (version!==MODERN) return error(rpc.id,-32022,'Unsupported protocol version',400,{supported:[MODERN],requested:version??null});
    if (!meta?.['io.modelcontextprotocol/clientCapabilities'] || typeof meta['io.modelcontextprotocol/clientCapabilities']!=='object') return error(rpc.id,-32602,'Client capabilities required');
    if (request.headers.get('MCP-Protocol-Version')!==version || request.headers.get('Mcp-Method')!==rpc.method ||
      (rpc.method==='tools/call' && decode(request.headers.get('Mcp-Name'))!==params.name)) return error(rpc.id,-32020,'MCP headers mismatch');
  } else {
    const header=request.headers.get('MCP-Protocol-Version');
    if (header && !LEGACY.includes(header)) return error(rpc.id,-32022,'Unsupported protocol version',400,{supported:LEGACY,requested:header});
  }
  if (rpc.id===undefined) {
    if (rpc.method==='notifications/initialized' || rpc.method==='notifications/cancelled') return new Response(null,{status:202});
    return error(null,-32600,'Requests require an id');
  }
  const complete=(result:Record<string,unknown>)=>response({jsonrpc:'2.0',id:rpc.id,result:{...(modern?{resultType:'complete'}:{}),...result}});
  try {
    if (rpc.method==='server/discover') return complete({supportedVersions:[MODERN],capabilities:{tools:{},events:{},resources:{}},
      _meta:{'io.modelcontextprotocol/serverInfo':{name:'dot-wechat-bridge',version:'0.1.0'}}});
    if (rpc.method==='initialize' && !modern) return complete({protocolVersion:LEGACY.includes(params.protocolVersion)?params.protocolVersion:LEGACY[1],
      capabilities:{tools:{},resources:{}},serverInfo:{name:'dot-wechat-bridge',version:'0.1.0'}});
    if (rpc.method==='ping') return complete({});
    if (rpc.method==='tools/list') return complete({tools});
    if (rpc.method==='events/list') return complete({events:[eventDefinition]});
    if (!['tools/call','resources/list','resources/read','events/subscribe','events/unsubscribe'].includes(rpc.method)) return error(rpc.id,-32601,'Method not found',modern?404:200);
    const bridge=new Bridge(env);
    const owner=await bridge.owner(request.headers.get('oai-authenticated-user-id'));
    if (rpc.method==='resources/list') return complete({resources:[]});
    if (rpc.method==='resources/read') {
      if (typeof params.uri!=='string' || params.uri.length>1024) return error(rpc.id,-32602,'Invalid resource URI');
      return complete(await bridge.attachments.readResource(params.uri));
    }
    if (rpc.method==='tools/call') {
      if (typeof params.name!=='string' || !params.arguments || typeof params.arguments!=='object' || Array.isArray(params.arguments)) return error(rpc.id,-32602,'Invalid tool arguments');
      return complete(await callTool(bridge,params.name,params.arguments));
    }
    if (rpc.method==='events/subscribe') return complete(await bridge.subscriptions.subscribe(owner,params));
    return complete(await bridge.subscriptions.unsubscribe(owner,params));
  } catch(failure) {
    if (failure instanceof CallbackError) return error(rpc.id,-32015,'Callback endpoint error',400,{reason:failure.reason});
    if (failure instanceof BridgeError) return error(rpc.id,-32602,failure.code,failure.status);
    console.error('bridge_request_failed');
    return error(rpc.id,-32603,'Bridge unavailable',500);
  }
}
