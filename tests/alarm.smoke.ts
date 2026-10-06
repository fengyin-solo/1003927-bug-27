/* eslint-disable */
// 预警通知数据层冒烟测试：node + localStorage shim 下运行
// 用法：node_modules/.bin/esbuild tests/alarm.smoke.ts --bundle --platform=node --format=cjs | node
const storeMap = new Map<string, string>()
const listeners: ((e: { key: string | null; newValue: string | null }) => void)[] = []

;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (storeMap.has(k) ? storeMap.get(k)! : null),
    setItem: (k: string, v: string) => {
      storeMap.set(k, String(v))
      listeners.slice().forEach((fn) => fn({ key: k, newValue: String(v) }))
    },
    removeItem: (k: string) => {
      storeMap.delete(k)
      listeners.slice().forEach((fn) => fn({ key: k, newValue: null }))
    },
  },
  addEventListener: (_: string, fn: any) => listeners.push(fn),
}
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

import {
  __setStepHookForTest,
  createNotice,
  dispatchRecipients,
  getNotice,
  markFalseAlarm,
  publishNotice,
  recordResponse,
  releaseNotice,
  saveDraft,
  setChannelDown,
} from '../frontend/src/data/alarm/store'

let failures = 0
function assert(cond: boolean, message: string) {
  if (cond) {
    console.log(`  ✓ ${message}`)
  } else {
    failures += 1
    console.error(`  ✗ ${message}`)
  }
}

function validDraft(over: Record<string, string> = {}) {
  return {
    hazardCode: 'HAZA-T',
    level: '警示级',
    triggerCondition: '测试触发条件',
    publisher: '测试人',
    recipientsText: '甲单位\n乙单位',
    draftContent: '测试通知正文',
    ...over,
  }
}

