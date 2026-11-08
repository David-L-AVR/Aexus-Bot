import { useEffect, useState } from 'react';
import type { Page } from '../types';

type Person = { id: string; title: string; kind: 'employee' | 'worker' };
/** Shown on a projected cockpit record, using the same property row as the rest of the card. */
export function WorkAssign({ page }: { page: Page }) {
  const pageId = page.id;
  const initiator = String(page.values?.initiator || '');
  const proposed = String(page.values?.proposedAssignee || '');
  const pending = String(page.values?.status || '') === '待分派' || String(page.values?.status || '') === '就绪';
  const [people, setPeople] = useState<Person[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let live = true;
    void window.native.api('work.candidates', { pageId }).then(response => {
      if (!live) return;
      if (response.error) setMessage(response.error.message);
      else {
        const list: Person[] = response.result?.people || [];
        setPeople(list);
        const wanted = proposed || String(page.values?.assignee || '');
        const match = list.find(person => person.title === wanted);
        if (match) setSelected(match.kind + ':' + match.id);
      }
    }).catch(error => { if (live) setMessage(String(error)); });
    return () => { live = false; };
  }, [pageId]);
  const start = async () => {
    const person = people.find(item => item.kind + ':' + item.id === selected);
    if (!person) return;
    setBusy(true);
    setMessage('');
    try {
      const response = await window.native.api('work.start', { pageId, to: person.id, kind: person.kind });
      if (response.error) throw new Error(response.error.message);
      setMessage('已开始执行，消息窗口已打开');
    } catch (error) {
      setMessage(String((error as Error).message || error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {initiator && <div className="page-property"><span className="page-property-label">发起人</span><span>{initiator}</span></div>}
      {proposed && <div className="page-property"><span className="page-property-label">建议分派</span><span>{proposed}</span></div>}
      <div className="page-property">
        <span className="page-property-label">负责人</span>
        <select aria-label="选择负责人" className="property-input" value={selected} disabled={busy} onChange={event => setSelected(event.target.value)}>
          <option value="">{people.length ? '选择同事' : '没有可分派的人'}</option>
          {people.map(person => <option key={person.kind + person.id} value={person.kind + ':' + person.id}>{person.title}{person.kind === 'worker' ? ' · 外部' : ''}</option>)}
        </select>
        <button type="button" className="text-button" disabled={busy || !selected} onClick={() => void start()}>{pending ? '批准并开始' : '开始执行'}</button>
      </div>
      {message && <div className="page-property"><span className="page-property-label" /><small>{message}</small></div>}
    </>
  );
}
