import { ALARM_SEED } from '@/data/alarm-seed'
import {
  PUBLISH_STEPS,
  type AlarmActionResult,
  type AlarmDraftInput,
  type AlarmListResult,
  type AlarmNotice,
  type AlarmStatus,
  type FaultInjection,
  type PublishStep,
  type Receipt,
  isPublishable,
  isTerminal,
} from '@/data/alarm-types'
import { loadCollection, saveCollection } from '@/data/local-store'

const STORE_KEY = 'alarm'

// 发布流水线每步耗时（仅用于把并发重试的竞争窗口显式化，数据仍按步骤原子落库）。
const STEP_DURATION_MS = 300

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

function timestamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function deriveFlags(status: AlarmStatus, notice: Pick<AlarmNotice, 'receipts' | 'failure'>) {
  return {
    // 未结案都算待处理（含发布失败、待分派、已发布待响应）。
    pending: !isTerminal(status),
    // 发布失败现场，或在途通知存在异常回执；结案后异常已随结论归档，不再计异常。
    abnormal: status === '发布失败' || (!isTerminal(status) && notice.receipts.some((r) => r.state === '回执异常')),
  }
}

function withFlags(notice: AlarmNotice): AlarmNotice {
  const flags = deriveFlags(notice.status, notice)
  return { ...notice, pending: flags.pending, abnormal: flags.abnormal }
}

// 旧骨架的通用 alarm 记录没有 units/receipts/version，首次读取时迁移成正式播种数据。
function isLegacy(row: unknown): row is Record<string, unknown> {
  if (typeof row !== 'object' || row === null) {
    return true
  }
  const record = row as Record<string, unknown>
  return !Array.isArray(record.units) || !Array.isArray(record.receipts) || typeof record.version !== 'number'
}

function loadAll(): AlarmNotice[] {
  const rows = loadCollection<AlarmNotice>(STORE_KEY, ALARM_SEED)
  if (rows.some(isLegacy)) {
    const seeded = ALARM_SEED.map((item) => ({ ...item }))
    saveCollection(STORE_KEY, seeded)
    return seeded
  }
  return rows.map(withFlags)
}

function commitAll(rows: AlarmNotice[]): AlarmNotice[] {
  // 统一在这里加派生标记，调用方不用关心。
  const normalized = rows.map(withFlags)
  saveCollection(STORE_KEY, normalized)
  return normalized.map((item) => ({ ...item }))
}

// 以版本号做乐观锁：只有 expectedVersion 仍是库里最新版本时，变更才生效。
function commitOne(next: AlarmNotice, expectedVersion: number): { rows: AlarmNotice[]; current: AlarmNotice | null } {
  const rows = loadAll()
  const index = rows.findIndex((row) => row.id === next.id)
  if (index < 0) {
    return { rows, current: null }
  }
  if (rows[index].version !== expectedVersion) {
    return { rows, current: rows[index] }
  }
  const stamped: AlarmNotice = { ...next, version: next.version + 1, updatedAt: timestamp() }
  const merged = [...rows]
  merged[index] = stamped
  return { rows: commitAll(merged), current: stamped }
}

// 同一通知同一时刻只允许一个发布流程在跑：后到的重试直接返回冲突，不覆盖前一个版本。
const inflight = new Map<number, string>()

export function listAlarms(filters: Record<string, string> = {}): AlarmListResult {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  const items = loadAll()
    .filter((row) =>
      pairs.every(([field, value]) => {
        if (field === '接收单位') {
          return row.units.some((unit) => unit.includes(value.trim()))
        }
        const source = field === '通知状态' ? row.status : String(row[field as keyof AlarmNotice] ?? '')
        return String(source).includes(value.trim())
      }),
    )
    .map((item) => ({ ...item }))
  return { items, total: items.length }
}

export function getAlarm(id: number): AlarmNotice | null {
  const found = loadAll().find((row) => row.id === id)
  return found ? { ...found } : null
}

export function nextAlarmId(): number {
  return loadAll().reduce((max, row) => Math.max(max, row.id), 0) + 1
}