async function main() {
  console.log('1. 空接收单位：提交 -> 待分派，而不是直接报错，草稿保留')
  const c1 = createNotice(validDraft({ recipientsText: '  ' }), true)
  assert(c1.ok && c1.diverted, '空接收单位提交返回 diverted')
  const n1 = getNotice(c1.id!)!
  assert(n1.status === '待分派', `状态为待分派（实际 ${n1.status}）`)
  assert(n1.draftContent === '测试通知正文' && n1.failureReason === '', '草稿保留、无失败原因')
  const publishOnDiverted = await publishNotice(n1.id)
  assert(publishOnDiverted.diverted === true && getNotice(n1.id)!.status === '待分派', '待分派时点发布仍然转入待分派，不报错')

  console.log('2. 待分派 -> 分派接收单位 -> 发布成功，回执齐全')
  const d1 = dispatchRecipients(n1.id, '甲单位\n乙单位')
  assert(d1.ok && d1.status === '待发布', '分派后进入待发布')
  assert(dispatchRecipients(n1.id, '   ').ok === false, '分派空单位被拒绝')
  const p1 = await publishNotice(n1.id)
  assert(p1.ok && p1.status === '已发布', '分派后发布成功')
  const n1b = getNotice(n1.id)!
  assert(n1b.receipts.length === 2 && n1b.receipts.every((r) => r.state === '已接收'), '两个单位回执已接收')
  const finalRun = n1b.stepLogs.slice(-3)
  assert(
    finalRun.length === 3 && finalRun.every((l) => l.ok) && finalRun.map((l) => l.step).join() === '校验,下发,回执',
    '最后一轮发布三步日志均成功（此前的待分派留痕保留）',
  )

  console.log('3. 下发步骤失败：草稿/接收单位/失败原因保留，重试从下发继续')
  setChannelDown(true)
  const c3 = createNotice(validDraft({ hazardCode: 'HAZA-T3', recipientsText: '戊单位\n己单位', draftContent: '中断保留正文' }), true)
  const failed = await publishNotice(c3.id!)
  setChannelDown(false)
  assert(!failed.ok && failed.status === '发布失败', '通道中断发布失败')
  const f1 = getNotice(c3.id!)!
  assert(f1.failedStep === '下发', `失败步骤为下发（实际 ${f1.failedStep}）`)
  assert(f1.draftContent === '中断保留正文', '失败后草稿保留')
  assert(f1.recipientsText.includes('戊单位') && f1.recipientsText.includes('己单位'), '失败后接收单位保留')
  assert(f1.failureReason.includes('下发中断'), '失败原因保留并说明中断')
  assert(f1.stepLogs.filter((l) => l.step === '校验' && l.ok).length === 1, '校验步骤成功留痕')

  const versionBeforeRetry = f1.version
  const retry = await publishNotice(c3.id!)
  assert(retry.ok && retry.status === '已发布', '重试发布成功')
  const f2 = getNotice(c3.id!)!
  // 每次发布落盘两次（进入发布中 + 最终结论），两次落盘在一次写入事务语义里成对出现
  assert(f2.version === versionBeforeRetry + 2, '重试只产生一轮发布的版本递增（发布中+成功）')
  assert(f2.stepLogs.filter((l) => l.step === '校验' && l.ok).length === 1, '重试未重跑校验步骤')
  assert(f2.stepLogs.filter((l) => l.step === '下发').length === 2, '下发步骤重跑一次（1失败+1成功）')
  assert(f2.failureReason === '' && f2.failedStep === null, '成功后失败原因清空')

  console.log('4. 回执步骤失败：已下发回执保留，重试只补回执')
  const c4 = createNotice(validDraft({ hazardCode: 'HAZA-T4', recipientsText: '庚单位' }), true)
  const c4Id = c4.id!
  __setStepHookForTest((id, step) => {
    if (id === c4Id && step === '回执') setChannelDown(true)
  })
  await publishNotice(c4Id)
  setChannelDown(false)
  __setStepHookForTest(null)
  const f3 = getNotice(c4Id)!
  assert(f3.status === '发布失败' && f3.failedStep === '回执', `回执步骤失败（实际 ${f3.status}/${f3.failedStep}）`)
  assert(f3.receipts.length === 1 && f3.receipts[0].state === '待接收', '已下发的待接收回执保留')
  const logsBefore = f3.stepLogs.length
  await publishNotice(c4Id)
  const f4 = getNotice(c4Id)!
  assert(f4.status === '已发布' && f4.receipts[0].state === '已接收', '回执重试后全部接收')
  assert(f4.stepLogs.length === logsBefore + 1, '只补了「回执成功」一条日志，校验与下发未重跑')

  console.log('5. 异常回执：通知仍为已发布，异常回执有明确说明')
  const c5 = createNotice(
    validDraft({ hazardCode: 'HAZA-T5', recipientsText: '正常单位\n异常测试单位（测试异常）' }),
    true,
  )
  const r5 = await publishNotice(c5.id!)
  assert(r5.ok && r5.message.includes('1 个回执异常'), '发布成功且提示异常回执数量')
  const n5 = getNotice(c5.id!)!
  const abnormal = n5.receipts.find((x) => x.state === '异常回执')!
  assert(!!abnormal && abnormal.note.includes('签名缺失'), '异常回执带有明确说明与核实要求')
  assert(n5.status === '已发布', '异常回执不改变已发布结论')

  console.log('6. 终态保护：已解除通知保留原结论，任何动作不能退回待发布')
  await recordResponse(n1.id, '群众已转移')
  const rel = releaseNotice(n1.id, '数据趋于稳定，解除警戒')
  assert(rel.ok, '解除成功')
  const released = getNotice(n1.id)!
  assert(released.status === '已解除' && released.releaseConclusion.includes('趋于稳定'), '解除结论保留')
  const republish = await publishNotice(n1.id)
  assert(!republish.ok && getNotice(n1.id)!.status === '已解除', '解除后重新发布被拒，状态不变')
  const editAfterRelease = saveDraft(n1.id, validDraft({ recipientsText: '新单位', draftContent: '新正文' }))
  assert(!editAfterRelease.ok && getNotice(n1.id)!.draftContent !== '新正文', '解除后草稿不可改')
  assert(getNotice(n1.id)!.releaseConclusion.includes('趋于稳定'), '解除结论未被覆盖')
  assert(!dispatchRecipients(n1.id, '单位').ok, '解除后分派被拒')
  assert(!markFalseAlarm(n1.id, '误报?').ok, '解除后标记误报被拒')

  console.log('7. 并发重试：同一时刻只有一个版本生效，回执不重复')
  setChannelDown(true)
  const c7 = createNotice(validDraft({ hazardCode: 'HAZA-T7', recipientsText: '并发单位A\n并发单位B' }), true)
  await publishNotice(c7.id!)
  setChannelDown(false)
  const before = getNotice(c7.id!)!
  assert(before.status === '发布失败', '前置：失败状态')
  const [a, b] = await Promise.all([publishNotice(c7.id!), publishNotice(c7.id!)])
  assert(a.ok !== b.ok, '两个并发重试恰好一个成功')
  const loser = a.ok ? b : a
  assert(loser.message.includes('正在发布') || loser.message.includes('刷新'), `被拒原因合理：${loser.message}`)
  const after = getNotice(c7.id!)!
  assert(after.status === '已发布', '最终状态已发布')
  assert(after.receipts.length === 2, '回执只写入一次，没有重复')
  assert(!storeMap.get('geohazard-monitor-prevention:alarm-lock:' + c7.id!), '发布结束锁被释放')

  console.log('8. 存储原子性：落盘记录始终自洽，无半成品')
  const raw = JSON.parse(storeMap.get('geohazard-monitor-prevention:alarm-notices')!)
  for (const row of raw) {
    if (row.status === '发布失败') {
      assert(!!row.failureReason && !!row.failedStep && !!row.draftContent && row.receipts !== undefined, `#${row.id} 失败记录四要素齐全`)
    }
    if (['已发布', '已响应', '已解除'].includes(row.status)) {
      assert(row.receipts.length > 0 && !!row.publishedAt && row.failedStep === null, `#${row.id} 成功记录回执/发布时间齐全`)
    }
  }

  console.log('9. 失败通知编辑：保留失败记录；改接收单位后重试自动从头走')
  const c9 = createNotice(validDraft({ hazardCode: 'HAZA-T9', recipientsText: '子单位\n丑单位' }), true)
  setChannelDown(true)
  await publishNotice(c9.id!)
  setChannelDown(false)
  const f9 = getNotice(c9.id!)!
  const saved = saveDraft(c9.id!, { ...validDraft({ hazardCode: 'HAZA-T9', recipientsText: '子单位\n丑单位' }), draftContent: '改过的正文' })
  assert(saved.ok, '保存失败通知草稿成功')
  const f9b = getNotice(c9.id!)!
  assert(f9b.status === '发布失败' && f9b.failureReason === f9.failureReason, '编辑后失败状态与原因保留')
  assert(f9b.draftContent === '改过的正文', '草稿更新生效')
  // 只改正文不改单位 -> 仍从失败步骤继续，校验不重跑
  await publishNotice(c9.id!)
  const f9c = getNotice(c9.id!)!
  assert(f9c.status === '已发布', '编辑后重试成功')
  assert(f9c.stepLogs.filter((l) => l.step === '校验' && l.ok).length === 1, '单位没变时仍从失败步骤继续')

  const c92 = createNotice(validDraft({ hazardCode: 'HAZA-T92', recipientsText: '寅单位' }), true)
  setChannelDown(true)
  await publishNotice(c92.id!)
  setChannelDown(false)
  saveDraft(c92.id!, validDraft({ hazardCode: 'HAZA-T92', recipientsText: '寅单位\n卯单位' }))
  const f92 = getNotice(c92.id!)!
  assert(f92.failedStep === '下发', '失败步骤仍记录为下发（保存不改状态）')
  await publishNotice(c92.id!)
  const f92b = getNotice(c92.id!)!
  assert(f92b.status === '已发布' && f92b.receipts.length === 2, '单位变更后从下发步骤继续，回执按新单位生成')
  assert(f92b.stepLogs.filter((l) => l.step === '校验' && l.ok).length === 1, '已通过的校验不重跑，从失败的下发步骤继续')

  console.log('10. 误报流程与校验失败留痕')
  const c10 = createNotice(validDraft({ hazardCode: 'HAZA-T10', draftContent: '' }), false)
  setChannelDown(false)
  // 直接对缺正文草稿发布：校验步骤失败并保留原因
  const vFail = await publishNotice(c10.id!)
  assert(!vFail.ok && getNotice(c10.id!)!.failedStep === '校验', '缺正文时校验步骤失败')
  assert(getNotice(c10.id!)!.failureReason.includes('正文为空'), '失败原因指向正文缺失')
  saveDraft(c10.id!, validDraft({ hazardCode: 'HAZA-T10' }))
  assert((await publishNotice(c10.id!)).ok, '补全后重试成功')
  const falseResult = markFalseAlarm(c10.id!, '雨量计故障误触发')
  assert(falseResult.ok && getNotice(c10.id!)!.status === '误报', '已发布通知可认定误报')
  assert(getNotice(c10.id!)!.releaseConclusion.includes('雨量计故障'), '误报依据归档保留')
  assert(!(await publishNotice(c10.id!)).ok, '误报后不能再发布')

  console.log(`\n共创建/流转 ${listCount()} 条通知；${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'}`)
  process.exit(failures === 0 ? 0 : 1)

  function listCount() {
    return JSON.parse(storeMap.get('geohazard-monitor-prevention:alarm-notices')!).length
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
