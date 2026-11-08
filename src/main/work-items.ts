import {randomUUID} from 'node:crypto'
import path from 'node:path'
import {APP_HOME} from '../shared/core-paths'
import {rolePolicy} from '../shared/roles'
import {teamSettings} from '../shared/types'
import {assignmentText,executionUpdate,externalDispatchText,workColumn,WORK_COLUMNS,type WorkColumn,type WorkDispatch,type WorkItem} from '../shared/work-items'
import {atomicJson,readJson} from './atomic-file'
import {authorize,callerEmployee,isAppAdministrator,requestContext,withCaller} from './authorization'
import {existsSync} from 'node:fs'
import {botGroup,listBots} from './bot-workers'
import {cockpitAvailable,docsTree,itemsForPath,readCockpit,repoRelative,saveCockpitCard} from './work-cockpit'
import {getView} from './presentation'
import {readStore} from './store'
import {defaultPluginWorkspace} from './workspaces'
import {lookupWorkPage,projectTeamBoard} from './work-notion'

const file=path.join(APP_HOME,'work-dispatches.json')
const locks=new Set<string>()
const readDispatches=()=>readJson<WorkDispatch[]>(file,()=>[],value=>Array.isArray(value))
const writeDispatches=(rows:WorkDispatch[])=>atomicJson(file,rows,true)
function notify(){void import('./server').then(module=>module.publishEvent('work:changed',{})).catch(()=>{})}

