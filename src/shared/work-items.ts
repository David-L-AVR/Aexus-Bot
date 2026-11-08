import {objectSchema,nonemptySchema} from './api-schema.ts'

/** Pipeline columns for the current team's cockpit board.
 * MiniNotion's own status groups stay todo/doing/done. These labels are a projection
 * of bound-repo markdown, not a rewrite of existing database options. */
export const WORK_COLUMNS=['待分派','就绪','执行中','待审查','待验收','阻塞','完成'] as const
export type WorkColumn=typeof WORK_COLUMNS[number]
export const COCKPIT_RELATIVE='docs/ai-finance/cockpit'
export const DOCS_RELATIVE='docs/ai-finance'
const LEGACY:Record<string,WorkColumn>={
  '未开始':'待分派','todo':'待分派','to do':'待分派','backlog':'待分派','待办':'待分派','待分派':'待分派',
  'ready':'就绪','就绪':'就绪',
  '进行中':'执行中','in progress':'执行中','doing':'执行中','wip':'执行中','执行中':'执行中',
  'review':'待审查','in review':'待审查','待审查':'待审查',
  '验收':'待验收','acceptance':'待验收','待验收':'待验收',
  'blocked':'阻塞','blocker':'阻塞','阻塞':'阻塞',
  'done':'完成','completed':'完成','已完成':'完成','完成':'完成'
}
export const workColumn=(status:string|undefined):WorkColumn=>{
  const raw=(status??'').trim()
  if((WORK_COLUMNS as readonly string[]).includes(raw))return raw as WorkColumn
  return LEGACY[raw.toLowerCase()]??'待分派'
}
export type WorkItem={
  id:string
  title:string
  /** Status text stored in the markdown card. A legacy value is kept until the user moves the card. */
  status:string
  column:WorkColumn
  assignee:string
  initiator:string
  proposedAssignee:string
  progress:number
  subItemOf:string|null
  blockedBy:string[]
  children:string[]
  blocking:string[]
  outputs:string[]
  documents:string[]
  changedFiles:string[]
  unverified:string[]
  review:string
  conversation?:string
  path:string
  body:string
  hash:string
  extra:Record<string,string|string[]>
}
export type WorkDispatchPayload={path:string;changedFiles:string[];unverified:string[];review:string}
export type WorkDispatch={
  id:string
  team:string
  itemId:string
  fromEmployeeId:string
  to:{kind:'employee'|'worker';id:string}
  conversation?:string
  payload:WorkDispatchPayload
  assignment:string
  externalText:string
  status:'pending'|'confirmed'|'denied'
  error?:string
  createdAt:number
  decidedAt?:number
}
const idPattern=/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/
const listValue=(value:string|string[]|undefined)=>Array.isArray(value)?value.map(item=>item.trim()).filter(Boolean):typeof value==='string'&&value.trim()?value.split(',').map(item=>item.trim()).filter(Boolean):[]
const scalar=(value:string|string[]|undefined)=>Array.isArray(value)?value.join(', '):value?.trim()??''

