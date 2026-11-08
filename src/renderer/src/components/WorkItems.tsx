import {useEffect,useState} from 'react'
import {translate as uiText,useI18n} from '../i18n'
import {WORK_COLUMNS,type WorkColumn} from '../../../shared/work-items'
import '../styles/work-items.css'

export type WorkCall=(command:string,args?:Record<string,unknown>)=>Promise<any>
type Item={id:string;title:string;status:string;column:WorkColumn;assignee:string;progress:number;subItemOf:string|null;blockedBy:string[];children:string[];blocking:string[];outputs:string[];documents:string[];changedFiles?:string[];unverified?:string[];review?:string;conversation?:string;path:string;hash:string;body?:string}
type Dispatch={id:string;team:string;itemId:string;fromEmployeeId:string;to:{kind:'employee'|'worker';id:string};conversation?:string;externalText:string;assignment:string;status:string}
type Board={needsTeam?:boolean;teams?:{name:string;hasCockpit:boolean}[];team?:string;available?:boolean;reason?:string;cockpit?:string;columns?:WorkColumn[];items?:Item[]}

export function WorkBoard({call,team,conversation,onOpenConversation,onOpenDocuments}:{call:WorkCall;team?:string;conversation?:string;onOpenConversation?:(conversation:string)=>void;onOpenDocuments?:()=>void}){
  useI18n()
  const [board,setBoard]=useState<Board>(),[selected,setSelected]=useState<string>(),[detail,setDetail]=useState<Item>(),[dispatches,setDispatches]=useState<Dispatch[]>([]),[title,setTitle]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[drop,setDrop]=useState<string>()
  const load=async(nextTeam=team)=>{
    const [value,pending]=await Promise.all([call('work.board',nextTeam?{team:nextTeam}:{}),call('work.dispatches',{...(nextTeam?{team:nextTeam}:{}),...(conversation?{conversation}:{})})])
    setBoard(value);setDispatches(pending.dispatches??[])
    return value as Board
  }
  useEffect(()=>{let live=true;setError('');void load().catch(cause=>{if(live)setError(cause.message)});return()=>{live=false}},[team,conversation])
  const open=async(id:string)=>{
    setSelected(id);setError('')
    try{const value=await call('work.get',{id,...(board?.team?{team:board.team}:{})});setDetail(value)}catch(cause){setError((cause as Error).message)}
  }
  const save=async(patch:Record<string,unknown>,hash?:string)=>{
    setBusy(true);setError('')
    try{const saved=await call('work.save',{...patch,...(board?.team?{team:board.team}:{}),...(hash?{expectedHash:hash}:{})});setDetail(saved.item);await load();setSelected(saved.item.id)}catch(cause){setError((cause as Error).message)}finally{setBusy(false)}
  }
  const decide=async(id:string,allow:boolean)=>{
    setBusy(true);setError('')
    try{await call(allow?'work.confirm':'work.deny',{id});await load()}catch(cause){setError((cause as Error).message)}finally{setBusy(false)}
  }
  const items=board?.items??[]
  return <section className="work-board" aria-label={uiText('Work items')}>
    <div className="work-board-toolbar">
      <strong>{uiText('Work items')}</strong>
      <small>{board?.team?board.team+' · '+uiText('docs/ai-finance/cockpit'):uiText('Current team repository')}</small>
      <span className="spacer"/>
      {onOpenDocuments&&<button type="button" onClick={onOpenDocuments}>{uiText('Project documents')}</button>}
      <input aria-label={uiText('New work item title')} value={title} placeholder={uiText('New work item')} onChange={event=>setTitle(event.target.value)}/>
      <button type="button" disabled={busy||!title.trim()} onClick={()=>{const value=title.trim();setTitle('');void save({title:value})}}>{uiText('Add')}</button>
    </div>
    {board?.needsTeam&&<div className="work-board-toolbar">{board.teams?.map(choice=><button type="button" key={choice.name} onClick={()=>void load(choice.name).catch(cause=>setError(cause.message))}>{choice.name}</button>)}</div>}
    {board&&board.available===false&&<p className="work-muted" style={{padding:'8px 14px'}}>{board.reason??uiText('This team has no cockpit folder yet. Cards are written to docs/ai-finance/cockpit in the bound repository.')}</p>}
    {error&&<p className="work-error" role="alert">{error}</p>}
    {dispatches.map(dispatch=><DispatchCard key={dispatch.id} dispatch={dispatch} busy={busy} onDecide={decide}/>)}
    <div className="work-board-scroll">
      {WORK_COLUMNS.map(column=><div key={column} className={'work-column'+(drop===column?' drop':'')} onDragOver={event=>{event.preventDefault();setDrop(column)}} onDragLeave={()=>setDrop(current=>current===column?'':current)} onDrop={event=>{event.preventDefault();setDrop('');const id=event.dataTransfer.getData('text/work-item');const card=items.find(item=>item.id===id);if(card&&card.column!==column)void save({id:card.id,status:column},card.hash)}}>
        <header>{column}<b>{items.filter(item=>item.column===column).length}</b></header>
        {items.filter(item=>item.column===column).map(item=><button key={item.id} type="button" className={'work-card'+(selected===item.id?' selected':'')} draggable onDragStart={event=>event.dataTransfer.setData('text/work-item',item.id)} onClick={()=>void open(item.id)}>
          <strong>{item.title}</strong>
          <p>{item.assignee||uiText('Unassigned')}{item.blockedBy.length?' · '+uiText('Blocked'):''}</p>
          <div className="work-meta">{item.status&&item.status!==item.column&&<span>{item.status}</span>}{!!item.documents.length&&<span>{uiText('{0} documents',[item.documents.length])}</span>}{!!item.outputs.length&&<span>{uiText('{0} outputs',[item.outputs.length])}</span>}{item.conversation&&<span>{uiText('In a conversation')}</span>}</div>
          <div className="work-progress" aria-hidden="true"><i style={{width:item.progress+'%'}}/></div>
        </button>)}
        {!items.some(item=>item.column===column)&&<div className="work-empty">{uiText('Empty')}</div>}
      </div>)}
    </div>
    {detail&&<WorkDetail key={detail.id+detail.hash} item={detail} busy={busy} onSave={patch=>save({id:detail.id,...patch},detail.hash)} onOpen={id=>void open(id)} onOpenConversation={onOpenConversation} onOpenDocuments={onOpenDocuments}/>}
  </section>
}
function WorkDetail({item,busy,onSave,onOpen,onOpenConversation,onOpenDocuments}:{item:Item;busy:boolean;onSave:(patch:Record<string,unknown>)=>Promise<void>|void;onOpen:(id:string)=>void;onOpenConversation?:(conversation:string)=>void;onOpenDocuments?:()=>void}){
  const [draft,setDraft]=useState({...item,blocked:item.blockedBy.join(', '),documents:item.documents.join('\n'),outputs:item.outputs.join('\n'),changed: (item.changedFiles??[]).join('\n'),unverified:(item.unverified??[]).join('\n'),review:item.review??'',body:item.body??''})
  const lines=(value:string)=>value.split('\n').map(item=>item.trim()).filter(Boolean)
  return <div className="work-detail">
    <div>
      <h3>{item.id} · {item.title}</h3>
      <p className="work-muted">{item.path} · {uiText('Progress')} {item.progress}%</p>
      <label>{uiText('Title')}<input value={draft.title} onChange={event=>setDraft({...draft,title:event.target.value})}/></label>
      <label>{uiText('Status')}<select value={draft.column} onChange={event=>setDraft({...draft,column:event.target.value as WorkColumn})}>{WORK_COLUMNS.map(column=><option key={column}>{column}</option>)}</select></label>
      <label>{uiText('Assignee')}<input value={draft.assignee} onChange={event=>setDraft({...draft,assignee:event.target.value})}/></label>
      <label>{uiText('Progress')}<input type="number" min={0} max={100} value={draft.progress} onChange={event=>setDraft({...draft,progress:Number(event.target.value)})}/></label>
      <label>{uiText('What to review')}<textarea value={draft.review} onChange={event=>setDraft({...draft,review:event.target.value})}/></label>
      <label>{uiText('Card notes')}<textarea value={draft.body} onChange={event=>setDraft({...draft,body:event.target.value})}/></label>
      <div className="work-actions"><button type="button" className="primary" disabled={busy} onClick={()=>void onSave({title:draft.title,status:draft.column,assignee:draft.assignee,progress:draft.progress,review:draft.review,body:draft.body,blockedBy:draft.blocked.split(',').map(item=>item.trim()).filter(Boolean),documents:lines(draft.documents),outputs:lines(draft.outputs),changedFiles:lines(draft.changed),unverified:lines(draft.unverified)})}>{uiText('Save')}</button></div>
    </div>
    <div>
      <h3>{uiText('Dependencies')}</h3>
      <p className="work-muted">{uiText('Parent')} {item.subItemOf??uiText('None')}</p>
      <div className="work-actions">{item.blockedBy.map(id=><button type="button" key={id} onClick={()=>onOpen(id)}>{uiText('Blocked by')} {id}</button>)}{item.children.map(id=><button type="button" key={id} onClick={()=>onOpen(id)}>{uiText('Sub-item')} {id}</button>)}{item.blocking.map(id=><button type="button" key={id} onClick={()=>onOpen(id)}>{uiText('Blocking')} {id}</button>)}</div>
      <label>{uiText('Blocked by')}<input value={draft.blocked} onChange={event=>setDraft({...draft,blocked:event.target.value})}/></label>
      <h3>{uiText('Outputs and documents')}</h3>
      <label>{uiText('Outputs')}<textarea value={draft.outputs} onChange={event=>setDraft({...draft,outputs:event.target.value})}/></label>
      <label>{uiText('Related documents')}<textarea value={draft.documents} onChange={event=>setDraft({...draft,documents:event.target.value})}/></label>
      <label>{uiText('Changed files')}<textarea value={draft.changed} onChange={event=>setDraft({...draft,changed:event.target.value})}/></label>
      <label>{uiText('Unverified')}<textarea value={draft.unverified} onChange={event=>setDraft({...draft,unverified:event.target.value})}/></label>
      <div className="work-actions">
        {onOpenDocuments&&<button type="button" onClick={onOpenDocuments}>{uiText('Show in Files')}</button>}
        {item.conversation&&onOpenConversation&&<button type="button" onClick={()=>onOpenConversation(item.conversation!)}>{uiText('Open Message')}</button>}
      </div>
    </div>
  </div>
}
export function DispatchCard({dispatch,busy,onDecide}:{dispatch:Dispatch;busy?:boolean;onDecide:(id:string,allow:boolean)=>void}){
  useI18n()
  const external=dispatch.to.kind==='worker'
  return <form className="work-approval approval" onSubmit={event=>{event.preventDefault();onDecide(dispatch.id,true)}}>
    <strong>{uiText('Needs your approval')}</strong>
    <p>{uiText(external?'Send this review request to the external worker?':'Assign this work item to the employee?')}</p>
    <pre>{external?dispatch.externalText:dispatch.assignment}</pre>
    <div className="btn-row"><button type="button" disabled={busy} onClick={()=>onDecide(dispatch.id,false)}>{uiText('Deny')}</button><button className="primary" disabled={busy}>{uiText('Allow once')}</button></div>
  </form>
}
export function WorkConversationBar({call,conversation,team,onOpenBoard}:{call:WorkCall;conversation:string;team?:string;onOpenBoard?:()=>void}){
  useI18n()
  const [items,setItems]=useState<Item[]>([]),[linked,setLinked]=useState(''),[dispatches,setDispatches]=useState<Dispatch[]>([]),[error,setError]=useState('')
  const load=()=>Promise.all([call('work.board',team?{team}:{}),call('work.dispatches',{...(team?{team}:{}),conversation})]).then(([board,pending])=>{if(!board.needsTeam){setItems(board.items??[]);setLinked(board.items?.find((item:Item)=>item.conversation===conversation)?.id??'')};setDispatches(pending.dispatches??[])}).catch(cause=>setError(cause.message))
  useEffect(()=>{void load()},[conversation,team])
  const link=async(id:string)=>{
    const item=items.find(value=>value.id===id);if(!item)return
    setError('')
    try{await call('work.link',{id,conversation,expectedHash:item.hash,...(team?{team}:{})});setLinked(id);await load()}catch(cause){setError((cause as Error).message)}
  }
  return <div className="work-conversation-links">
    <div className="work-conversation-bar">
      <span className="work-chip">{uiText('Work item')}</span>
      <select aria-label={uiText('Linked work item')} value={linked} onChange={event=>void link(event.target.value)}>
        <option value="">{uiText('Not linked')}</option>
        {items.map(item=><option key={item.id} value={item.id}>{item.id} · {item.title}</option>)}
      </select>
      {onOpenBoard&&<button type="button" onClick={onOpenBoard}>{uiText('Open in MiniNotion')}</button>}
      {error&&<span className="work-error" role="alert">{error}</span>}
    </div>
    {dispatches.map(dispatch=><DispatchCard key={dispatch.id} dispatch={dispatch} onDecide={(id,allow)=>void call(allow?'work.confirm':'work.deny',{id}).then(load).catch(cause=>setError(cause.message))}/>)}
  </div>
}
