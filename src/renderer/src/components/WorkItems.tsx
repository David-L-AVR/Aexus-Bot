import {useEffect,useState} from 'react'
import {translate as uiText,useI18n} from '../i18n'
import {Icon} from './Icon'

export type WorkCall=(command:string,args?:Record<string,unknown>)=>Promise<any>
type Item={id:string;title:string;conversation?:string;hash:string}
type Dispatch={id:string;to:{kind:'employee'|'worker';id:string};externalText:string;assignment:string}
export function DispatchCard({dispatch,busy,onDecide}:{dispatch:Dispatch;busy?:boolean;onDecide:(id:string,allow:boolean)=>void}){
  useI18n()
  const external=dispatch.to.kind==='worker'
  return <form className="approval" onSubmit={event=>{event.preventDefault();onDecide(dispatch.id,true)}}>
    <strong>{uiText('Needs your approval')}</strong>
    <p>{uiText(external?'Send this review request to the external worker?':'Assign this work item to the employee?')}</p>
    <pre>{external?dispatch.externalText:dispatch.assignment}</pre>
    <div className="btn-row"><button type="button" className="btn" disabled={busy} onClick={()=>onDecide(dispatch.id,false)}>{uiText('Deny')}</button><button className="btn primary" disabled={busy}>{uiText('Allow once')}</button></div>
  </form>
}
/** One existing Message row. The board itself stays inside MiniNotion. */
export function WorkConversationBar({call,conversation,team,onOpenBoard}:{call:WorkCall;conversation:string;team?:string;onOpenBoard?:()=>void}){
  useI18n()
  const [items,setItems]=useState<Item[]>([]),[linked,setLinked]=useState(''),[dispatches,setDispatches]=useState<Dispatch[]>([]),[error,setError]=useState('')
  const load=()=>Promise.all([call('work.board',team?{team}:{}),call('work.dispatches',{...(team?{team}:{}),conversation})]).then(([board,pending])=>{if(!board.needsTeam){setItems(board.items??[]);setLinked((board.items??[]).find((item:Item)=>item.conversation===conversation)?.id??'')};setDispatches(pending.dispatches??[])}).catch((cause:Error)=>setError(cause.message))
  useEffect(()=>{void load()},[conversation,team])
  if(!error&&!items.length&&!dispatches.length)return null
  const link=async(id:string)=>{
    const item=items.find(value=>value.id===id);if(!item)return
    setError('')
    try{await call('work.link',{id,conversation,expectedHash:item.hash,...(team?{team}:{})});setLinked(id);await load()}catch(cause){setError((cause as Error).message)}
  }
  return <>
    <div className="message-resume-forward">
      <Icon name="files"/>
      <span>{uiText('Work item')}</span>
      <select aria-label={uiText('Linked work item')} value={linked} onChange={event=>void link(event.target.value)}>
        <option value="">{uiText('Not linked')}</option>
        {items.map(item=><option key={item.id} value={item.id}>{item.id} · {item.title}</option>)}
      </select>
      {onOpenBoard&&<button type="button" onClick={onOpenBoard}>{uiText('Open in MiniNotion')}</button>}
      {error&&<span role="alert">{error}</span>}
    </div>
    {dispatches.map(dispatch=><DispatchCard key={dispatch.id} dispatch={dispatch} onDecide={(id,allow)=>void call(allow?'work.confirm':'work.deny',{id}).then(load).catch((cause:Error)=>setError(cause.message))}/>)}
  </>
}
