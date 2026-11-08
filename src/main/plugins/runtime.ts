import {pluginBridge} from '../web/plugin-bridge'
import {applicationRoot} from '../resources'
import {authenticate} from '../agent-access'
import {APP_HOME} from '../../shared/protocol'
import {authorize} from '../authorization'
import {withCaller,requestContext,isAppAdministrator,requireAppAdministrator} from '../authorization'
import {pluginScope,pluginAccessEntry,grantCreatedPluginResources} from './access'
import {readStore} from '../store'
import {employeeSettings} from '../../shared/types'
import {randomUUID as requestId} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { requirePlugin, pluginFile } from './registry'
import { openMailbox } from './mailbox'
import { pluginWorkspaceBase } from '../workspaces'
import type { PluginDescriptor, PluginFactory, PluginRuntime, PluginRequest, PluginResponse } from '../../shared/plugins'

const requireModule=createRequire(__filename)
const instances=new Map<string,Promise<{plugin:PluginDescriptor;runtime:PluginRuntime}>>()
const views=new Map<string,{server:http.Server;close:()=>Promise<void>}>()
const mailboxes=new Map<string,{workspace:string;opened:Promise<()=>void>}>()
function legacyAccess(id:string,workspace:string,plugin=requirePlugin(id)){const principal=requestContext().principal,employee=principal.kind==='agent'?readStore().sessions.find(p=>p.id===principal.employeeId):undefined,settings=employee&&employeeSettings(readStore(),employee);return !!(employee&&plugin.scope!=='application'&&settings?.mode==='work'&&settings.pluginId===id&&fs.existsSync(employee.cwd)&&fs.realpathSync(employee.cwd)===workspace&&pluginAccessEntry(id,workspace).revision===0)}
export async function prepareWorkspacePlugins(workspace:string,pluginId:string,employeeId:string) {
  workspace=fs.realpathSync(workspace)
  const plugin=requirePlugin(pluginId)
    const root=path.join(APP_HOME,'agent-access',employeeId);fs.mkdirSync(root,{recursive:true,mode:0o700})
    const directory=path.join(root,'ipc',plugin.id)
    let ancestor=directory;while(!fs.existsSync(ancestor))ancestor=path.dirname(ancestor)
    const actual=fs.realpathSync(ancestor),base=fs.realpathSync(root);if(actual!==base&&!actual.startsWith(base+path.sep))throw new Error('Plugin mailbox escapes employee runtime')
    if(!mailboxes.has(directory)) {
      const stale=path.join(directory,'events.json');if(fs.existsSync(stale))fs.unlinkSync(stale)
      const opened=pluginRuntime(plugin.id,workspace).then(({runtime})=>openMailbox(directory,{...runtime,subscribe:runtime.subscribe?((listener,options)=>runtime.subscribe!(event=>listener({type:'change',at:Date.now()}),{stateMode:'delta',initialState:false})):undefined,request:request=>{const context=authenticate((request as any).auth);return withCaller(context,()=>{authorize('plugin.call',{id:pluginId,employee:employeeId});return runtime.request(request)})}},workspace))
      mailboxes.set(directory,{workspace,opened});opened.catch(()=>mailboxes.delete(directory))
    }
    await mailboxes.get(directory)!.opened
}
export async function releaseWorkspacePlugins(workspace:string) {
  for(const [directory,entry] of mailboxes)if(entry.workspace===workspace||entry.workspace.startsWith(workspace+path.sep)){(await entry.opened)();mailboxes.delete(directory)}
}
export async function pluginRuntime(id:string,workspace:string) {
  workspace=fs.realpathSync(workspace)
  const plugin=requirePlugin(id),key=`${plugin.directory}:${plugin.version}:${workspace}`
  let instance=instances.get(key)
  if(!instance){instance=(async()=>{
    const factory=requireModule(pluginFile(plugin.directory,plugin.runtime)) as PluginFactory
    if(typeof factory.createPlugin!=='function')throw new Error('Plugin must export createPlugin(context)')
    const core=await factory.createPlugin({workspace,workspaceBase:pluginWorkspaceBase(id),pluginRoot:plugin.directory,executable:process.execPath,requestHost:async request=>(await import('../server')).handleRequest(request)})
    if(typeof core.request!=='function')throw new Error('Plugin must implement request()')
    const schema=JSON.parse(fs.readFileSync(pluginFile(plugin.directory,plugin.schema),'utf8')),methods=new Set(schema.commands.map((command:{method:string})=>command.method))
    // CLI, renderer HTTP and employee mailboxes all pass through this same boundary.
    const runtime:PluginRuntime={
      request:async request=>{
        if(!methods.has(request.method))return {jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method is not declared in the plugin CLI schema: '+request.method}}
        const safe:PluginRequest={jsonrpc:'2.0',id:request.id,method:request.method,params:request.params??{},stateMode:request.stateMode},principal=requestContext().principal
        if(isAppAdministrator(principal))return core.request(safe)
        const legacy=legacyAccess(id,workspace,plugin)
        if(legacy&&schema.commands.find((command:any)=>command.method===request.method)?.agentAccess==='workspace')return core.request({...safe,stateMode:'none'})
        if(principal.kind!=='agent'||!core.requestScoped)throw Error('This plugin requires explicit content authorization')
        const scope=pluginScope(id,workspace,principal.employeeId);if(!scope.grants.some(g=>g.read||g.write||g.create)&&id!=='cloud-hosts')throw Error('Plugin content authorization required; ask the user or Secretary to grant selected pages')
        const reply=await core.requestScoped({...safe,stateMode:'none'},scope)
        if(reply.createdResources)grantCreatedPluginResources(id,workspace,scope,reply.createdResources)
        const {createdResources,...response}=reply;return response
      },
      resources:core.resources?.bind(core),
      subscribe:core.subscribe?.bind(core),readAsset:core.readAsset?.bind(core),close:core.close?.bind(core)
    }
    return {plugin,runtime}
  })();instances.set(key,instance);instance.catch(()=>instances.delete(key))}
  return instance
}
export async function callPlugin(id:string,workspace:string,method:string,params:Record<string,unknown>={},raw=false) {
  const principal=requestContext().principal
  if(principal.kind==='agent'&&!isAppAdministrator(principal)&&id!=='cloud-hosts'&&!pluginScope(id,workspace,principal.employeeId).grants.some(g=>g.read||g.write||g.create)&&!legacyAccess(id,workspace))throw Error('Plugin content authorization required; ask the user or Secretary to grant selected content')
  const {runtime}=await pluginRuntime(id,workspace)
  const reply=await runtime.request({jsonrpc:'2.0',id:randomUUID(),method,params,...(!raw?{stateMode:'none' as const}:{})})
  if(raw)return reply
  if(reply.error)throw new Error(`${reply.error.message} (${reply.error.code})`)
  return reply.result
}
const mime=(file:string)=>({'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.map':'application/json'}[path.extname(file)]||'application/octet-stream')
export async function openPluginView(id:string,workspace:string) {
  requireAppAdministrator()
  const caller=requestContext(),{plugin,runtime}=await pluginRuntime(id,workspace)
  const token=randomUUID(),base=`/${token}/`,uiRoot=path.dirname(pluginFile(plugin.directory,plugin.renderer))
  const allowed=()=>withCaller(caller,()=>{authorize('plugin.call',{id,workspace});requireAppAdministrator()})
  const clients=new Set<http.ServerResponse>(),sockets=new Set<import('node:net').Socket>()
  let unsubscribe:(()=>void)|undefined
  const server=http.createServer(async(req,res)=>{
    try {
      res.setHeader('access-control-allow-origin','*')
      const url=new URL(req.url||'/','http://localhost')
      if(!url.pathname.startsWith(base)){res.writeHead(404);res.end();return}
      const target=decodeURIComponent(url.pathname.slice(base.length))
      if(target==='_agents-bridge.js'){res.writeHead(200,{'content-type':'application/javascript; charset=utf-8','cache-control':'no-store'});res.end(pluginBridge(token));return}
      if(target==='host.html'){allowed();const html=fs.readFileSync(path.join(applicationRoot(),'out/renderer/plugin-host.html'),'utf8').replaceAll('./assets/','./host-assets/');res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(html);return}
      if(target.startsWith('host-assets/')){const file=pluginFile(path.join(applicationRoot(),'out/renderer/assets'),target.slice(12));res.writeHead(200,{'content-type':mime(file)});fs.createReadStream(file).pipe(res);return}
      if(target==='host-rpc'&&req.method==='POST'){allowed();let body='';for await(const part of req){body+=part;if(body.length>1024*1024)throw Error('Permission request is too large')}const input=JSON.parse(body);if(!['plugin.resources','plugin.access'].includes(input.cmd))throw Error('Unknown plugin permission operation');const result=await withCaller({...caller,requestId:requestId()},()=>import('../server').then(module=>module.handleRequest({cmd:input.cmd,args:{...input.args,id,workspace}})));res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({ok:true,data:result}));return}
      if(target==='rpc'&&req.method==='POST') {
        req.setEncoding('utf8')
        let body='';for await(const part of req){body+=part;if(body.length>64*1024*1024)throw new Error('Request too large')}
        const request=JSON.parse(body) as PluginRequest
        if(request.jsonrpc!=='2.0'||typeof request.method!=='string')throw new Error('Invalid JSON RPC request')
        const controller=new AbortController(),cancel=()=>controller.abort()
        res.once('close',cancel)
        try{
          const reply=await withCaller({...caller,requestId:requestId(),signal:controller.signal},()=>{authorize('plugin.call',{id,workspace});return runtime.request(request)})
          if(!res.destroyed){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(reply))}
        }finally{res.removeListener('close',cancel)}
        return
      }
      if(req.method!=='GET'){res.writeHead(405);res.end();return}
      if(target==='events') {
        allowed()
        res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache',connection:'keep-alive'});res.write(': connected\n\n');clients.add(res)
        req.on('close',()=>clients.delete(res));return
      }
      if(target.startsWith('data/')) {
        allowed()
        if(!runtime.readAsset)throw new Error('This plugin has no asset reader')
        const asset=await runtime.readAsset(target.slice(5))
        res.writeHead(200,{'content-type':asset.mimeType,'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; sandbox"});res.end(Buffer.from(asset.bytes));return
      }
      const relative=target||path.basename(plugin.renderer),file=pluginFile(uiRoot,relative)
      res.writeHead(200,{'content-type':mime(file),'cache-control':'no-cache','x-content-type-options':'nosniff'});if(relative===path.basename(plugin.renderer)){const html=fs.readFileSync(file,'utf8'),bridge='<script src="./_agents-bridge.js"></script>';res.end(html.replace(/<head(?:\s[^>]*)?>/i,head=>head+bridge))}else fs.createReadStream(file).pipe(res)
    }catch(error){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:-32000,message:String((error as Error).message)}}))}
  })
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket))})
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  try {unsubscribe=await runtime.subscribe?.(event=>{if(!clients.size)return;try{allowed()}catch{for(const client of clients)client.end();clients.clear();return}const packet=`data: ${JSON.stringify(event)}\n\n`;for(const client of clients){if(client.writableLength>32*1024*1024)client.destroy();else client.write(packet)}},{stateMode:'delta',initialState:false})}
  catch(error){server.close();throw error}
  const port=(server.address() as import('node:net').AddressInfo).port
  const close=async()=>{unsubscribe?.();for(const client of clients)client.end();for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()))}
  views.set(token,{server,close})
  return {id:token,plugin:plugin.id,name:plugin.name,workspace,url:`http://127.0.0.1:${port}${base}host.html?frame=${encodeURIComponent(path.basename(plugin.renderer))}&name=${encodeURIComponent(plugin.name)}`}
}
export async function closePluginView(id:string) {const view=views.get(id);if(view){views.delete(id);await view.close()}return {closed:true}}
export async function closePlugins() {
  await Promise.all([...mailboxes.values()].map(async value=>{try{(await value.opened)()}catch(error){console.error('Plugin mailbox close:',error)}}));mailboxes.clear()
  await Promise.all([...views.keys()].map(id=>closePluginView(id)))
  await Promise.all([...instances.values()].map(async value=>{try{await (await value).runtime.close?.()}catch(error){console.error('Plugin runtime close:',error)}}));instances.clear()
}