export function saveDraft(input: AlarmDraftInput & { id?: number }): AlarmActionResult {
  const codeError = validateDraft(input)
  if (codeError) {
    return { ok: false, message: codeError }
  }
  const rows = loadAll()
  const id = input.id ?? nextAlarmId()

  if (input.id === undefined) {
    const duplicated = rows.some((row) => row.通知编号 === input.通知编号.trim())
    if (duplicated) {
      return { ok: false, message: `通知编号「${input.通知编号.trim()}」已存在` }
    }
    const base: AlarmNotice = {
      id,
      通知编号: input.通知编号.trim(),
      隐患点编号: input.隐患点编号.trim(),
      预警等级: input.预警等级.trim(),
      触发条件: input.触发条件.trim(),
      发布人: input.发布人.trim(),
      units: input.units,
      receipts: [],
      // 空接收单位不报错：进入待分派，而不是退回错误。
      status: input.units.length === 0 ? '待分派' : '待发布',
      publishTime: null,
      respondedAt: null,
      releasedAt: null,
      releaseConclusion: null,
      releaseOperator: null,
      falseAlarmReason: null,
      failedStep: null,
      failure: null,
      stepResults: {},
      stepAttempts: { 校验通知内容: 0, 推送接收单位: 0, 收集回执: 0 },
      faultInjections: [],
      version: 1,
      createdAt: timestamp(),
      updatedAt: timestamp(),
      pending: true,
      abnormal: false,
    }
    const saved = commitAll([...rows, base]).find((row) => row.id === id)
    return { ok: true, message: saved!.status === '待分派' ? '草稿已保存：接收单位为空，已进入待分派' : '草稿已保存，当前待发布', notice: saved }
  }

  const index = rows.findIndex((row) => row.id === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的预警通知` }
  }
  const current = rows[index]
  if (isTerminal(current.status)) {
    return { ok: false, message: '通知已结案（已解除/误报），历史结论不可修改' }
  }
  if (current.status === '已发布' || current.status === '已响应') {
    return { ok: false, message: '通知已发布，草稿内容不允许修改' }
  }
  const duplicated = rows.some((row) => row.id !== id && row.通知编号 === input.通知编号.trim())
  if (duplicated) {
    return { ok: false, message: `通知编号「${input.通知编号.trim()}」已存在` }
  }
  const next: AlarmNotice = {
    ...current,
    通知编号: input.通知编号.trim(),
    隐患点编号: input.隐患点编号.trim(),
    预警等级: input.预警等级.trim(),
    触发条件: input.触发条件.trim(),
    发布人: input.发布人.trim(),
    units: input.units,
    // 失败草稿改空接收单位：转入待分派并清失败现场（草稿原文仍在）；保留单位则维持发布失败等待重试。
    status: input.units.length === 0 ? '待分派' : current.failure ? current.status : '待发布',
    failedStep: input.units.length === 0 ? null : current.failedStep,
    failure: input.units.length === 0 ? null : current.failure,
  }
  const { rows: written, current: saved } = commitOne(next, current.version)
  if (!saved) {
    return { ok: false, message: '保存失败：通知可能已被其他操作更新，请刷新后重试', conflict: true }
  }
  void written
  return { ok: true, message: '草稿已更新', notice: { ...saved } }
}

// 给待分派通知补登接收单位：补齐后回到待发布，可直接发起发布。
export function assignUnits(id: number, units: string[], expectedVersion?: number): AlarmActionResult {
  const cleaned = units.map((u) => u.trim()).filter(Boolean)
  if (cleaned.length === 0) {
    return { ok: false, message: '至少分派一个接收单位，否则保持待分派' }
  }
  const rows = loadAll()
  const index = rows.findIndex((row) => row.id === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的预警通知` }
  }
  const current = rows[index]
  if (expectedVersion !== undefined && current.version !== expectedVersion) {
    return { ok: false, message: '分派失败：通知已被其他操作更新，请刷新后重试', conflict: true, notice: { ...current } }
  }
  if (current.status !== '待分派') {
    return { ok: false, message: `当前状态为「${current.status}」，只有待分派通知需要补登接收单位` }
  }
  const next: AlarmNotice = {
    ...current,
    units: Array.from(new Set([...current.units, ...cleaned])),
    status: '待发布',
  }
  const { current: saved } = commitOne(next, current.version)
  if (!saved) {
    return { ok: false, message: '分派失败：版本冲突，请刷新后重试', conflict: true }
  }
  return { ok: true, message: `已分派 ${cleaned.length} 个接收单位，通知进入待发布`, notice: { ...saved } }
}

