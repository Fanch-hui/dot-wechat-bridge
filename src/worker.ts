import type { Env } from './core/config.ts';
import { Bridge } from './core/bridge.ts';
import { BridgeError, requireValue } from './core/errors.ts';
import { hash, equal } from './core/security.ts';
import { mcp } from './mcp/protocol.ts';
import { authorizeGateway, gateway, json } from './gateway-routes.ts';
import { admin } from './admin/routes.ts';
import { renderAdminPage } from './admin/page.ts';

declare const __BRIDGE_GATEWAY_BUNDLE__:string;
declare const __BRIDGE_ADMIN_CLIENT__:string;
declare const __BRIDGE_ADMIN_STYLE__:string;
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const asset=(body:string,type:string)=>new Response(body,{headers:{...headers,'Content-Type':type}});

export default {
  async fetch(request:Request,env:Env):Promise<Response> {
    const url=new URL(request.url);
    try {
      if(url.pathname==='/health') return Response.json({service:'dot-wechat-bridge',protocol:'2026-07-28',gateway_protocol:2,
        configured:!!env.DB && !!env.BRIDGE_TOKEN && !!env.DATA_KEY_B64});
      if((url.pathname==='/' || url.pathname==='/admin') && request.method==='GET') {
        const bridge=new Bridge(env),identity=request.headers.get('oai-authenticated-user-id');
        requireValue(identity,'authentication_required',401);
        const owner=await bridge.db.get('owner');
        requireValue(owner && equal(await hash(identity),owner),'owner_access_required',403);
        await bridge.participants.initializeLegacy();
        return new Response(renderAdminPage(),{headers:{...headers,'Content-Type':'text/html; charset=utf-8',
          'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'self'",
          'Referrer-Policy':'no-referrer'}});
      }
      if(url.pathname==='/admin/client.js' && request.method==='GET')
        return asset(typeof __BRIDGE_ADMIN_CLIENT__==='string'?__BRIDGE_ADMIN_CLIENT__:'','application/javascript; charset=utf-8');
      if(url.pathname==='/admin/style.css' && request.method==='GET')
        return asset(typeof __BRIDGE_ADMIN_STYLE__==='string'?__BRIDGE_ADMIN_STYLE__:'','text/css; charset=utf-8');
      if(url.pathname==='/gateway/main.js' && request.method==='GET') {
        authorizeGateway(request,env);
        return new Response(__BRIDGE_GATEWAY_BUNDLE__,{headers:{...headers,'Content-Type':'application/javascript; charset=utf-8',
          'Content-Disposition':'attachment; filename="main.mjs"'}});
      }
      if(url.pathname.startsWith('/api/admin/')) return await admin(request,new Bridge(env));
      if(request.method!=='POST') return Response.json({error:'method_not_allowed'},{status:405,headers:{Allow:'POST'}});
      if(url.pathname==='/mcp') {
        const origin=request.headers.get('Origin');
        requireValue(!origin || [url.origin,'https://chatgpt.com','https://chat.openai.com'].includes(origin),'origin_forbidden',403);
        return mcp(request,env,await json(request));
      }
      if(url.pathname.startsWith('/gateway/')) return Response.json(await gateway(request,env,url.pathname),{headers});
      return Response.json({error:'route_not_found'},{status:404});
    } catch(error) {
      if(error instanceof BridgeError) return Response.json({error:error.code},{status:error.status,headers});
      console.error('bridge_request_failed');return Response.json({error:'bridge_unavailable'},{status:503,headers});
    }
  },
};
