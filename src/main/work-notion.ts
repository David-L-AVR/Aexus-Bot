import fs from 'node:fs'
import path from 'node:path'
import {WORK_COLUMNS,workColumn,type WorkColumn,type WorkItem} from '../shared/work-items.ts'
import {readCockpit,saveCockpitCard,workHash} from './work-cockpit.ts'
import {atomicJson,readJson} from './atomic-file.ts'

const FORMAT='mininotion.page/v1'
type NotionPage=Record<string,any>
type CardSync={pageId:string;directory:string;notionHash:string;markdownHash:string;projectedStatus:string}
type TeamSync={databaseId:string;folder:string;cards:Record<string,CardSync>}
type SyncFile={teams:Record<string,TeamSync>}
const pipeline:Record<WorkColumn,'todo'|'doing'|'done'>={
  '待分派':'todo','就绪':'todo','执行中':'doing','待审查':'doing','待验收':'doing','阻塞':'doing','完成':'done',
}
export function workFolderName(team:string){
  const slug=team.normalize('NFC').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,48)||'team'
  return 'work-'+slug
}
const pageId=(team:string,id:string)=>'aexus-'+workFolderName(team)+'-'+id
const syncPath=(collection:string)=>path.join(collection,'.mininotion','aexus-work.json')
function readSync(collection:string):SyncFile{
  return readJson<SyncFile>(syncPath(collection),()=>({teams:{}}),value=>!!value&&typeof value==='object'&&!Array.isArray((value as SyncFile).teams||{}))
}
function writeSync(collection:string,value:SyncFile){atomicJson(syncPath(collection),value,true)}
function readPage(file:string):NotionPage|undefined{
  try{const data=JSON.parse(fs.readFileSync(file,'utf8'));if(data.format===FORMAT&&data.page&&typeof data.page.title==='string')return data.page}catch{return}
}
function writePage(file:string,page:NotionPage){
  fs.mkdirSync(path.dirname(file),{recursive:true})
  const text=JSON.stringify({format:FORMAT,page},null,2)+'\n'
  if(fs.existsSync(file)&&fs.readFileSync(file,'utf8')===text)return
  fs.writeFileSync(file,text)
}
function blockText(blocks:any):string{
  if(!Array.isArray(blocks))return ''
  return blocks.map(block=>{
    const content=typeof block?.content==='string'?block.content:Array.isArray(block?.content)?block.content.map((part:any)=>String(part?.text??part?.content??'')).join(''):''
    const children=blockText(block?.children)
    return [content,children].filter(Boolean).join('\n')
  }).filter(Boolean).join('\n').trim()
}
function lines(value:unknown){return String(value??'').split('\n').map(item=>item.trim()).filter(Boolean)}
function fingerprint(page:NotionPage){
  return workHash(JSON.stringify({
    title:page.title,status:page.values?.status??'',assignee:page.values?.assignee??'',progress:page.values?.progress??0,
    review:page.values?.review??'',documents:page.values?.documents??'',outputs:page.values?.outputs??'',conversation:page.values?.conversation??'',
    blockedBy:page.blockedBy??[],subItemOf:page.subItemOf??null,body:blockText(page.blocks),
  }))
}
function ensureDatabase(file:string,team:string,databaseId:string){
  const existing=readPage(file)
  const previous=existing?.database?.columns?.find((column:any)=>column.id==='status')?.statusGroups
  const groups={todo:[...(previous?.todo??['待分派','就绪'])],doing:[...(previous?.doing??['执行中','待审查','待验收','阻塞'])],done:[...(previous?.done??['完成'])]}
  for(const [name,group] of Object.entries(pipeline)){
    for(const key of ['todo','doing','done'] as const)groups[key]=groups[key].filter((value:string)=>value!==name)
    groups[group].push(name)
  }
  const status={
    ...(existing?.database?.columns?.find((column:any)=>column.id==='status')??{}),
    id:'status',name:'状态',type:'status',statusGroups:groups,options:[...groups.todo,...groups.doing,...groups.done],defaultStatus:groups.todo.includes('待分派')?'待分派':groups.todo[0],
  }
  const columns=[
    status,
    {id:'assignee',name:'负责人',type:'text'},
    {id:'progress',name:'进度',type:'number'},
    {id:'documents',name:'相关文档',type:'text'},
    {id:'outputs',name:'产出',type:'text'},
    {id:'review',name:'要审查什么',type:'text'},
    {id:'conversation',name:'消息',type:'text'},
    {id:'date',name:'日期',type:'date'},
    {id:'parentItem',name:'父项目',type:'relation',relationTo:databaseId,system:'parentItem'},
    {id:'subItems',name:'子项目',type:'relation',relationTo:databaseId,system:'subItems'},
    {id:'blockedBy',name:'被阻挡',type:'relation',relationTo:databaseId,system:'blockedBy'},
    {id:'blocking',name:'正在阻挡',type:'relation',relationTo:databaseId,system:'blocking'},
  ]
  const viewId=existing?.database?.activeViewId||pageId(team,'view')
  const views=Array.isArray(existing?.database?.views)?existing.database.views:[]
  if(!views.some((view:any)=>view.type==='board'))views.unshift({id:viewId,name:'Board',type:'board',groupBy:'status',groupOrder:[...WORK_COLUMNS],hideEmptyGroups:false,filters:{id:pageId(team,'filters'),conjunction:'and',rules:[]},sorts:[],hiddenProperties:['review','outputs','conversation','date','parentItem','subItems','blocking'],openPagesIn:'side',cardPreview:'none',subItemDisplay:'card'})
  const now=Date.now()
  writePage(file,{
    id:databaseId,parentId:null,title:existing?.title||team,icon:existing?.icon||'📋',cover:existing?.cover??null,coverPosition:existing?.coverPosition??50,
    favorite:!!existing?.favorite,trashedAt:null,createdAt:existing?.createdAt||now,updatedAt:existing?.updatedAt||now,fullWidth:true,smallText:false,font:'default',locked:false,
    color:existing?.color||'blue',textColor:existing?.textColor||'default',values:existing?.values||{},blocks:existing?.blocks||[{id:databaseId+'-body',type:'paragraph',content:''}],
    database:{...(existing?.database||{}),columns,view:existing?.database?.view||'board',views,activeViewId:existing?.database?.activeViewId||views[0].id,groupBy:'status',subItems:true,dependencies:{enabled:true,dateProperty:'date',shift:'none',...(existing?.database?.dependencies||{})}},
  })
}
function chain(item:WorkItem,byId:Map<string,WorkItem>){
  const ids:string[]=[],seen=new Set<string>()
  let current:WorkItem|undefined=item
  while(current&&!seen.has(current.id)){seen.add(current.id);ids.push(current.id);current=current.subItemOf?byId.get(current.subItemOf):undefined}
  return ids.reverse()
}
/** Project cockpit markdown into a native MiniNotion database inside the notes collection. */
export function projectTeamBoard(collection:string,team:string,repo:string){
  fs.mkdirSync(path.join(collection,'.mininotion'),{recursive:true})
  const marker=path.join(collection,'.mininotion','collection.json')
  if(!fs.existsSync(marker))fs.writeFileSync(marker,JSON.stringify({format:'mininotion.collection/v1'})+'\n')
  const folder=workFolderName(team),databaseId=pageId(team,'board'),databaseDir=path.join(collection,folder)
  ensureDatabase(path.join(databaseDir,'index.mininotion.json'),team,databaseId)
  const sync=readSync(collection)
  const teamSync:TeamSync=sync.teams[team]??{databaseId,folder,cards:{}}
  const previous={...teamSync.cards}
  let items=readCockpit(repo)
  const byId=()=>new Map(items.map(item=>[item.id,item]))
  const pageToCard=new Map<string,string>()
  for(const [id,card] of Object.entries(teamSync.cards))pageToCard.set(card.pageId,id)
  for(const item of items)pageToCard.set(pageId(team,item.id),item.id)
  const pulled:string[]=[]
  for(const item of [...items]){
    const saved=teamSync.cards[item.id]
    const directory=saved?.directory&&fs.existsSync(path.join(collection,saved.directory,'index.mininotion.json'))?path.join(collection,saved.directory):path.join(databaseDir,...chain(item,byId()))
    const page=readPage(path.join(directory,'index.mininotion.json'))
    if(!page||!saved)continue
    if(fingerprint(page)===saved.notionHash||item.hash!==saved.markdownHash)continue
    const values=page.values||{}
    const blocked=Array.isArray(page.blockedBy)?page.blockedBy.map((id:string)=>pageToCard.get(id)).filter((id:string|undefined):id is string=>!!id&&id!==item.id):item.blockedBy
    const parent=typeof page.subItemOf==='string'?pageToCard.get(page.subItemOf)??null:item.subItemOf
    const next=saveCockpitCard(repo,{
      id:item.id,title:String(page.title||item.title),assignee:String(values.assignee??item.assignee),progress:Number(values.progress??item.progress)||0,
      review:String(values.review??item.review),documents:values.documents===undefined?item.documents:lines(values.documents),outputs:values.outputs===undefined?item.outputs:lines(values.outputs),
      conversation:values.conversation===undefined?item.conversation:String(values.conversation||''),blockedBy:blocked,subItemOf:parent===undefined?item.subItemOf:parent,
      body:blockText(page.blocks),...(values.status!==saved.projectedStatus&&(WORK_COLUMNS as readonly string[]).includes(String(values.status))?{status:values.status as WorkColumn}:{}),
    },item.hash)
    pulled.push(item.id)
    items=next.items
  }
  items=readCockpit(repo)
  const ids=new Map(items.map(item=>[item.id,item]))
  for(const item of [...items].sort((a,b)=>chain(a,ids).length-chain(b,ids).length)){
    const directory=path.join(databaseDir,...chain(item,ids))
    const relative=path.relative(collection,directory)
    const file=path.join(directory,'index.mininotion.json')
    const existing=readPage(file)
    const id=existing?.id||pageId(team,item.id)
    const parentCard=item.subItemOf?ids.get(item.subItemOf):undefined
    const blocked=item.blockedBy.map(value=>pageId(team,value))
    const body=item.body.trim()
    const page:NotionPage={
      ...(existing||{}),
      id,parentId:databaseId,title:item.title,icon:existing?.icon||'',cover:existing?.cover??null,coverPosition:existing?.coverPosition??50,
      favorite:!!existing?.favorite,trashedAt:null,createdAt:existing?.createdAt||Date.now(),updatedAt:existing?.updatedAt||Date.now(),fullWidth:!!existing?.fullWidth,smallText:!!existing?.smallText,
      font:existing?.font||'default',locked:false,color:existing?.color||'white',textColor:existing?.textColor||'default',
      subItemOf:parentCard?pageId(team,parentCard.id):null,blockedBy:blocked,
      values:{...(existing?.values||{}),status:workColumn(item.status),assignee:item.assignee,progress:item.progress,documents:item.documents.join('\n'),outputs:item.outputs.join('\n'),review:item.review,conversation:item.conversation||''},
      blocks:blockText(existing?.blocks)===body&&existing?.blocks?.length?existing.blocks:[{id:id+'-body',type:'paragraph',content:body}],
    }
    writePage(file,page)
    const fresh=readPage(file)!
    teamSync.cards[item.id]={pageId:id,directory:relative,notionHash:fingerprint(fresh),markdownHash:item.hash,projectedStatus:String(fresh.values.status)}
    pageToCard.set(id,item.id)
  }
  for(const [id,card] of Object.entries(previous)){
    const next=teamSync.cards[id]
    if(!next||next.directory===card.directory)continue
    if(Object.values(teamSync.cards).some(other=>other.directory===card.directory))continue
    fs.rmSync(path.join(collection,card.directory,'index.mininotion.json'),{force:true})
  }
  sync.teams[team]={...teamSync,databaseId,folder}
  writeSync(collection,sync)
  return {team,folder,databaseId,collection,items:items.length,pulled}
}
export function lookupWorkPage(collection:string,pageId:string){
  const sync=readSync(collection)
  for(const [team,entry] of Object.entries(sync.teams||{})){
    for(const [itemId,card] of Object.entries(entry.cards||{}))if(card.pageId===pageId)return {team,itemId}
  }
}