// 发布前的纯内容校验；接收单位为空不算内容错误，单独走待分派。
function validateDraft(input: Pick<AlarmDraftInput, '通知编号' | '隐患点编号' | '预警等级' | '触发条件' | '发布人'>): string | null {
  if (!input.通知编号.trim()) return '通知编号不能为空'
  if (!input.隐患点编号.trim()) return '隐患点编号不能为空'
  if (!input.预警等级.trim()) return '预警等级不能为空'
  if (!input.触发条件.trim()) return '触发条件不能为空'
  if (!input.发布人.trim()) return '发布人不能为空'
  return null
}

function pickFault(faults: FaultInjection[], step: PublishStep, attempt: number): FaultInjection | null {
  return faults.find((f) => f.step === step && f.triggerAttempt === attempt) ?? null
}

function remainingFaults(faults: FaultInjection[], fired: FaultInjection | null): FaultInjection[] {
  if (!fired) {
    return faults
  }
  const index = faults.findIndex((f) => f === fired)
  return faults.filter((_, i) => i !== index)
}

/**
 * 发起发布或断点续跑：
 * - 只允许在 待发布/发布失败/待分派 上执行；结案态一律拒绝（历史结论保留）。
 * - 失败时原草稿（含接收单位清单、已完成步骤回执）与失败原因整版本保留，状态=发布失败。
 * - 重试从 failedStep 继续，已完成步骤不重复执行。
 * - 每一步成功都立即原子落库；成功与失败数据各为一个完整版本，不存在只写一半。
 * - 同一通知并发重试：先到的持有执行锁，后到的直接收到 conflict，只有一个版本生效。
 */
