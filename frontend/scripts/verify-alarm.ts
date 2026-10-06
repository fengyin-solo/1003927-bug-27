/**
 * 预警通知发布链路核验脚本：直接打包并运行 src/api/alarm-service.ts 的真实代码。
 * 运行：node scripts/verify-alarm.run.mjs（由 package.json 的 verify:alarm 用 esbuild 即时打包）
 */
import assert from 'node:assert/strict'

import {
  assignUnits,
  getAlarm,
  isPublishing,
  listAlarms,
  releaseAlarm,
  resetAlarms,
  saveDraft,
  startPublish,
} from '../src/api/alarm-service.ts'
import { storageKey } from '../src/data/local-store.ts'

let passed = 0
async function test(name, fn) {
  resetAlarms()
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${err.message}`)
    process.exitCode = 1
  }
}

function rawStorage() {
  return JSON.parse(globalThis.window.localStorage.getItem(storageKey()))
}

async function main() {
  // Node 环境桩：localStorage 内存实现 + window.setTimeout。
  const memory = new Map()
  const storageStub = {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => {
      memory.set(k, String(v))
    },
    removeItem: (k) => memory.delete(k),
  }
  globalThis.window = globalThis.window ?? {
    localStorage: storageStub,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearInterval,
  }
  // local-store 模块缓存要在桩就位后首次读取。
  resetAlarms()

  console.log('1) 失败必须保留原草稿、接收单位与失败原因')
  await test('校验环节中断：草稿原文、接收单位原样保留，失败原因落库', async () => {
    const before = getAlarm(8)
    const result = await startPublish({
      id: 8,
      expectedVersion: before.version,
      faultInjections: [{ step: '校验通知内容', triggerAttempt: 3, kind: 'interrupt', reason: '审批服务暂不可用（连接被拒绝），发布单未签发' }],
    })
    assert.equal(result.ok, false)
    const after = getAlarm(8)
    assert.equal(after.status, '发布失败')
    assert.equal(after.failure.failedStep, '校验通知内容')
    assert.match(after.failure.reason, /审批服务暂不可用/)
    assert.equal(after.failure.attemptsAtStep, 3)
    // 原草稿一字未丢
    assert.equal(after.通知编号, before.通知编号)
    assert.equal(after.触发条件, before.触发条件)
    assert.equal(after.发布人, before.发布人)
    assert.deepEqual(after.units, before.units)
    assert.equal(after.receipts.length, 0)
    // 持久层里也是完整失败版本，不是半截数据
    const stored = rawStorage().alarm.find((r) => r.id === 8)
    assert.equal(stored.status, '发布失败')
    assert.equal(stored.units.length, 3)
    assert.ok(stored.failure && stored.failure.reason)
  })

  console.log('2) 重试从失败步骤继续，已完成步骤不重复执行')
  await test('推送环节两次中断后续跑：校验只执行 1 次，推送逐单位断点续传', async () => {
    // 第一次重试：大坡村委会已送达 → 推镇应急办成功 → 派派出所中断
    let r = await startPublish({
      id: 2,
      faultInjections: [{ step: '推送接收单位', triggerAttempt: 2, kind: 'interrupt', reason: '推送至「派出所」时通讯链路中断' }],
    })
    assert.equal(r.ok, false)
    let n = getAlarm(2)
    assert.equal(n.stepAttempts['校验通知内容'], 1, '校验步骤不应重复执行')
    assert.equal(n.stepAttempts['推送接收单位'], 2)
    assert.deepEqual(n.receipts.map((x) => x.unit), ['大坡村委会', '镇应急办'])
    assert.equal(n.units.length, 4, '接收单位清单不能被清空')
    assert.equal(n.failure.failedStep, '推送接收单位')

    // 第二次重试：再推派出所成功 → 卫生院中断
    r = await startPublish({
      id: 2,
      faultInjections: [{ step: '推送接收单位', triggerAttempt: 3, kind: 'interrupt', reason: '推送至「卫生院」时通讯链路中断' }],
    })
    assert.equal(r.ok, false)
    n = getAlarm(2)
    assert.equal(n.stepAttempts['校验通知内容'], 1)
    assert.equal(n.stepAttempts['推送接收单位'], 3)
    assert.deepEqual(n.receipts.map((x) => x.unit), ['大坡村委会', '镇应急办', '派出所'])

    // 第三次重试：无故障，直接走完推送+收集回执
    r = await startPublish({ id: 2 })
    assert.equal(r.ok, true, r.message)
    n = getAlarm(2)
    assert.equal(n.status, '已发布')
    assert.equal(n.stepAttempts['校验通知内容'], 1, '全程校验只执行 1 次')
    assert.equal(n.stepAttempts['推送接收单位'], 4)
    assert.equal(n.stepAttempts['收集回执'], 1)
    assert.ok(n.stepResults['收集回执'].status === 'done')
    assert.equal(n.receipts.length, 4)
    assert.ok(n.receipts.every((x) => x.state === '已确认'))
    assert.ok(n.publishTime)
    assert.equal(n.failure, null)
  })

  console.log('3) 空接收单位进入待分派，而不是直接报错')
  await test('新建空单位草稿→待分派；发起发布只转待分派不清数据；补登后可发布', async () => {
    const saved = saveDraft({
      通知编号: 'ALAR-T-EMPTY',
      隐患点编号: 'HAZA-T-1',
      预警等级: '黄色预警',
      触发条件: '测试空接收单位',
      发布人: '测试员',
      units: [],
    })
    assert.equal(saved.ok, true)
    const id = saved.notice.id
    assert.equal(getAlarm(id).status, '待分派')

    const publishAttempt = await startPublish({ id })
    assert.equal(publishAttempt.ok, false)
    assert.match(publishAttempt.message, /待分派/)
    const still = getAlarm(id)
    assert.equal(still.status, '待分派')
    assert.deepEqual(still.units, [])
    assert.equal(still.触发条件, '测试空接收单位', '草稿必须还在')

    const assigned = assignUnits(id, ['甲方单位', '乙方单位'])
    assert.equal(assigned.ok, true)
    assert.equal(getAlarm(id).status, '待发布')
    const done = await startPublish({ id })
    assert.equal(done.ok, true, done.message)
    assert.equal(getAlarm(id).status, '已发布')
  })

  console.log('4) 历史已解除/误报通知保留原结论，读取路径不回退待发布')
  await test('已解除通知：结论只读、再发布/解除/响应全部拒绝、版本不变', async () => {
    const before = getAlarm(6)
    assert.equal(before.status, '已解除')
    assert.ok(before.releaseConclusion.includes('会商解除'))
    assert.ok(before.releasedAt && before.releaseOperator)

    const republish = await startPublish({ id: 6 })
    assert.equal(republish.ok, false)
    assert.match(republish.message, /结案/)
    assert.equal(releaseAlarm(6, '再解一次', 'x').ok, false)
    const listView = listAlarms({ 通知编号: 'ALAR-2026-006' }).items[0]
    assert.equal(listView.status, '已解除')
    assert.equal(listView.releaseConclusion, before.releaseConclusion)
    const after = getAlarm(6)
    assert.equal(after.version, before.version, '被拒绝的动作不得产生新版本')
    assert.equal(after.status, '已解除')
  })

  await test('误报通知同样结案，不能再次发布', async () => {
    const r = await startPublish({ id: 7 })
    assert.equal(r.ok, false)
    assert.equal(getAlarm(7).status, '误报')
    assert.ok(getAlarm(7).falseAlarmReason.includes('电池电压抖动'))
  })

  console.log('5) 并发重试同一通知只允许一个版本生效')
  await test('两个发布同时发起：后到者冲突，回执不重复、只有一条成功链路', async () => {
    const first = startPublish({ id: 1 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = startPublish({ id: 1 })
    const [r1, r2] = await Promise.all([first, second])
    assert.equal(r1.ok, true, r1.message)
    assert.equal(r2.ok, false)
    assert.equal(r2.conflict, true)
    assert.match(r2.message, /已有一个发布流程/)
    const n = getAlarm(1)
    assert.equal(n.status, '已发布')
    assert.equal(n.receipts.length, 3, '并发不能导致重复回执')
    assert.deepEqual([...new Set(n.receipts.map((x) => x.unit))].length, 3)
    assert.equal(isPublishing(1), false)
  })

  console.log('6) 成功与失败数据不能只写一半')
  await test('推送中途失败：已送达回执逐单位保留，未推单位无回执，状态明确为发布失败', async () => {
    const saved = saveDraft({
      通知编号: 'ALAR-T-HALF',
      隐患点编号: 'HAZA-T-2',
      预警等级: '橙色预警',
      触发条件: '测试半写防护',
      发布人: '测试员',
      units: ['单位甲', '单位乙', '单位丙'],
    })
    const id = saved.notice.id
    const failed = await startPublish({
      id,
      faultInjections: [{ step: '推送接收单位', triggerAttempt: 1, kind: 'interrupt', reason: '推送至「单位乙」时链路中断' }],
    })
    assert.equal(failed.ok, false)
    let n = getAlarm(id)
    assert.equal(n.status, '发布失败')
    assert.deepEqual(n.receipts.map((x) => x.unit), ['单位甲'])
    assert.equal(n.stepResults['校验通知内容'].status, 'done')
    assert.equal(n.stepResults['推送接收单位'], undefined)
    assert.equal(n.stepResults['收集回执'], undefined)
    assert.ok(n.failure.reason.includes('单位乙'))
    // 落库版本自洽
    const stored = rawStorage().alarm.find((r) => r.id === id)
    assert.equal(stored.receipts.length, 1)
    assert.equal(stored.failure.failedStep, '推送接收单位')

    const retry = await startPublish({ id })
    assert.equal(retry.ok, true, retry.message)
    n = getAlarm(id)
    assert.equal(n.status, '已发布')
    assert.equal(n.receipts.length, 3)
    assert.ok(n.receipts.every((x) => x.state === '已确认' && x.acknowledgedAt))
  })

  console.log('7) 异常回执必须带说明，读取路径可见')
  await test('回执异常：发布仍完成，异常原因随回执持久化并可在列表/详情读到', async () => {
    const saved = saveDraft({
      通知编号: 'ALAR-T-RECEIPT',
      隐患点编号: 'HAZA-T-3',
      预警等级: '红色预警',
      触发条件: '测试异常回执',
      发布人: '测试员',
      units: ['正常单位', '异常单位'],
    })
    const id = saved.notice.id
    const r = await startPublish({
      id,
      faultInjections: [{ step: '收集回执', triggerAttempt: 1, kind: 'abnormal-receipt', reason: '异常单位：回执报文格式错误（缺少签收人字段）' }],
    })
    assert.equal(r.ok, true)
    assert.match(r.message, /回执异常/)
    const n = getAlarm(id)
    assert.equal(n.status, '已发布')
    const bad = n.receipts.find((x) => x.unit === '异常单位')
    assert.equal(bad.state, '回执异常')
    assert.match(bad.abnormalReason, /缺少签收人字段/)
    assert.equal(n.abnormal, true)
    const row = listAlarms().items.find((x) => x.id === id)
    assert.ok(row.receipts.some((x) => x.state === '回执异常' && x.abnormalReason))
  })

  console.log('8) 乐观锁：过期版本的重试/解除不得覆盖新数据')
  await test('携带旧版本号的解除请求被拒绝，新版本数据不动', async () => {
    const stale = getAlarm(5) // 已响应
    // 模拟并发：另一路先把版本推进
    const bumped = releaseAlarm(5, '第一路解除结论', '值班管理员', stale.version)
    assert.equal(bumped.ok, true)
    const late = releaseAlarm(5, '第二路想覆盖结论', '其他人', stale.version)
    assert.equal(late.ok, false)
    assert.equal(late.conflict, true)
    assert.equal(getAlarm(5).releaseConclusion, '第一路解除结论')
  })

  console.log(`\n通过 ${passed} 项核验`)
}

main()