function requireCaller(){
  const card=callerEmployee()
  if(!card)throw Error('Agent identity revoked')
  return card
}
function boundRoot(team:string){
  const store=readStore()
  if(!store.groups.includes(team))throw Error('Unknown team')
  const root=store.teamRoots?.[team]
  if(!root)throw Error('This team has no bound repository')
  const caller=requestContext().principal
  if(!(caller.kind==='operator'||isAppAdministrator())){
    const card=requireCaller()
    if(card.group!==team&&rolePolicy(card.managementRole).scope!=='global')throw Error('Work items belong to the current team')
  }
  const settings=teamSettings(store,team)
  return {store,root,cloud:settings.mode==='cloud'}
}
function teamChoices(){
  const store=readStore()
  return store.groups.map(name=>({name,hasCockpit:!!store.teamRoots?.[name]&&cockpitAvailable(store.teamRoots[name])}))
}
function resolveTeam(explicit?:string){
  if(explicit)return {team:explicit,...boundRoot(explicit)}
  const caller=requestContext().principal
  if(caller.kind==='agent'){const card=requireCaller();return {team:card.group,...boundRoot(card.group)}}
  const view=getView()
  const employee=view.employee?readStore().sessions.find(card=>card.id===view.employee&&!card.deleting):undefined
  if(employee?.group&&readStore().teamRoots?.[employee.group])return {team:employee.group,...boundRoot(employee.group)}
  const groups=readStore().groups.filter(name=>readStore().teamRoots?.[name])
  if(groups.length===1)return {team:groups[0],...boundRoot(groups[0])}
  return null
}
function project(team:string,root:string){
  try{projectTeamBoard(defaultPluginWorkspace('mininotion'),team,root)}catch{/* MiniNotion notes stay usable when the collection cannot be projected. */}
}
/** A user message that starts an employee, or an employee message that actually starts work, becomes a cockpit card. */
export function recordStartedWork(input:{employeeId?:string;sessionId?:string;text?:string;clientMessageId?:string;initiator?:string}){
  try{
    const key=input.clientMessageId??''
    if(key.startsWith('work-'))return
    const text=String(input.text??'').trim()
    if(!text||text.startsWith('/'))return
    const store=readStore()
    const employeeId=input.employeeId
    const employee=store.sessions.find(card=>card.id===employeeId&&!card.deleting)
    if(!employee)return
    const root=store.teamRoots?.[employee.group]
    if(!root||!existsSync(root))return
    if(key&&readCockpit(root).some(item=>item.extra.clientMessageId===key))return
    const caller=requestContext().principal
    const initiator=input.initiator??(caller.kind==='operator'?'用户':store.sessions.find(card=>card.id===caller.employeeId)?.title??'员工')
    saveCockpitCard(root,{
      title:text.split('\n')[0].slice(0,80),
      body:text.slice(0,8000),
      review:text.slice(0,500),
      status:'执行中',
      assignee:employee.title,
      proposedAssignee:'',
      initiator,
      conversation:'employee:'+employee.id,
      extra:key?{clientMessageId:key}:{},
    })
    project(employee.group,root)
  }catch{/* Recording a card never blocks the message. */}
}
export function projectOpenWorkboards(){
  const store=readStore()
  for(const team of store.groups){
    const root=store.teamRoots?.[team]
    if(root&&cockpitAvailable(root))project(team,root)
  }
}
function board(team:string,root:string,cloud:boolean){
  if(cloud&&!cockpitAvailable(root))return {team,root,cockpit:team+'/'+'docs/ai-finance/cockpit',available:false,reason:'The bound repository is on a cloud host and is not readable as a Core-host folder.',columns:[...WORK_COLUMNS],items:[] as WorkItem[]}
  const available=cockpitAvailable(root)
  if(available)project(team,root)
  return {team,root,cockpit:'docs/ai-finance/cockpit',available,reason:available?undefined:'This team has no docs/ai-finance/cockpit folder',columns:[...WORK_COLUMNS],items:available?readCockpit(root):[]}
}
function requireBoard(explicit?:string){
  const resolved=resolveTeam(explicit)
  if(!resolved)return {needsTeam:true as const,teams:teamChoices()}
  return {needsTeam:false as const,...resolved,board:board(resolved.team,resolved.root,resolved.cloud)}
}
function findItem(items:WorkItem[],id:string){
  const item=items.find(card=>card.id===id)
  if(!item)throw Error('Work item no longer exists')
  return item
}
const lists=(value:unknown,label:string)=>{
  if(value===undefined)return undefined
  if(!Array.isArray(value)||value.some(item=>typeof item!=='string'))throw Error(label+' must be a list of strings')
  return value
}
export async function workRequest(command:string,args:Record<string,any>){
  if(command==='work.board'){
    const resolved=requireBoard(args.team)
    if(resolved.needsTeam)return resolved
    return {team:resolved.team,cockpit:resolved.board.cockpit,available:resolved.board.available,reason:resolved.board.reason,columns:resolved.board.columns,items:resolved.board.items.map(summary)}
  }
  if(command==='work.docs'||command==='work.forPath'){
    const resolved=requireBoard(args.team)
    if(resolved.needsTeam)return resolved
    if(!resolved.board.available)return {team:resolved.team,available:false,reason:resolved.board.reason,documents:[],items:[]}
    const documents=docsTree(resolved.root,resolved.board.items)
    if(command==='work.docs')return {team:resolved.team,root:'docs/ai-finance',documents,items:resolved.board.items.map(summary)}
    const relative=repoRelative(resolved.root,String(args.path)).relative
    return {team:resolved.team,path:relative,items:itemsForPath(resolved.board.items,relative).map(summary)}
  }
  if(command==='work.get'){
    const resolved=requireBoard(args.team)
    if(resolved.needsTeam)throw Error('Choose the current team')
    if(!resolved.board.available)throw Error(resolved.board.reason??'This team has no docs/ai-finance/cockpit folder')
    return {team:resolved.team,...detail(findItem(resolved.board.items,String(args.id)))}
  }
  if(command==='work.save'||command==='work.link'){
    const resolved=resolveTeam(args.team)
    if(!resolved)throw Error('Choose the current team')
    if(resolved.cloud&&!cockpitAvailable(resolved.root))throw Error('The bound repository is not on the Core host')
    if((command==='work.link'||args.id)&&typeof args.expectedHash!=='string')throw Error('Reload the work item before editing it')
    if(args.progress!==undefined&&(!Number.isInteger(args.progress)||args.progress<0||args.progress>100))throw Error('Progress is a percentage from 0 to 100')
    const saved=saveCockpitCard(resolved.root,{
      ...(args.id?{id:String(args.id)}:{}),
      ...(args.title!==undefined?{title:String(args.title)}:{}),
      ...(args.status!==undefined?{status:args.status as WorkColumn}:{}),
      ...(args.assignee!==undefined?{assignee:String(args.assignee)}:{}),
      ...(args.progress!==undefined?{progress:Number(args.progress)}:{}),
      ...(command==='work.link'?{conversation:String(args.conversation)}:args.conversation!==undefined?{conversation:String(args.conversation)}:{}),
      ...(args.subItemOf!==undefined?{subItemOf:String(args.subItemOf)}:{}),
      ...(lists(args.blockedBy,'blockedBy')?{blockedBy:args.blockedBy}:{}),
      ...(lists(args.outputs,'outputs')?{outputs:args.outputs}:{}),
      ...(lists(args.documents,'documents')?{documents:args.documents}:{}),
      ...(lists(args.changedFiles,'changedFiles')?{changedFiles:args.changedFiles}:{}),
      ...(lists(args.unverified,'unverified')?{unverified:args.unverified}:{}),
      ...(args.review!==undefined?{review:String(args.review)}:{}),
      ...(args.body!==undefined?{body:String(args.body)}:{})
    },args.expectedHash)
    project(resolved.team,resolved.root)
    notify()
    return {team:resolved.team,item:detail(saved.item),items:saved.items.map(summary)}
  }
  if(command==='work.candidates')return listCandidates(String(args.pageId))
  if(command==='work.start')return startWork(args)
  if(command==='work.dispatch')return requestDispatch(args)
  if(command==='work.dispatches')return {dispatches:visibleDispatches(args.team,args.conversation)}
  if(command==='work.confirm')return confirmDispatch(String(args.id))
  if(command==='work.deny')return denyDispatch(String(args.id))
  throw Error('Unknown work item API')
}
function summary(item:WorkItem){
  return {id:item.id,title:item.title,status:item.status,column:item.column,assignee:item.assignee,initiator:item.initiator,proposedAssignee:item.proposedAssignee,progress:item.progress,subItemOf:item.subItemOf,blockedBy:item.blockedBy,children:item.children,blocking:item.blocking,outputs:item.outputs,documents:item.documents,conversation:item.conversation,path:item.path,hash:item.hash}
}
function detail(item:WorkItem){
  return {...summary(item),changedFiles:item.changedFiles,unverified:item.unverified,review:item.review,body:item.body}
}
function visibleDispatches(team?:string,conversation?:string){
  let rows=readDispatches().filter(row=>row.status==='pending')
  if(team)rows=rows.filter(row=>row.team===team)
  if(conversation)rows=rows.filter(row=>row.conversation===conversation||row.to.kind==='employee'&&conversation==='employee:'+row.to.id||conversation==='employee:'+row.fromEmployeeId||row.to.kind==='worker'&&conversation==='group:'+row.to.id)
  const caller=requestContext().principal
  if(caller.kind==='agent'&&!isAppAdministrator()){
    const card=requireCaller()
    rows=rows.filter(row=>row.team===card.group||row.fromEmployeeId===card.id||row.to.id===card.id||row.conversation==='employee:'+card.id)
  }
  return rows
}
function openedCard(pageId:string){
  const found=lookupWorkPage(defaultPluginWorkspace('mininotion'),pageId)
  if(!found)throw Error('Open a cockpit work item')
  const root=readStore().teamRoots?.[found.team]
  if(!root||!cockpitAvailable(root))throw Error('This team has no docs/ai-finance/cockpit folder')
  return {team:found.team,root,item:findItem(readCockpit(root),found.itemId)}
}
function listCandidates(pageId:string){
  const {team}=openedCard(pageId)
  const employees=readStore().sessions.filter(card=>!card.deleting&&card.group===team).map(card=>({id:card.id,title:card.title,kind:'employee' as const}))
  const workers=listBots().filter(group=>group.bot?.kind==='private').map(group=>({id:group.id,title:group.name,kind:'worker' as const}))
  return {team,people:[...employees,...workers]}
}
async function startWork(args:Record<string,any>){
  if(!isAppAdministrator())throw Error('An employee must use work.dispatch and wait for confirmation')
  if('text' in args||'prompt' in args)throw Error('Assignment text is taken from the work item')
  const opened=openedCard(String(args.pageId))
  const to=String(args.to)
  const employee=readStore().sessions.find(card=>card.id===to&&!card.deleting)
  const worker=!employee&&botGroup(to)?.bot?.kind==='private'?botGroup(to):undefined
  const kind=args.kind??(employee?'employee':worker?'worker':undefined)
  if(kind==='employee'&&(!employee||employee.group!==opened.team))throw Error('Choose a teammate on this team')
  if(kind==='worker'&&!worker)throw Error('Choose an available external worker')
  if(kind!=='employee'&&kind!=='worker')throw Error('Choose a teammate or an available external worker')
  const person={kind,id:to,title:kind==='employee'?employee!.title:worker!.name}
  const update=executionUpdate(opened.item,person)
  const rows=readDispatches()
  for(const row of rows)if(row.status==='pending'&&row.itemId===opened.item.id){row.status='confirmed';row.decidedAt=Date.now()}
  writeDispatches(rows)
  const saved=saveCockpitCard(opened.root,{id:opened.item.id,assignee:update.assignee,proposedAssignee:'',conversation:update.conversation,...((WORK_COLUMNS as readonly string[]).includes(update.status)&&update.status!==opened.item.status?{status:update.status as WorkColumn}:{})},opened.item.hash)
  project(opened.team,opened.root)
  const {handleRequest}=await import('./server')
  const text=kind==='worker'?update.externalText:update.employeeText
  const result=await handleRequest({cmd:kind==='worker'?'direct.send':'session.send',args:{employee:to,text,clientMessageId:'work-start-'+opened.item.id+'-'+to+'-'+saved.item.hash.slice(0,12),...(kind==='employee'?{sourceView:'messages'}:{})}})
  try{await handleRequest({cmd:'view.open',args:kind==='worker'?{kind:'messages',chatId:to}:{kind:'messages',employee:to}})}catch{/* The assignment was sent. */}
  notify()
  return {pending:false,sent:true,conversation:update.conversation,item:detail(saved.item),result}
}
function requestDispatch(args:Record<string,any>){
  const caller=requestContext().principal
  if('text' in args||'prompt' in args)throw Error('Dispatch text is taken from the work item. External workers only receive the card path, changed files, unverified items and the review ask.')
  if(caller.kind!=='agent')throw Error('An employee requests the dispatch. The user confirms it before anything is sent.')
  const from=requireCaller()
  const resolved=resolveTeam(args.team??from.group)
  if(!resolved||resolved.team!==from.group&&rolePolicy(from.managementRole).scope!=='global')throw Error('Dispatch stays inside the employee team')
  if(!cockpitAvailable(resolved.root))throw Error('This team has no docs/ai-finance/cockpit folder')
  const item=findItem(readCockpit(resolved.root),String(args.id))
  const kind=args.kind??(botGroup(args.to)?'worker':'employee')
  if(kind!=='employee'&&kind!=='worker')throw Error('Dispatch target is an employee or an external worker')
  const to=String(args.to)
  const worker=kind==='worker'?botGroup(to):undefined
  if(kind==='employee'){
    if(to===from.id)throw Error('Choose another employee')
    authorize('session.send',{id:to},to)
  }else{
    if(!worker)throw Error('Unknown external worker')
    if(worker.bot?.kind!=='private')throw Error('Use the external worker private conversation')
    if(!isAppAdministrator()&&!worker.memberIds.includes(from.id))throw Error('External Worker access required')
  }
  const targetTitle=kind==='employee'?readStore().sessions.find(card=>card.id===to)?.title??to:worker?.name??to
  saveCockpitCard(resolved.root,{id:item.id,initiator:from.title,proposedAssignee:targetTitle,...(workColumn(item.status)==='待分派'?{status:'待分派' as WorkColumn}:{})},item.hash)
  project(resolved.team,resolved.root)
  const payload={path:item.path,changedFiles:item.changedFiles,unverified:item.unverified,review:item.review}
  const dispatch:WorkDispatch={
    id:'wd_'+randomUUID(),team:resolved.team,itemId:item.id,fromEmployeeId:from.id,
    to:{kind,id:to},...(args.conversation?{conversation:String(args.conversation)}:item.conversation?{conversation:item.conversation}:{}),
    payload,assignment:assignmentText(item),externalText:externalDispatchText(payload),status:'pending',createdAt:Date.now()
  }
  const rows=readDispatches();rows.push(dispatch);writeDispatches(rows);notify()
  return {pending:true,sent:false,dispatch}
}
async function confirmDispatch(id:string){
  if(!isAppAdministrator())throw Error('Only the user or Secretary may confirm a work dispatch')
  const rows=readDispatches(),dispatch=rows.find(row=>row.id===id)
  if(!dispatch)throw Error('Unknown work dispatch')
  if(dispatch.status==='confirmed')return {pending:false,sent:true,dispatch}
  if(dispatch.status!=='pending')throw Error('This dispatch was already denied')
  if(locks.has(id))throw Error('This dispatch is already being confirmed')
  locks.add(id)
  try{
    const context={principal:{kind:'agent' as const,employeeId:dispatch.fromEmployeeId},requestId:randomUUID()}
    const {handleRequest}=await import('./server')
    const result=await withCaller(context,()=>handleRequest({cmd:dispatch.to.kind==='worker'?'direct.send':'session.send',args:dispatch.to.kind==='worker'
      ?{employee:dispatch.to.id,text:dispatch.externalText,clientMessageId:'work-'+dispatch.id}
      :{employee:dispatch.to.id,text:dispatch.assignment,clientMessageId:'work-'+dispatch.id,sourceView:'messages'}}))
    try{
      const root=readStore().teamRoots?.[dispatch.team]
      const item=root?readCockpit(root).find(card=>card.id===dispatch.itemId):undefined
      const title=dispatch.to.kind==='employee'?readStore().sessions.find(card=>card.id===dispatch.to.id)?.title:botGroup(dispatch.to.id)?.name
      if(root&&item){saveCockpitCard(root,{id:item.id,assignee:title||item.proposedAssignee||item.assignee,proposedAssignee:'',status:'执行中',conversation:dispatch.to.kind==='employee'?'employee:'+dispatch.to.id:'group:'+dispatch.to.id},item.hash);project(dispatch.team,root)}
    }catch{/* The assignment was already sent. */}
    dispatch.status='confirmed';dispatch.decidedAt=Date.now();delete dispatch.error
    writeDispatches(rows);notify()
    return {pending:false,sent:true,dispatch,result}
  }catch(error){
    dispatch.error=(error as Error).message
    writeDispatches(rows);notify()
    throw error
  }finally{locks.delete(id)}
}
function denyDispatch(id:string){
  if(!isAppAdministrator())throw Error('Only the user or Secretary may deny a work dispatch')
  const rows=readDispatches(),dispatch=rows.find(row=>row.id===id)
  if(!dispatch)throw Error('Unknown work dispatch')
  if(dispatch.status==='confirmed')throw Error('This dispatch was already sent')
  dispatch.status='denied';dispatch.decidedAt=Date.now()
  writeDispatches(rows);notify()
  return {pending:false,sent:false,dispatch}
}
