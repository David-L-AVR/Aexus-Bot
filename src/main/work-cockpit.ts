import {createHash} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {COCKPIT_RELATIVE,DOCS_RELATIVE,WORK_COLUMNS,assertWorkRelations,cardFromMarkdown,cardsFromTasksIndex,relateWorkItems,serializeWorkCard,type WorkColumn,type WorkItem} from '../shared/work-items.ts'

export const workHash=(text:string)=>createHash('sha256').update(text).digest('hex')
const posix=path.posix
export function repoRelative(root:string,value:string){
  if(typeof value!=='string'||!value.trim()||value.includes('\0')||value.includes('\\'))throw Error('Work item path must stay inside the team repository')
  const normal=posix.normalize(value.replaceAll('\\','/')).replace(/^\.\//,'')
  if(!normal||normal==='.'||posix.isAbsolute(normal)||normal.split('/').includes('..'))throw Error('Work item path must stay inside the team repository')
  const resolved=path.resolve(root,normal)
  const base=path.resolve(root)
  if(resolved!==base&&!resolved.startsWith(base+path.sep))throw Error('Work item path must stay inside the team repository')
  return {relative:normal,absolute:resolved}
}
export function cockpitDirectory(root:string){
  return repoRelative(root,COCKPIT_RELATIVE).absolute
}
export function cockpitAvailable(root:string){
  try{return fs.existsSync(cockpitDirectory(root))&&fs.statSync(cockpitDirectory(root)).isDirectory()}catch{return false}
}
function readCardFile(root:string,relative:string):WorkItem|null{
  const file=repoRelative(root,relative)
  if(!file.relative.startsWith(COCKPIT_RELATIVE+'/')||file.relative.slice(COCKPIT_RELATIVE.length+1).includes('/'))return null
  let text:string
  try{text=fs.readFileSync(file.absolute,'utf8')}catch{return null}
  const card=cardFromMarkdown(file.relative,text)
  if(!card)return null
  card.hash=workHash(text)
  return card
}
export function readCockpit(root:string):WorkItem[]{
  const directory=cockpitDirectory(root)
  if(!fs.existsSync(directory))return []
  const names=fs.readdirSync(directory,{withFileTypes:true}).filter(entry=>entry.isFile()&&entry.name.endsWith('.md')).map(entry=>entry.name).sort()
  const items=names.flatMap(name=>{const card=readCardFile(root,COCKPIT_RELATIVE+'/'+name);return card?[card]:[]})
  const seen=new Set<string>()
  for(const item of items){if(seen.has(item.id))throw Error('Duplicate work item id '+item.id);seen.add(item.id)}
  if(items.length)return relateWorkItems(items)
  const indexPath=path.join(directory,'TASKS.md')
  if(!fs.existsSync(indexPath))return []
  const index=fs.readFileSync(indexPath,'utf8')
  const projected=cardsFromTasksIndex(index).map(card=>({...card,hash:workHash(index+'\n'+card.id)}))
  return relateWorkItems(projected)
}
export function writeCockpitIndex(root:string,items:WorkItem[]){
  const file=repoRelative(root,COCKPIT_RELATIVE+'/TASKS.md')
  const previous=fs.existsSync(file.absolute)?fs.readFileSync(file.absolute,'utf8'):''
  const marker='<!-- aexus-work-index -->'
  const table=['| ID | Title | Status | Assignee |','| --- | --- | --- | --- |',...items.map(item=>`| [${item.id}](${path.posix.basename(item.path)}) | ${item.title.replaceAll('|','/')} | ${item.status||item.column} | ${item.assignee.replaceAll('|','/')} |`)].join('\n')
  const generated=`${marker}\n# Tasks\n\nCards in this folder are the work-item source for the current team.\n\n${table}\n`
  if(previous.includes(marker)||!previous.trim())fs.writeFileSync(file.absolute,generated)
}
export function saveCockpitCard(root:string,patch:Partial<WorkItem>&{id?:string;title?:string;status?:WorkColumn},expectedHash?:string){
  fs.mkdirSync(cockpitDirectory(root),{recursive:true})
  const existing=readCockpit(root)
  const id=patch.id??nextId(existing)
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id))throw Error('Work item id must be a short file-safe token')
  const current=existing.find(item=>item.id===id)
  if(current&&expectedHash&&expectedHash!==current.hash)throw Error('Work item changed. Reload the card and try again.')
  if(!current&&!patch.title?.trim())throw Error('A new work item needs a title')
  if(patch.status&&!(WORK_COLUMNS as readonly string[]).includes(patch.status))throw Error('Status must be one of the pipeline columns')
  const relativePath=COCKPIT_RELATIVE+'/'+id+'.md'
  const previousFile=current?repoRelative(root,current.path):undefined
  const previousText=previousFile&&fs.existsSync(previousFile.absolute)?fs.readFileSync(previousFile.absolute,'utf8'):undefined
  const next:WorkItem={
    id,
    title:(patch.title??current?.title??id).trim(),
    status:patch.status??current?.status??'待分派',
    column:patch.status??current?.column??'待分派',
    assignee:patch.assignee??current?.assignee??'',
    progress:patch.progress??current?.progress??0,
    subItemOf:patch.subItemOf===undefined?current?.subItemOf??null:patch.subItemOf||null,
    blockedBy:patch.blockedBy??current?.blockedBy??[],
    children:[],blocking:[],
    outputs:patch.outputs??current?.outputs??[],
    documents:patch.documents??current?.documents??[],
    changedFiles:patch.changedFiles??current?.changedFiles??[],
    unverified:patch.unverified??current?.unverified??[],
    review:patch.review??current?.review??'',
    conversation:patch.conversation===undefined?current?.conversation:patch.conversation||undefined,
    path:relativePath,
    body:patch.body??current?.body??'',
    hash:'',
    extra:current?.extra??{}
  }
  for(const value of [...next.outputs,...next.documents]){
    const relative=repoRelative(root,value).relative
    if(!relative.startsWith(DOCS_RELATIVE+'/'))throw Error('Related documents stay under docs/ai-finance')
  }
  for(const value of next.changedFiles)repoRelative(root,value)
  if(next.subItemOf&&!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(next.subItemOf))throw Error('subItemOf must be a work item id')
  if(next.blockedBy.some(value=>!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(value)))throw Error('blockedBy must list work item ids')
  const siblings=existing.filter(item=>item.id!==id).concat(next)
  assertWorkRelations(siblings)
  const text=serializeWorkCard(next,previousText)
  const destination=repoRelative(root,relativePath)
  fs.writeFileSync(destination.absolute,text)
  if(current&&current.path!==relativePath){
    const old=repoRelative(root,current.path)
    if(old.absolute!==destination.absolute&&fs.existsSync(old.absolute))fs.rmSync(old.absolute)
  }
  const saved=readCockpit(root)
  writeCockpitIndex(root,saved)
  const card=saved.find(item=>item.id===id)
  if(!card)throw Error('Saved work item could not be read back')
  return {item:card,items:saved}
}
function nextId(items:WorkItem[]){
  const numbers=items.map(item=>/^T(\d+)$/.exec(item.id)?.[1]).filter((value):value is string=>!!value).map(Number)
  const next=(numbers.length?Math.max(...numbers):0)+1
  return 'T'+next
}
export function docsTree(root:string,items:WorkItem[]){
  const directory=repoRelative(root,DOCS_RELATIVE).absolute
  const files:{path:string;name:string;directory:boolean;bytes:number;modifiedAt:number;workItemIds:string[]}[]=[]
  const walk=(absolute:string,relative:string)=>{
    if(!fs.existsSync(absolute)||files.length>400)return
    for(const entry of fs.readdirSync(absolute,{withFileTypes:true})){
      if(entry.name==='.git'||entry.name==='node_modules'||entry.name.startsWith('.'))continue
      const nextRelative=relative?relative+'/'+entry.name:entry.name
      const nextAbsolute=path.join(absolute,entry.name)
      if(entry.isDirectory()){
        files.push({path:DOCS_RELATIVE+'/'+nextRelative,name:entry.name,directory:true,bytes:0,modifiedAt:0,workItemIds:[]})
        walk(nextAbsolute,nextRelative)
      }else if(entry.isFile()){
        const stat=fs.statSync(nextAbsolute)
        const full=DOCS_RELATIVE+'/'+nextRelative
        files.push({path:full,name:entry.name,directory:false,bytes:stat.size,modifiedAt:stat.mtimeMs,workItemIds:items.filter(item=>item.documents.includes(full)||item.outputs.includes(full)||item.path===full).map(item=>item.id)})
      }
    }
  }
  if(fs.existsSync(directory))walk(directory,'')
  return files
}
export function itemsForPath(items:WorkItem[],relative:string){
  const normal=relative.replaceAll('\\','/').replace(/^\.\//,'')
  return items.filter(item=>item.path===normal||item.documents.includes(normal)||item.outputs.includes(normal)||item.documents.some(doc=>doc.startsWith(normal.replace(/\/$/,'')+'/'))||item.outputs.some(doc=>doc.startsWith(normal.replace(/\/$/,'')+'/')))
}