export async function startPublish(opts: {
  id: number
  expectedVersion?: number
  faultInjections?: FaultInjection[]
  onStep?: (notice: AlarmNotice) => void
}): Promise<AlarmActionResult> {
  const id = opts.id
  const lockToken = `publish-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  if (inflight.has(id)) {
    const current = getAlarm(id)
    return {
      ok: false,
      conflict: true,
      message: '该通知已有一个发布流程在执行，请等待其结束后再重试（并发发布只允许一个版本生效）',
      notice: current ?? undefined,
    }
  }

  let entry = getAlarm(id)
  if (!entry) {
    return { ok: false, message: `没有找到编号为 ${id} 的预警通知` }
  }
  if (opts.expectedVersion !== undefined && entry.version !== opts.expectedVersion) {
    return {
      ok: false,
      conflict: true,
      message: `版本已过期（当前版本 v${entry.version}），你看到的重试依据已失效，请刷新后重试`,
      notice: { ...entry },
    }
  }
  if (isTerminal(entry.status)) {
    return { ok: false, message: `通知已结案（${entry.status}），历史结论保留，不能再次发布`, notice: { ...entry } }
  }
  if (entry.status === '已发布' || entry.status === '已响应') {
    return { ok: false, message: '通知已发布成功，无需重复发布', notice: { ...entry } }
  }
  // 空接收单位：不抛错、不清数据，直接落为待分派。
  if (entry.units.length === 0) {
    const redirected: AlarmNotice = { ...entry, status: '待分派', failedStep: null, failure: null }
    const { current: saved } = commitOne(redirected, entry.version)
    return saved
      ? { ok: false, message: '接收单位为空，通知进入待分派；补登接收单位后再发布', notice: { ...saved } }
      : { ok: false, conflict: true, message: '状态更新冲突，请刷新后重试' }
  }

  inflight.set(id, lockToken)
  try {
    let base: AlarmNotice = entry
    if (opts.faultInjections && opts.faultInjections.length > 0) {
      base = { ...base, faultInjections: opts.faultInjections }
    }

    // 续跑起点：优先从失败步骤继续；没有失败现场时（例如刷新中途页面），从第一个未完成步骤继续。
    const resumeIndex = base.failedStep
      ? PUBLISH_STEPS.indexOf(base.failedStep)
      : PUBLISH_STEPS.findIndex((step) => base.stepResults[step]?.status !== 'done')
    const startIndex = Math.max(0, resumeIndex === -1 ? 0 : resumeIndex)
    const stepAttempts: Record<PublishStep, number> = {
      校验通知内容: base.stepAttempts.校验通知内容,
      推送接收单位: base.stepAttempts.推送接收单位,
      收集回执: base.stepAttempts.收集回执,
    }
    const stepResults = { ...base.stepResults }
    const units = [...base.units]
    let receipts: Receipt[] = base.receipts.map((r) => ({ ...r }))
    let working: AlarmNotice = { ...base }
    let pendingFaults = [...base.faultInjections]
    // 首次真正产生推送的时刻作为发布时间；重试不再覆盖。
    let publishTime = base.publishTime

    for (let i = startIndex; i < PUBLISH_STEPS.length; i += 1) {
      const step = PUBLISH_STEPS[i]
      stepAttempts[step] += 1
      const attempt = stepAttempts[step]
      const fired = pickFault(pendingFaults, step, attempt)
      pendingFaults = remainingFaults(pendingFaults, fired)

      await delay(STEP_DURATION_MS)

      if (step === '校验通知内容') {
        const contentError = validateDraft(working)
        if (contentError) {
          return failAndCommit(working, step, contentError, stepAttempts, stepResults, units, receipts, pendingFaults, publishTime, opts.onStep)
        }
        if (fired?.kind === 'interrupt') {
          return failAndCommit(working, step, fired.reason, stepAttempts, stepResults, units, receipts, pendingFaults, publishTime, opts.onStep)
        }
        stepResults[step] = { status: 'done', at: timestamp(), note: '发布单内容校验通过' }
      }

      if (step === '推送接收单位') {
        // 已推送过的单位不重复推送（断点续跑/刷新恢复都安全）。
        const pushedUnits = new Set(receipts.map((r) => r.unit))
        const targets = units.filter((u) => !pushedUnits.has(u))
        for (const unit of targets) {
          if (fired?.kind === 'interrupt' && fired.reason.includes(unit)) {
            // 中断点精确落在该单位：本单位及之后都不产生回执。
            return failAndCommit(working, step, fired.reason, stepAttempts, stepResults, units, receipts, pendingFaults, publishTime, opts.onStep)
          }
          receipts.push({ unit, state: '已送达', sentAt: timestamp(), acknowledgedAt: null, abnormalReason: null })
          if (!publishTime) {
            publishTime = timestamp()
          }
          // 每推送一个单位就把进度整版本落库：中断后已推送清单、原草稿都在，失败现场也不被抹掉。
          const progress: AlarmNotice = {
            ...working,
            units,
            receipts: receipts.map((r) => ({ ...r })),
            status: working.status,
            failedStep: working.failedStep,
            failure: working.failure,
            stepResults,
            stepAttempts: { ...stepAttempts },
            faultInjections: pendingFaults,
            publishTime,
          }
          const committed = commitOne(progress, working.version)
          if (!committed.current) {
            return { ok: false, conflict: true, message: '发布过程中通知被删除', notice: undefined }
          }
          working = { ...committed.current }
          opts.onStep?.({ ...working })
          await delay(STEP_DURATION_MS / Math.max(targets.length, 1) / 2)
        }
        if (fired?.kind === 'interrupt') {
          return failAndCommit(working, step, fired.reason, stepAttempts, stepResults, units, receipts, pendingFaults, publishTime, opts.onStep)
        }
        stepResults[step] = {
          status: 'done',
          at: timestamp(),
          note: `${units.length} 个接收单位全部推送完成`,
        }
      }

      if (step === '收集回执') {
        const ackedUnits = new Set(receipts.filter((r) => r.acknowledgedAt !== null || r.state === '回执异常').map((r) => r.unit))
        const pendingAck = units.filter((u) => !ackedUnits.has(u))
        for (const unit of pendingAck) {
          const isFaulty = fired?.kind === 'abnormal-receipt' && fired.reason.includes(unit)
          if (fired?.kind === 'interrupt' && fired.reason.includes(unit)) {
            return failAndCommit(working, step, fired.reason, stepAttempts, stepResults, units, receipts, pendingFaults, publishTime, opts.onStep)
          }
          const target = receipts.find((r) => r.unit === unit)
          if (target) {
            if (isFaulty) {
              target.state = '回执异常'
              target.abnormalReason = fired!.reason
            } else {
              target.state = '已确认'
              target.acknowledgedAt = timestamp()
            }
          }
        }
        if (fired?.kind === 'interrupt') {
          return failAndCommit(working, step, fired.reason, stepAttempts, stepResults, units, receipts, pendingFaults, publishTime, opts.onStep)
        }
        const abnormal = receipts.filter((r) => r.state === '回执异常')
        const confirmed = receipts.filter((r) => r.state === '已确认')
        const note =
          abnormal.length > 0
            ? `收到回执 ${receipts.length} 份：确认 ${confirmed.length} 份，异常 ${abnormal.length} 份（${abnormal
                .map((r) => `${r.unit}: ${r.abnormalReason ?? '未填原因'}`)
                .join('；')}）`
            : `收到回执 ${receipts.length} 份，全部确认`
        stepResults[step] = { status: 'done', at: timestamp(), note }
      }

      const isLastStep = i === PUBLISH_STEPS.length - 1
      // 步骤完成整版本落库：
      // - 最后一步：已发布，清失败现场；
      // - 非最后一步且失败现场就在刚完成的步骤：转待发布，失败现场清除，继续下一步；
      // - 其他情况（失败点在后面的步骤）：保留发布失败与失败原因。
      const clearedJustSucceeded = base.failedStep === step
      const nextStatus: AlarmStatus = isLastStep
        ? '已发布'
        : working.status === '发布失败' && clearedJustSucceeded
          ? '待发布'
          : working.status
      const done: AlarmNotice = {
        ...working,
        units,
        receipts: receipts.map((r) => ({ ...r })),
        status: nextStatus,
        failedStep: isLastStep || clearedJustSucceeded ? null : working.failedStep,
        failure: isLastStep || clearedJustSucceeded ? null : working.failure,
        stepResults,
        stepAttempts: { ...stepAttempts },
        faultInjections: pendingFaults,
        publishTime,
      }
      const committed = commitOne(done, working.version)
      if (!committed.current) {
        return { ok: false, conflict: true, message: '提交发布进度时发生版本冲突' }
      }
      working = { ...committed.current }
      opts.onStep?.({ ...working })
    }

    const finalNotice = getAlarm(id)
    return {
      ok: true,
      message: finalNotice!.receipts.some((r) => r.state === '回执异常')
        ? '发布完成：部分回执异常，请在详情查看异常说明并跟进补正'
        : '发布完成，全部接收单位已确认',
      notice: finalNotice ?? undefined,
    }
  } finally {
    // 执行锁只允许持有者本人释放。
    if (inflight.get(id) === lockToken) {
      inflight.delete(id)
    }
  }
}

// 失败统一出口：原草稿、接收单位、已完成步骤与失败原因整版本保留，只落一次库。
function failAndCommit(
  working: AlarmNotice,
  step: PublishStep,
  reason: string,
  stepAttempts: Record<PublishStep, number>,
  stepResults: AlarmNotice['stepResults'],
  units: string[],
  receipts: Receipt[],
  pendingFaults: FaultInjection[],
  publishTime: string | null,
  onStep?: (notice: AlarmNotice) => void,
): AlarmActionResult {
  const failed: AlarmNotice = {
    ...working,
    units,
    receipts: receipts.map((r) => ({ ...r })),
    status: '发布失败',
    failedStep: step,
    failure: {
      failedStep: step,
      reason,
      failedAt: timestamp(),
      attemptsAtStep: stepAttempts[step],
    },
    stepResults: { ...stepResults },
    stepAttempts: { ...stepAttempts },
    faultInjections: pendingFaults,
    publishTime,
  }
  const { current: saved } = commitOne(failed, working.version)
  if (!saved) {
    return { ok: false, conflict: true, message: '失败现场保存时发生版本冲突' }
  }
  onStep?.({ ...saved })
  return {
    ok: false,
    message: `发布中断于「${step}」（第 ${stepAttempts[step]} 次尝试）：${reason}。草稿与接收单位已保留，可从该步骤重试。`,
    notice: { ...saved },
  }
}

export function isPublishing(id: number): boolean {
  return inflight.has(id)
}

export function registerResponse(id: number, expectedVersion?: number): AlarmActionResult {
  const current = getAlarm(id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的预警通知` }
  }
  if (expectedVersion !== undefined && current.version !== expectedVersion) {
    return { ok: false, conflict: true, message: '操作失败：通知已被其他操作更新，请刷新后重试', notice: { ...current } }
  }
  if (isTerminal(current.status)) {
    return { ok: false, message: `通知已结案（${current.status}），历史结论保留，不能再登记响应` }
  }
  if (current.status !== '已发布') {
    return { ok: false, message: `当前状态为「${current.status}」，只有已发布通知可以登记响应` }
  }
  const next: AlarmNotice = { ...current, status: '已响应', respondedAt: timestamp() }
  const { current: saved } = commitOne(next, current.version)
  if (!saved) {
    return { ok: false, conflict: true, message: '登记响应时发生版本冲突，请刷新后重试' }
  }
  return { ok: true, message: '响应已登记，通知进入已响应', notice: { ...saved } }
}