/** A small front-matter reader for cockpit cards. Unknown keys stay in `extra`. */
export function parseFrontMatter(markdown:string){
  const text=markdown.replace(/^\uFEFF/,'')
  if(!text.startsWith('---\n')&&!text.startsWith('---\r\n'))return {fields:{} as Record<string,string|string[]>,body:text}
  const end=text.search(/\r?\n---\r?\n/)
  if(end<0)return {fields:{} as Record<string,string|string[]>,body:text}
  const block=text.slice(4,end).replace(/^\r?\n/,''),body=text.slice(text.indexOf('\n',end)+1).replace(/^---\r?\n/,'')
  const fields:Record<string,string|string[]>={}
  const lines=block.split(/\r?\n/)
  for(let i=0;i<lines.length;i++){
    const line=lines[i]
    if(!line.trim()||line.trim().startsWith('#'))continue
    const match=/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if(!match)continue
    const key=match[1],inline=match[2].trim()
    if(inline.startsWith('[')&&inline.endsWith(']'))fields[key]=inline.slice(1,-1).split(',').map(item=>item.trim().replace(/^['"]|['"]$/g,'')).filter(Boolean)
    else if(!inline){
      const items:string[]=[]
      while(i+1<lines.length&&/^\s+-\s+/.test(lines[i+1])){items.push(lines[++i].replace(/^\s+-\s+/,'').trim());}
      fields[key]=items
    }else fields[key]=inline.replace(/^['"]|['"]$/g,'')
  }
  const bodyStart=text.slice(end).match(/^\r?\n---\r?\n/)
  return {fields,body:bodyStart?text.slice(end+bodyStart[0].length):body}
}
export function cardFromMarkdown(relativePath:string,markdown:string):WorkItem|null{
  const name=relativePath.split('/').pop()??''
  if(!name.endsWith('.md')||name==='TASKS.md'||name==='README.md'||relativePath.includes('/v2/'))return null
  const {fields,body}=parseFrontMatter(markdown)
  const fallback=name.replace(/\.md$/i,'')
  const id=scalar(fields.id)||fallback
  if(!idPattern.test(id))return null
  const heading=/^#\s+(.+)$/m.exec(body)?.[1]?.trim()
  const title=scalar(fields.title)||heading||id
  const status=scalar(fields.status)
  const known=new Set(['id','title','status','assignee','initiator','proposedAssignee','progress','subItemOf','blockedBy','outputs','documents','changedFiles','unverified','review','conversation'])
  const extra:Record<string,string|string[]>={}
  for(const [key,value] of Object.entries(fields))if(!known.has(key))extra[key]=value
  const progress=Number(scalar(fields.progress)||0)
  const conversation=scalar(fields.conversation)
  return {
    id,title,status,column:workColumn(status),assignee:scalar(fields.assignee),initiator:scalar(fields.initiator),proposedAssignee:scalar(fields.proposedAssignee),
    progress:Number.isFinite(progress)?Math.max(0,Math.min(100,Math.round(progress))):0,
    subItemOf:scalar(fields.subItemOf)||null,
    blockedBy:listValue(fields.blockedBy),
    children:[],blocking:[],
    outputs:listValue(fields.outputs),documents:listValue(fields.documents),changedFiles:listValue(fields.changedFiles),unverified:listValue(fields.unverified),
    review:scalar(fields.review),
    ...(conversation?{conversation}:{}),
    path:relativePath,body:body.replace(/^\n/,''),hash:'',extra
  }
}
function yamlList(key:string,values:string[]){
  if(!values.length)return `${key}: []`
  return `${key}:\n${values.map(value=>'  - '+value).join('\n')}`
}
export function serializeWorkCard(item:Pick<WorkItem,'id'|'title'|'status'|'assignee'|'initiator'|'proposedAssignee'|'progress'|'subItemOf'|'blockedBy'|'outputs'|'documents'|'changedFiles'|'unverified'|'review'|'conversation'|'body'|'extra'>,previous?:string){
  const {fields}=previous?parseFrontMatter(previous):{fields:{}}
  const next:Record<string,string|string[]>={...fields,...item.extra}
  next.id=item.id
  next.title=item.title
  next.status=item.status
  next.assignee=item.assignee
  next.initiator=item.initiator
  next.proposedAssignee=item.proposedAssignee
  next.progress=String(item.progress)
  next.subItemOf=item.subItemOf??''
  next.blockedBy=item.blockedBy
  next.outputs=item.outputs
  next.documents=item.documents
  next.changedFiles=item.changedFiles
  next.unverified=item.unverified
  next.review=item.review
  if(item.conversation)next.conversation=item.conversation
  else delete next.conversation
  const order=['id','title','status','assignee','initiator','proposedAssignee','progress','subItemOf','blockedBy','outputs','documents','changedFiles','unverified','review','conversation']
  const keys=[...order.filter(key=>key in next),...Object.keys(next).filter(key=>!order.includes(key))]
  const lines=keys.map(key=>{
    const value=next[key]
    if(Array.isArray(value))return yamlList(key,value)
    return `${key}: ${value??''}`
  })
  const body=item.body.replace(/^\n+/,'').replace(/\s*$/,'')
  return `---\n${lines.join('\n')}\n---\n${body?body+'\n':''}`
}
/** Project a hand-written TASKS.md when the cockpit folder has no per-card files yet. */
export function cardsFromTasksIndex(markdown:string):WorkItem[]{
  const text=markdown.startsWith('## ')?'\n'+markdown:markdown
  const sections=text.split(/\n(?=##\s+)/).slice(1)
  return sections.flatMap(section=>{
    const lines=section.replace(/^\n/,'').split(/\n/)
    const heading=/^##\s+([A-Za-z0-9][A-Za-z0-9._-]{0,80})(?:\s+(.+))?$/.exec(lines[0]??'')
    if(!heading)return []
    const fields:string[]=[]
    let index=1
    for(;index<lines.length;index++){
      if(!lines[index].trim()){index++;break}
      if(!/^[A-Za-z][A-Za-z0-9_-]*:/.test(lines[index]))break
      fields.push(lines[index])
    }
    const body=lines.slice(index).join('\n')
    const draft=['---',`id: ${heading[1]}`,`title: ${(heading[2]??heading[1]).trim()}`,...fields,'---','',body].join('\n')
    const card=cardFromMarkdown(`${COCKPIT_RELATIVE}/${heading[1]}.md`,draft)
    return card?[card]:[]
  })
}
export function relateWorkItems(items:WorkItem[]):WorkItem[]{
  return items.map(item=>({
    ...item,
    children:items.filter(other=>other.subItemOf===item.id).map(other=>other.id),
    blocking:items.filter(other=>other.blockedBy.includes(item.id)).map(other=>other.id)
  }))
}
export function assertWorkRelations(items:Pick<WorkItem,'id'|'subItemOf'|'blockedBy'>[]){
  const byId=new Map(items.map(item=>[item.id,item]))
  const visit=(start:string,next:(id:string)=>string[])=>{
    const seen=new Set<string>()
    const walk=(id:string)=>{
      if(seen.has(id))throw Error('Work item relations cannot contain a cycle')
      seen.add(id)
      for(const child of next(id))if(byId.has(child))walk(child)
    }
    walk(start)
  }
  for(const item of items){
    if(item.subItemOf===item.id||item.blockedBy.includes(item.id))throw Error('A work item cannot depend on itself')
    visit(item.id,id=>byId.get(id)?.subItemOf?[byId.get(id)!.subItemOf!]:[])
    visit(item.id,id=>byId.get(id)?.blockedBy??[])
  }
}

/** External workers receive only the task card path, changed files, unverified items, and the review ask. */
export function externalDispatchText(payload:WorkDispatchPayload){
  const lines=[`task: ${payload.path}`]
  lines.push('changed:')
  lines.push(...(payload.changedFiles.length?payload.changedFiles.map(file=>`- ${file}`):['- (none)']))
  lines.push('unverified:')
  lines.push(...(payload.unverified.length?payload.unverified.map(item=>`- ${item}`):['- (none)']))
  lines.push(`review: ${payload.review.trim()||'(none)'}`)
  return lines.join('\n')
}
/** User-started execution leaves 待分派 and 就绪. Later columns stay where they are. */
export function executionUpdate(item:Pick<WorkItem,'id'|'title'|'path'|'status'|'column'|'review'|'documents'|'outputs'|'unverified'|'changedFiles'>,person:{kind:'employee'|'worker';id:string;title:string}){
  const column=workColumn(item.status||item.column)
  const move=column==='待分派'||column==='就绪'
  const status=move?'执行中':(item.status||column)
  const nextColumn=workColumn(status)
  const conversation=person.kind==='employee'?'employee:'+person.id:'group:'+person.id
  const card={...item,status,column:nextColumn,path:item.path,review:item.review,documents:item.documents,outputs:item.outputs,unverified:item.unverified,changedFiles:item.changedFiles}
  return {status,assignee:person.title,conversation,employeeText:assignmentText(card),externalText:externalDispatchText({path:item.path,changedFiles:item.changedFiles,unverified:item.unverified,review:item.review})}
}
export function assignmentText(item:Pick<WorkItem,'id'|'title'|'path'|'column'|'review'|'documents'|'outputs'|'unverified'|'changedFiles'>){
  return [
    `工作项 ${item.id} ${item.title}`,
    `卡片：${item.path}`,
    `状态：${item.column}`,
    `要处理：${item.review.trim()||'按卡片继续'}`,
    `相关文档：${item.documents.length?item.documents.join(', '):'无'}`,
    `产出：${item.outputs.length?item.outputs.join(', '):'无'}`,
    `未验证：${item.unverified.length?item.unverified.join(', '):'无'}`,
    `改动文件：${item.changedFiles.length?item.changedFiles.join(', '):'无'}`
  ].join('\n')
}
const conversation={type:'string',pattern:'^(employee|group|channel):[A-Za-z0-9_-]+$'}
const itemId={type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$'}
const paths={type:'array',items:{type:'string',minLength:1,maxLength:300},maxItems:40}
export const WORK_COMMANDS=[
 {cli:{},name:'work.board',args:'[--team NAME]',summary:'Read the current team bound repository cockpit board. Columns map legacy statuses onto 待分派 / 就绪 / 执行中 / 待审查 / 待验收 / 阻塞 / 完成 without rewriting cards. Facts stay in docs/ai-finance/cockpit markdown.',gui:'MiniNotion work board',inputSchema:objectSchema({team:nonemptySchema})},
 {cli:{positionals:['id']},name:'work.get',args:'ID [--team NAME]',summary:'Read one cockpit work item, including outputs, progress, subItemOf, blockedBy and its linked Message conversation.',gui:'Work item detail',inputSchema:objectSchema({id:itemId,team:nonemptySchema},['id'])},
 {cli:{},name:'work.save',args:'[--team NAME] [--id ID] [--title TEXT] [--status COLUMN] [--assignee TEXT] [--progress N] [--sub-item-of ID] [--blocked-by JSON] [--outputs JSON] [--documents JSON] [--changed-files JSON] [--unverified JSON] [--review TEXT] [--body TEXT] [--expected-hash HASH]',summary:'Create or edit a cockpit markdown card in the team bound repository. Moving a card writes the pipeline status. Existing MiniNotion databases are not rewritten.',gui:'Edit work item',inputSchema:objectSchema({team:nonemptySchema,id:itemId,title:{type:'string',minLength:1,maxLength:200},status:{enum:[...WORK_COLUMNS]},assignee:{type:'string',maxLength:120},progress:{type:'integer',minimum:0,maximum:100},subItemOf:{type:'string',maxLength:81},blockedBy:paths,outputs:paths,documents:paths,changedFiles:paths,unverified:paths,review:{type:'string',maxLength:2000},body:{type:'string',maxLength:200000},expectedHash:{type:'string',minLength:64,maxLength:64}})},
 {cli:{},name:'work.link',args:'--id ID --conversation REF [--team NAME] [--expected-hash HASH]',summary:'Link a Message conversation to a cockpit work item. The link is stored on the markdown card.',gui:'Link conversation to work item',inputSchema:objectSchema({team:nonemptySchema,id:itemId,conversation,expectedHash:{type:'string',minLength:64,maxLength:64}},['id','conversation','expectedHash'])},
 {cli:{},name:'work.docs',args:'[--team NAME]',summary:'List docs/ai-finance documents in the current team bound repository and the work items that reference them.',gui:'Project documents',inputSchema:objectSchema({team:nonemptySchema})},
 {cli:{},name:'work.forPath',args:'--path RELATIVE [--team NAME]',summary:'Read which cockpit work items reference a docs/ai-finance path.',gui:'Document work items',inputSchema:objectSchema({team:nonemptySchema,path:nonemptySchema},['path'])},
 {cli:{},name:'work.candidates',args:'--page-id PAGE',summary:'List teammates and already available external workers who can receive a cockpit work item. Does not assign or send.',gui:'Choose a teammate',inputSchema:objectSchema({pageId:nonemptySchema},['pageId'])},
 {cli:{},name:'work.start',args:'--page-id PAGE --to ID [--kind employee|worker]',summary:'User or Secretary: assign a cockpit card, move 待分派 or 就绪 to 执行中, link that conversation, and send the assignment now. This click is the confirmation. Employees still use work.dispatch and wait for Ask.',gui:'Start work item',inputSchema:objectSchema({pageId:nonemptySchema,to:nonemptySchema,kind:{enum:['employee','worker']}},['pageId','to'])},
 {cli:{},name:'work.dispatch',args:'--id ID --to EMPLOYEE_OR_WORKER [--kind employee|worker] [--team NAME] [--conversation REF]',summary:'Ask the user to confirm before one employee assigns a work item to another employee or an external worker. Nothing is sent until work.confirm. External text is limited to the card path, changed files, unverified items and the review ask.',gui:'Confirm work dispatch',inputSchema:objectSchema({team:nonemptySchema,id:itemId,to:nonemptySchema,kind:{enum:['employee','worker']},conversation},['id','to'])},
 {cli:{},name:'work.dispatches',args:'[--team NAME] [--conversation REF]',summary:'List work dispatches waiting for the same confirmation card as Ask. Pending items have not been sent.',gui:'Pending work dispatches',inputSchema:objectSchema({team:nonemptySchema,conversation})},
 {cli:{positionals:['id']},name:'work.confirm',args:'ID',summary:'User or Secretary: confirm a pending work dispatch and send it through the existing employee or external-worker path. External workers receive the whitelist text only.',gui:'Allow work dispatch',inputSchema:objectSchema({id:nonemptySchema},['id'])},
 {cli:{positionals:['id']},name:'work.deny',args:'ID',summary:'User or Secretary: cancel a pending work dispatch. Nothing is sent.',gui:'Deny work dispatch',inputSchema:objectSchema({id:nonemptySchema},['id'])}
]
export const WORK_APIS=new Set(WORK_COMMANDS.map(command=>command.name))
