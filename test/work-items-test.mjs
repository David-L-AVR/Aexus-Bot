import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const project=path.resolve(import.meta.dirname,'..')
const cockpit=await import('../src/main/work-cockpit.ts')
const notion=await import('../src/main/work-notion.ts')
const {externalDispatchText,assignmentText}=await import('../src/shared/work-items.ts')
const root=fs.mkdtempSync(path.join(os.tmpdir(),'aexus-cockpit-'))
const dir=path.join(root,'docs','ai-finance','cockpit')
fs.mkdirSync(dir,{recursive:true})
fs.writeFileSync(path.join(dir,'T1.md'),`---
id: T1
title: Review the ledger
status: 进行中
assignee: Ada
progress: 20
blockedBy: []
outputs: []
documents:
  - docs/ai-finance/brief.md
changedFiles:
  - src/ledger.ts
unverified:
  - quota
review: Check the diff
note: keep me
---
Original body.
`)
fs.writeFileSync(path.join(root,'docs','ai-finance','brief.md'),'# brief\n')
let items=cockpit.readCockpit(root)
assert.equal(items.length,1)
assert.equal(items[0].status,'进行中')
assert.equal(items[0].column,'执行中')
assert.equal(items[0].body.trim(),'Original body.')
assert.equal(items[0].extra.note,'keep me')
const moved=cockpit.saveCockpitCard(root,{id:'T1',status:'待审查'},items[0].hash)
assert.equal(moved.item.column,'待审查')
assert.equal(moved.item.status,'待审查')
assert.match(fs.readFileSync(path.join(dir,'T1.md'),'utf8'),/Original body/)
assert.match(fs.readFileSync(path.join(dir,'T1.md'),'utf8'),/note: keep me/)
assert.equal(moved.item.path,'docs/ai-finance/cockpit/T1.md')
const child=cockpit.saveCockpitCard(root,{title:'Split the check',subItemOf:'T1',blockedBy:['T1'],documents:['docs/ai-finance/brief.md']})
assert.equal(child.item.subItemOf,'T1')
assert.deepEqual(child.item.blockedBy,['T1'])
assert.deepEqual(cockpit.readCockpit(root).find(item=>item.id==='T1').children,[child.item.id])
assert.throws(()=>cockpit.saveCockpitCard(root,{id:child.item.id,subItemOf:child.item.id},child.item.hash),/cycle|itself/)
assert.throws(()=>cockpit.repoRelative(root,'../secret'),/inside the team repository/)
const docs=cockpit.docsTree(root,cockpit.readCockpit(root))
assert.ok(docs.some(file=>file.path==='docs/ai-finance/brief.md'&&file.workItemIds.includes('T1')))
const payload={path:moved.item.path,changedFiles:['src/ledger.ts'],unverified:['quota'],review:'Check the diff'}
const external=externalDispatchText(payload)
assert.match(external,/^task: docs\/ai-finance\/cockpit\/T1.md/m)
assert.match(external,/src\/ledger.ts/)
assert.match(external,/quota/)
assert.match(external,/Check the diff/)
assert.doesNotMatch(external,/员工手册|你被雇|Secretary|组织关系|handbook/i)
assert.doesNotMatch(external,/Ada|Review the ledger/)
const assignment=assignmentText(moved.item)
assert.match(assignment,/docs\/ai-finance\/cockpit\/T1.md/)
assert.doesNotMatch(assignment,/员工手册|你被雇为/)
fs.rmSync(dir,{recursive:true})
fs.mkdirSync(dir,{recursive:true})
fs.writeFileSync(path.join(dir,'TASKS.md'),`# Index\n\n## T2 Close the books\nstatus: blocked\nassignee: Bo\n\nStill open.\n`)
const projected=cockpit.readCockpit(root)
assert.equal(projected.length,1)
assert.equal(projected[0].id,'T2')
assert.equal(projected[0].column,'阻塞')
assert.equal(projected[0].status,'blocked')
const collection=fs.mkdtempSync(path.join(os.tmpdir(),'aexus-notion-'))
const board=notion.projectTeamBoard(collection,'ai finance',root)
const database=JSON.parse(fs.readFileSync(path.join(collection,board.folder,'index.mininotion.json'),'utf8'))
assert.equal(database.format,'mininotion.page/v1')
assert.equal(database.page.database.view,'board')
assert.deepEqual(database.page.database.columns.find(column=>column.id==='status').options,['待分派','就绪','执行中','待审查','待验收','阻塞','完成'])
const record=JSON.parse(fs.readFileSync(path.join(collection,board.folder,'T2','index.mininotion.json'),'utf8'))
assert.equal(record.page.values.status,'阻塞')
assert.equal(record.page.parentId,database.page.id)
assert.match(fs.readFileSync(path.join(dir,'TASKS.md'),'utf8'),/status: blocked/)
record.page.values.status='待审查'
record.page.updatedAt=Date.now()
fs.writeFileSync(path.join(collection,board.folder,'T2','index.mininotion.json'),JSON.stringify(record))
notion.projectTeamBoard(collection,'ai finance',root)
assert.match(fs.readFileSync(path.join(dir,'T2.md'),'utf8'),/status: 待审查/)
const host=fs.readFileSync(path.join(project,'src/renderer/src/pluginHost.tsx'),'utf8')
assert.equal(host.includes('WorkBoard'),false)
assert.equal(host.includes('工作项'),false)
console.log('PASS work items: cockpit markdown stays in the bound repository, MiniNotion receives a native board, and the plugin host has no overlay')