// 解除：结案动作，结论与解除时间永久保留；读取路径不会再把它算成待发布。
export function releaseAlarm(id: number, conclusion: string, operator: string, expectedVersion?: number): AlarmActionResult {
  const trimmed = conclusion.trim()
  if (!trimmed) {
    return { ok: false, message: '解除预警必须填写解除结论' }
  }
  const current = getAlarm(id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的预警通知` }
  }
  if (expectedVersion !== undefined && current.version !== expectedVersion) {
    return { ok: false, conflict: true, message: '解除失败：通知已被其他操作更新，请刷新后重试', notice: { ...current } }
  }
  if (current.status === '已解除') {
    return { ok: false, message: '该通知已解除，历史解除结论保留不变' }
  }
  if (current.status === '误报') {
    return { ok: false, message: '该通知已标记误报，不能再解除' }
  }
  if (isPublishable(current.status) || current.status === '发布失败') {
    return { ok: false, message: `通知尚处于「${current.status}」，发布未完成，不能解除` }
  }
  const next: AlarmNotice = {
    ...current,
    status: '已解除',
    releasedAt: timestamp(),
    releaseConclusion: trimmed,
    releaseOperator: operator.trim() || current.发布人,
  }
  const { current: saved } = commitOne(next, current.version)
  if (!saved) {
    return { ok: false, conflict: true, message: '解除失败：版本冲突，请刷新后重试' }
  }
  return { ok: true, message: '预警已解除，解除结论已归档', notice: { ...saved } }
}

export function markFalseAlarm(id: number, reason: string, expectedVersion?: number): AlarmActionResult {
  const trimmed = reason.trim()
  if (!trimmed) {
    return { ok: false, message: '标记误报必须填写核实情况' }
  }
  const current = getAlarm(id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的预警通知` }
  }
  if (expectedVersion !== undefined && current.version !== expectedVersion) {
    return { ok: false, conflict: true, message: '操作失败：通知已被其他操作更新，请刷新后重试', notice: { ...current } }
  }
  if (isTerminal(current.status)) {
    return { ok: false, message: `通知已结案（${current.status}），历史结论保留` }
  }
  if (current.status !== '已发布' && current.status !== '已响应') {
    return { ok: false, message: `当前状态为「${current.status}」，发布未完成，不能标记误报` }
  }
  const next: AlarmNotice = { ...current, status: '误报', falseAlarmReason: trimmed }
  const { current: saved } = commitOne(next, current.version)
  if (!saved) {
    return { ok: false, conflict: true, message: '操作失败：版本冲突，请刷新后重试' }
  }
  return { ok: true, message: '已标记误报并归档核实情况', notice: { ...saved } }
}

export function resetAlarms(): AlarmNotice[] {
  const seeded = ALARM_SEED.map((item) => ({ ...item }))
  return commitAll(seeded)
}

export function alarmStats() {
  const rows = loadAll()
  return {
    total: rows.length,
    pending: rows.filter((r) => ['待发布', '待分派'].includes(r.status)).length,
    failed: rows.filter((r) => r.status === '发布失败').length,
    active: rows.filter((r) => r.status === '已发布' || r.status === '已响应').length,
    closed: rows.filter((r) => isTerminal(r.status)).length,
    abnormalReceipts: rows.reduce((sum, r) => sum + r.receipts.filter((x) => x.state === '回执异常').length, 0),
  }
}
