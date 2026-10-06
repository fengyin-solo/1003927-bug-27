/* eslint-disable */
// 旧通用台账 alarm 数据迁移、跨标签页版本冲突冒烟测试
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

let failures = 0
function assert(cond: boolean, message: string) {
  if (cond) {
    console.log(`  ✓ ${message}`)
  } else {
    failures += 1
    console.error(`  ✗ ${message}`)
  }
}

async function main() {
  console.log('A. 旧版通用台账 alarm 数据迁移')
  const legacyRows = [
    // 已解除：历史结论必须保留为已解除，不能退回待发布
    {
      id: 1,
      status: '已解除',
      pending: false,
      abnormal: false,
      通知编号: 'ALAR-0001',
      隐患点编号: 'ALAR-0001',
      预警等级: '警戒级',
      触发条件: '旧触发1',
      发布时间: '2026-09-01',
      接收单位: '甲村、乙所',
      发布人: '旧发布人',
      通知状态: '已解除',
    },
    // 已发布 + abnormal 标记：只残留错误标记 -> 迁移成带说明的异常回执，状态保留已发布
    {
      id: 2,
      status: '已发布',
      pending: true,
      abnormal: true,
      通知编号: 'ALAR-0002',
      隐患点编号: 'ALAR-0002',
      预警等级: '警示级',
      触发条件: '旧触发2',
      发布时间: '2026-09-02',
      接收单位: '丙单位',
      发布人: '旧发布人2',
      通知状态: '已发布',
    },
    // 待发布：原样保留可继续发布
    {
      id: 3,
      status: '待发布',
      pending: true,
      abnormal: false,
      通知编号: 'ALAR-0003',
      隐患点编号: 'ALAR-0003',
      预警等级: '注意级',
      触发条件: '旧触发3',
      发布时间: '',
      接收单位: '',
      发布人: '旧发布人3',
      通知状态: '待发布',
    },
  ]
  storeMap.set(
    'geohazard-monitor-prevention:entries',
    JSON.stringify({ hazard: [{ id: 1, status: '在册', pending: true, abnormal: false }], alarm: legacyRows }),
  )

  const store = await import('../frontend/src/data/alarm/store')
  const list = store.listNotices()
  assert(list.length === 3, `迁移出 3 条通知（实际 ${list.length}）`)
  const released = list.find((n) => n.code === 'ALAR-0001')!
  assert(released.status === '已解除', '已解除通知迁移后仍是已解除')
  assert(released.releaseConclusion.includes('迁移'), '解除结论有迁移说明并永久保留')
  assert(!(await store.publishNotice(released.id)).ok, '迁移来的已解除通知仍受终态保护')

  const publishedAbnormal = list.find((n) => n.code === 'ALAR-0002')!
  assert(publishedAbnormal.status === '已发布', '异常通知迁移后仍为已发布，不退回待发布')
  assert(publishedAbnormal.receipts.length === 1, '按接收单位补建回执')
  assert(
    publishedAbnormal.receipts[0].state === '异常回执' && publishedAbnormal.receipts[0].note.includes('未登记回执说明'),
    '旧的错误标记补登成带说明的异常回执',
  )

  const waiting = list.find((n) => n.code === 'ALAR-0003')!
  assert(waiting.status === '待发布' && waiting.recipientsText === '', '待发布通知保留')
  const diverted = await store.publishNotice(waiting.id)
  assert(diverted.diverted && store.getNotice(waiting.id)!.status === '待分派', '迁移通知接收单位为空时进入待分派')

  // 旧库中 alarm 已摘除，hazard 不受影响
  const legacyAfter = JSON.parse(storeMap.get('geohazard-monitor-prevention:entries')!)
  assert(legacyAfter.alarm === undefined && Array.isArray(legacyAfter.hazard), '旧库 alarm 摘除、其他模块保留')

  console.log('B. 跨标签页版本冲突（模拟陈旧写入）')
  const fresh = store.createNotice(
    {
      hazardCode: 'HAZA-B1',
      level: '注意级',
      triggerCondition: 'CAS 测试',
      publisher: '测试人',
      recipientsText: '单位一',
      draftContent: 'CAS 正文',
    },
    true,
  )
  const snapshot = store.getNotice(fresh.id!)!
  // 模拟标签页B先提交了一次（version + 1）
  store.saveDraft(fresh.id!, {
    hazardCode: 'HAZA-B1',
    level: '注意级',
    triggerCondition: 'CAS 测试',
    publisher: '测试人',
    recipientsText: '单位一',
    draftContent: 'B 标签页的修改',
  })
  // 标签页A拿着旧版本提交：必须被拒，不能覆盖 B
  const stale = store.saveDraft(
    fresh.id!,
    {
      hazardCode: 'HAZA-B1',
      level: '警戒级',
      triggerCondition: 'CAS 测试',
      publisher: '测试人',
      recipientsText: '单位一',
      draftContent: 'A 标签页的陈旧修改',
    },
    snapshot.version,
  )
  assert(!stale.ok && stale.message.includes('过期'), '陈旧版本提交被 CAS 拒绝')
  const winner = store.getNotice(fresh.id!)!
  assert(winner.draftContent === 'B 标签页的修改' && winner.level === '注意级', '先生效的 B 版本保留，A 未覆盖')

  console.log('C. 发布通道开关持久化与读取')
  store.setChannelDown(true)
  assert(storeMap.get('geohazard-monitor-prevention:alarm-channel') === 'off', '通道中断状态持久化')
  const c = store.createNotice(
    {
      hazardCode: 'HAZA-C1',
      level: '注意级',
      triggerCondition: '通道',
      publisher: '测试人',
      recipientsText: '通道单位',
      draftContent: '通道正文',
    },
    true,
  )
  const downResult = await store.publishNotice(c.id!)
  assert(downResult.status === '发布失败', '通道关闭时发布失败')
  store.setChannelDown(false)

  console.log(`\n${failures === 0 ? '迁移/并发补充测试全部通过 ✅' : failures + ' 项失败 ❌'}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
