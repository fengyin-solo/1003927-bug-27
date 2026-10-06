import { reactive } from 'vue'

import { ALARM_SEED } from './seed'
import {
  PUBLISH_STEPS,
  TERMINAL_STATUSES,
  type AlarmActionResult,
  type AlarmDraftInput,
  type AlarmNotice,
  type AlarmStatus,
  type PublishStep,
  type Receipt,
} from './types'

/**
 * 预警通知数据层。
 *
 * 关键约定：
 * - 发布是「校验 -> 下发 -> 回执」三步流水线，失败时一次性原子写入
 *   状态、失败步骤、失败原因、步骤日志和已产生的回执，草稿与接收单位原样保留；
 * - 重试从 failedStep 继续，已完成的步骤不重跑；
 * - 每次落盘 version + 1，配合版本号 CAS、本标签页进行中锁与跨标签页租约锁，
 *   并发重试同一条通知只有一个版本生效；
 * - 已解除 / 误报是终态，任何动作都不能再把它改回待发布。
 */

const ALARM_STORAGE_KEY = 'geohazard-monitor-prevention:alarm-notices'
const LEGACY_STORAGE_KEY = 'geohazard-monitor-prevention:entries'
const CHANNEL_STORAGE_KEY = 'geohazard-monitor-prevention:alarm-channel'
const LOCK_STORAGE_PREFIX = 'geohazard-monitor-prevention:alarm-lock:'
const LOCK_TTL_MS = 30_000
const STEP_DURATION_MS = 380
/** 接收单位名称带这个标记时，模拟该单位回执异常（演练用，页面上有说明） */
const ABNORMAL_RECEIPT_TAG = '测试异常'

const hasStorage = () => typeof window !== 'undefined' && !!window.localStorage

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function nowLabel(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// ---- 发布通道开关（演练用）：关闭后下发 / 回执会中断，用于复现失败与重试 ----

const channelDown = refStorageFlag(CHANNEL_STORAGE_KEY, false)

function refStorageFlag(key: string, initial: boolean) {
  const flag = reactive({ value: initial })
  if (hasStorage()) {
    flag.value = window.localStorage.getItem(key) === 'off'
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (event) => {
        if (event.key === key) {
          flag.value = event.newValue === 'off'
        }
      })
    }
  }
  return flag
}

export function isChannelDown(): boolean {
  return channelDown.value
}

export function setChannelDown(down: boolean): void {
  channelDown.value = down
  if (hasStorage()) {
    window.localStorage.setItem(CHANNEL_STORAGE_KEY, down ? 'off' : 'on')
  }
}

// ---- 存储读写 ----

let cache: AlarmNotice[] | null = null
let storageBound = false

function readRaw(): string | null {
  return hasStorage() ? window.localStorage.getItem(ALARM_STORAGE_KEY) : null
}

function writeRaw(rows: AlarmNotice[]): void {
  if (hasStorage()) {
    window.localStorage.setItem(ALARM_STORAGE_KEY, JSON.stringify(rows))
  }
}

/** 旧版通用台账里的 alarm 数据一次性迁移到专用结构，迁移后从旧存储中摘除 */
function migrateLegacyAlarm(): AlarmNotice[] | null {
  if (!hasStorage()) {
    return null
  }
  const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY)
  if (!raw) {
    return null
  }
  let legacy: Record<string, unknown>
  try {
    legacy = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  const oldRows = Array.isArray(legacy.alarm) ? (legacy.alarm as Record<string, unknown>[]) : []
  if (oldRows.length === 0) {
    return null
  }

  const STATUS_MAP: Record<string, AlarmStatus> = {
    待发布: '待发布',
    已发布: '已发布',
    已响应: '已响应',
    已解除: '已解除',
    误报: '误报',
  }

  const migrated = oldRows.map((old, index): AlarmNotice => {
    const mapped = STATUS_MAP[String(old.status ?? '')] ?? '待发布'
    const recipients = splitRecipients(String(old.接收单位 ?? ''))
    const abnormal = old.abnormal === true
    const timestamp = `2026-09-0${index + 1} 10:00`
    return {
      version: 1,
      id: Number(old.id ?? index + 1),
      code: String(old.通知编号 ?? `ALAR-LEGACY-${index + 1}`),
      hazardCode: String(old.隐患点编号 ?? ''),
      level: String(old.预警等级 ?? ''),
      triggerCondition: String(old.触发条件 ?? ''),
      publisher: String(old.发布人 ?? ''),
      publishedAt: ['已发布', '已响应', '已解除'].includes(mapped) ? timestamp : '',
      draftContent: '历史数据迁移：原系统未保存通知草稿正文。',
      recipientsText: recipients.join('\n'),
      status: mapped,
      failedStep: null,
      failureReason: '',
      receipts:
        mapped === '已发布' || mapped === '已响应' || mapped === '已解除'
          ? recipients.map<Receipt>((unit) =>
              abnormal
                ? {
                    unit,
                    state: '异常回执',
                    note: '历史数据迁移：该通知在旧系统中被标记为异常，但未登记回执说明，请电话核实接收情况。',
                    receivedAt: timestamp,
                  }
                : { unit, state: '已接收', note: '', receivedAt: timestamp },
            )
          : [],
      stepLogs: [
        {
          step: '回执' as PublishStep,
          ok: true,
          at: timestamp,
          message: abnormal
            ? '历史数据迁移：旧系统仅留下异常标记，已补登异常回执说明。'
            : '历史数据迁移：沿用旧系统发布结论。',
        },
      ],
      responseNote: '',
      respondedAt: mapped === '已响应' || mapped === '已解除' ? timestamp : '',
      releaseConclusion:
        mapped === '已解除' ? '历史数据迁移：原系统未登记解除结论，解除状态按历史结论保留。' : '',
      releasedAt: mapped === '已解除' ? timestamp : '',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
  })

  // 迁移与摘除放在同一次操作里完成，避免新库已建、旧库还在的半成品状态
  writeRaw(migrated)
  delete legacy.alarm
  window.localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(legacy))
  return migrated
}

function load(): AlarmNotice[] {
  if (cache !== null) {
    return cache
  }
  const raw = readRaw()
  if (raw !== null) {
    try {
      cache = JSON.parse(raw) as AlarmNotice[]
    } catch {
      cache = clone(ALARM_SEED)
      writeRaw(cache)
    }
  } else {
    cache = migrateLegacyAlarm() ?? clone(ALARM_SEED)
    writeRaw(cache)
  }
  if (hasStorage() && typeof window !== 'undefined' && !storageBound) {
    storageBound = true
    window.addEventListener('storage', (event) => {
      if (event.key === ALARM_STORAGE_KEY || event.key?.startsWith(LOCK_STORAGE_PREFIX)) {
        cache = null
      }
    })
  }
  return cache!
}

/** 整表一次性落盘：一次流水线结论对应一次写入，不会出现状态写了一半 */
function persist(rows: AlarmNotice[]): void {
  cache = rows
  writeRaw(rows)
}

function findRow(rows: AlarmNotice[], id: number): AlarmNotice | undefined {
  return rows.find((row) => row.id === id)
}

/**
 * 版本号 CAS 落盘：只有持有的版本仍是最新版本时才允许写入。
 * 返回 false 表示期间有别的提交先生效，本次结果作废。
 */
function commitVersioned(next: AlarmNotice, expectedVersion: number): boolean {
  const rows = load()
  const current = findRow(rows, next.id)
  if (!current || current.version !== expectedVersion) {
    return false
  }
  const stamped: AlarmNotice = {
    ...clone(next),
    version: expectedVersion + 1,
    updatedAt: nowLabel(),
  }
  persist(rows.map((row) => (row.id === next.id ? stamped : row)))
  return true
}

// ---- 跨标签页 / 同页并发锁 ----

const tabId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
/** 本标签页正在发布的通知：按钮据此禁用，重复点击直接拦掉 */
export const inflightIds = reactive(new Set<number>())

/** 流水线进入某一步时的钩子，主要供测试在「下发成功后、回执前」掐断通道 */
let stepHook: ((id: number, step: PublishStep) => void) | null = null
export function __setStepHookForTest(fn: ((id: number, step: PublishStep) => void) | null): void {
  stepHook = fn
}

type LockRecord = { tab: string; at: number }

function acquireLock(id: number): boolean {
  if (inflightIds.has(id)) {
    return false
  }
  if (hasStorage()) {
    const key = LOCK_STORAGE_PREFIX + id
    const raw = window.localStorage.getItem(key)
    if (raw) {
      try {
        const lock = JSON.parse(raw) as LockRecord
        if (lock.tab !== tabId && Date.now() - lock.at < LOCK_TTL_MS) {
          return false
        }
      } catch {
        // 锁内容损坏按过期处理，下面直接覆盖
      }
    }
    window.localStorage.setItem(key, JSON.stringify({ tab: tabId, at: Date.now() } satisfies LockRecord))
  }
  inflightIds.add(id)
  return true
}

function releaseLock(id: number): void {
  inflightIds.delete(id)
  if (hasStorage()) {
    const key = LOCK_STORAGE_PREFIX + id
    try {
      const raw = window.localStorage.getItem(key)
      if (raw) {
        const lock = JSON.parse(raw) as LockRecord
        if (lock.tab === tabId) {
          window.localStorage.removeItem(key)
        }
      }
    } catch {
      window.localStorage.removeItem(key)
    }
  }
}

// ---- 查询路径 ----

export function listNotices(filters: Record<string, string> = {}): AlarmNotice[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  const rows = [...load()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => {
      const key = field as keyof AlarmNotice
      const target = String(row[key] ?? '')
      return target.includes(value.trim())
    }),
  )
}

export function getNotice(id: number): AlarmNotice | undefined {
  return findRow(load(), id)
}

export function splitRecipients(text: string): string[] {
  return text
    .split(/[\n,，、;；]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export function abnormalReceiptCount(notice: AlarmNotice): number {
  return notice.receipts.filter((receipt) => receipt.state === '异常回执').length
}

// ---- 草稿与登记 ----

function nextId(): number {
  return load().reduce((max, row) => Math.max(max, row.id), 0) + 1
}

function nextCode(): string {
  const d = new Date()
  const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`
  const seq = load().filter((row) => row.code.includes(ym)).length + 1
  return `ALAR-${ym}-${String(seq).padStart(3, '0')}`
}

export function createNotice(input: AlarmDraftInput, submit: boolean): AlarmActionResult {
  const trimmed = trimInput(input)
  const status: AlarmStatus = submit
    ? splitRecipients(trimmed.recipientsText).length === 0
      ? '待分派'
      : '待发布'
    : '草稿'
  const timestamp = nowLabel()
  const notice: AlarmNotice = {
    version: 1,
    id: nextId(),
    code: nextCode(),
    hazardCode: trimmed.hazardCode,
    level: trimmed.level,
    triggerCondition: trimmed.triggerCondition,
    publisher: trimmed.publisher,
    publishedAt: '',
    draftContent: trimmed.draftContent,
    recipientsText: trimmed.recipientsText,
    status,
    failedStep: null,
    failureReason: '',
    receipts: [],
    stepLogs:
      status === '待分派'
        ? [{ step: '校验', ok: true, at: timestamp, message: '登记时未填写接收单位，进入待分派，请先分派接收单位再发布。' }]
        : [],
    responseNote: '',
    respondedAt: '',
    releaseConclusion: '',
    releasedAt: '',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  persist([...load(), notice])
  return submit && status === '待分派'
    ? { ok: true, id: notice.id, diverted: true, status, message: '未填写接收单位，通知已转入待分派，分派后即可发布。' }
    : { ok: true, id: notice.id, status, message: submit ? '通知已登记，可发布。' : '草稿已保存。' }
}

function trimInput(input: AlarmDraftInput): AlarmDraftInput {
  return {
    hazardCode: input.hazardCode.trim(),
    level: input.level.trim(),
    triggerCondition: input.triggerCondition.trim(),
    publisher: input.publisher.trim(),
    recipientsText: input.recipientsText.trim(),
    draftContent: input.draftContent.trim(),
  }
}

const EDITABLE_STATUSES: AlarmStatus[] = ['草稿', '待发布', '待分派', '发布失败']

/**
 * 保存草稿。
 * expectedVersion 是页面打开表单时读到的版本号：带上它就是乐观锁，
 * 期间别的标签页/页面已经提交过时，本次陈旧编辑会被拒绝而不是覆盖。
 */
export function saveDraft(id: number, input: AlarmDraftInput, expectedVersion?: number): AlarmActionResult {
  const rows = load()
  const current = findRow(rows, id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的预警通知` }
  }
  if (TERMINAL_STATUSES.includes(current.status)) {
    return { ok: false, status: current.status, message: `通知已${current.status}，历史结论不再修改。` }
  }
  if (!EDITABLE_STATUSES.includes(current.status)) {
    return { ok: false, status: current.status, message: `通知当前为「${current.status}」，不能再编辑草稿。` }
  }
  if (expectedVersion !== undefined && current.version !== expectedVersion) {
    return { ok: false, status: current.status, message: '通知在你编辑期间已被其他人修改或提交，本页内容已过期，请刷新后在最新版本上修改。' }
  }
  const trimmed = trimInput(input)
  const recipients = splitRecipients(trimmed.recipientsText)
  let failedStep = current.failedStep
  if (current.status === '发布失败' && failedStep === '回执') {
    // 接收单位与失败时不一致，回执无法接着补，整份重新走流水线
    const oldUnits = current.receipts.map((receipt) => receipt.unit)
    const sameUnits = oldUnits.length === recipients.length && oldUnits.every((unit) => recipients.includes(unit))
    if (!sameUnits) {
      failedStep = null
    }
  }
  const next: AlarmNotice = {
    ...current,
    ...trimmed,
    status: recipients.length === 0 && current.status !== '草稿' ? '待分派' : current.status === '待分派' && recipients.length > 0 ? '待发布' : current.status,
    failedStep,
  }
  if (!commitVersioned(next, expectedVersion ?? current.version)) {
    return { ok: false, message: '通知刚被其他人修改或提交，本页内容已过期，请刷新后重试。' }
  }
  return { ok: true, status: next.status, message: '草稿修改已保存，原有失败记录保留。' }
}

export function dispatchRecipients(id: number, recipientsText: string): AlarmActionResult {
  const rows = load()
  const current = findRow(rows, id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的预警通知` }
  }
  if (TERMINAL_STATUSES.includes(current.status)) {
    return { ok: false, status: current.status, message: `通知已${current.status}，历史结论不再变更。` }
  }
  if (current.status !== '待分派') {
    return { ok: false, status: current.status, message: `只有待分派通知需要分派接收单位，当前为「${current.status}」。` }
  }
  const units = splitRecipients(recipientsText)
  if (units.length === 0) {
    return { ok: false, status: '待分派', message: '接收单位仍为空：请至少分派一个接收单位。' }
  }
  const next: AlarmNotice = {
    ...current,
    recipientsText: units.join('\n'),
    status: '待发布',
    stepLogs: [...current.stepLogs, { step: '校验', ok: true, at: nowLabel(), message: `已分派 ${units.length} 个接收单位，等待发布。` }],
  }
  if (!commitVersioned(next, current.version)) {
    return { ok: false, message: '通知刚被其他人修改或提交，本页内容已过期，请刷新后重试。' }
  }
  return { ok: true, status: '待发布', message: `已分派 ${units.length} 个接收单位，可以发布。` }
}

// ---- 发布流水线 ----

function validateDraft(notice: AlarmNotice): string | null {
  if (!notice.hazardCode) return '发布前校验未通过：隐患点编号为空。'
  if (!notice.level) return '发布前校验未通过：预警等级为空。'
  if (!notice.triggerCondition) return '发布前校验未通过：触发条件为空。'
  if (!notice.publisher) return '发布前校验未通过：发布人为空。'
  if (!notice.draftContent) return '发布前校验未通过：通知正文为空。'
  return null
}

function startIndexFor(notice: AlarmNotice): number {
  if (notice.failedStep === null) {
    return 0
  }
  const failedIndex = PUBLISH_STEPS.indexOf(notice.failedStep)
  if (notice.failedStep === '回执') {
    const units = splitRecipients(notice.recipientsText)
    const receiptUnits = notice.receipts.map((receipt) => receipt.unit)
    const sameUnits = units.length === receiptUnits.length && units.every((unit) => receiptUnits.includes(unit))
    // 失败时的接收单位已经变了，只能从头重走
    return sameUnits ? failedIndex : 0
  }
  return failedIndex
}

export async function publishNotice(id: number): Promise<AlarmActionResult> {
  const before = findRow(load(), id)
  if (!before) {
    return { ok: false, message: `没有找到编号为 ${id} 的预警通知` }
  }
  if (TERMINAL_STATUSES.includes(before.status)) {
    return { ok: false, status: before.status, message: `通知已${before.status}并保留历史结论，不能重新发布。` }
  }
  if (before.status === '已发布' || before.status === '已响应') {
    return { ok: false, status: before.status, message: `通知已发布（当前「${before.status}」），请勿重复发布。` }
  }
  if (!acquireLock(id)) {
    return {
      ok: false,
      status: before.status,
      message: inflightIds.has(id) ? '该通知正在发布中，请勿重复点击。' : '该通知正在另一处发布中，请等待当前发布结束。',
    }
  }

  try {
    // 空接收单位：转入待分派，不把它当成发布失败
    const units = splitRecipients(before.recipientsText)
    if (units.length === 0) {
      const diverted: AlarmNotice = {
        ...before,
        status: '待分派',
        failedStep: null,
        failureReason: '',
        stepLogs: [
          ...before.stepLogs,
          { step: '校验' as PublishStep, ok: true, at: nowLabel(), message: '发布时发现接收单位为空，已转入待分派，分派后再发布。' },
        ],
      }
      if (!commitVersioned(diverted, before.version)) {
        return { ok: false, message: '通知刚被其他人修改或提交，请刷新后查看最新状态。' }
      }
      return { ok: true, diverted: true, status: '待分派', message: '接收单位为空，通知已转入待分派，分派接收单位后再发布。' }
    }

    let working: AlarmNotice = {
      ...before,
      status: '发布中',
      failureReason: '',
      updatedAt: nowLabel(),
    }
    let expected = before.version
    if (!commitVersioned(working, expected)) {
      return { ok: false, message: '通知刚被其他人修改或提交，请刷新后查看最新状态。' }
    }
    expected += 1

    const startIndex = startIndexFor(before)
    let receipts = clone(before.receipts)
    const logs = [...before.stepLogs]

    for (let index = startIndex; index < PUBLISH_STEPS.length; index += 1) {
      const step = PUBLISH_STEPS[index]
      stepHook?.(id, step)
      await sleep(STEP_DURATION_MS)

      if (step === '校验') {
        const invalid = validateDraft(working)
        if (invalid) {
          return finishFailure(working, expected, '校验', invalid, receipts, logs)
        }
        logs.push({ step, ok: true, at: nowLabel(), message: '发布前校验通过：隐患点、等级、正文、接收单位齐全。' })
        continue
      }

      if (step === '下发') {
        if (isChannelDown()) {
          const reason = '通知下发中断：发布通道连接超时，草稿与接收单位已保留，可重试。'
          logs.push({ step, ok: false, at: nowLabel(), message: reason })
          return finishFailure(working, expected, '下发', reason, receipts, logs)
        }
        receipts = units.map<Receipt>((unit) => ({ unit, state: '待接收', note: '', receivedAt: '' }))
        logs.push({ step, ok: true, at: nowLabel(), message: `通知已下发至 ${units.length} 个接收单位，等待回执。` })
        continue
      }

      // 回执：通道仍可能在等待期间被切断
      if (isChannelDown()) {
        const reason = '回执确认中断：发布通道连接超时，下发结果已保留，可从回执步骤重试。'
        logs.push({ step, ok: false, at: nowLabel(), message: reason })
        return finishFailure(working, expected, '回执', reason, receipts, logs)
      }
      const timestamp = nowLabel()
      let abnormal = 0
      receipts = receipts.map<Receipt>((receipt) => {
        if (receipt.unit.includes(ABNORMAL_RECEIPT_TAG)) {
          abnormal += 1
          return {
            ...receipt,
            state: '异常回执',
            receivedAt: timestamp,
            note: `回执异常：「${receipt.unit}」返回的回执签名缺失，已自动登记说明，请电话核实；通知本身已送达。`,
          }
        }
        return { ...receipt, state: '已接收', note: '', receivedAt: timestamp }
      })
      logs.push({
        step,
        ok: true,
        at: timestamp,
        message:
          abnormal > 0
            ? `回执确认完成：${receipts.length} 个单位已送达，其中 ${abnormal} 个异常回执，已在回执明细注明原因与核实要求。`
            : `回执确认完成：${receipts.length} 个接收单位全部确认接收。`,
      })
    }

    // 成功结论一次性原子写入：状态、发布时间、回执、日志同时落盘
    const success: AlarmNotice = {
      ...working,
      status: '已发布',
      publishedAt: before.publishedAt || nowLabel(),
      failedStep: null,
      failureReason: '',
      receipts,
      stepLogs: logs,
    }
    if (!commitVersioned(success, expected)) {
      return { ok: false, message: '发布期间通知被其他人修改，本次发布结果未生效，请刷新后重试。' }
    }
    const abnormalCount = receipts.filter((receipt) => receipt.state === '异常回执').length
    return {
      ok: true,
      status: '已发布',
      message:
        abnormalCount > 0
          ? `发布完成：${receipts.length} 个单位已送达，${abnormalCount} 个回执异常，详情见回执说明。`
          : `发布完成：${receipts.length} 个接收单位全部确认接收。`,
    }
  } finally {
    releaseLock(id)
  }
}

/** 失败结论同样一次性原子写入：失败状态、失败步骤、原因、日志、已产生回执齐备 */
function finishFailure(
  working: AlarmNotice,
  expectedVersion: number,
  step: PublishStep,
  reason: string,
  receipts: Receipt[],
  logs: AlarmNotice['stepLogs'],
): AlarmActionResult {
  const failed: AlarmNotice = {
    ...working,
    status: '发布失败',
    failedStep: step,
    failureReason: reason,
    receipts,
    stepLogs: logs,
  }
  if (!commitVersioned(failed, expectedVersion)) {
    return { ok: false, message: '失败回执写入时发现通知已被其他人提交，本次结果未生效，请刷新后查看。' }
  }
  return {
    ok: false,
    status: '发布失败',
    message: `${reason} 草稿与接收单位已保留，可从「${step}」步骤重试。`,
  }
}

// ---- 响应、解除、误报（终态保护在这里统一收口） ----

function terminalGuard(current: AlarmNotice): AlarmActionResult | null {
  if (TERMINAL_STATUSES.includes(current.status)) {
    return {
      ok: false,
      status: current.status,
      message:
        current.status === '已解除'
          ? `通知已于 ${current.releasedAt} 解除，解除结论保留：${current.releaseConclusion || '原解除结论'}。历史结论不再变更。`
          : '该通知已认定为误报，历史结论不再变更。',
    }
  }
  return null
}

export function recordResponse(id: number, note: string): AlarmActionResult {
  const current = findRow(load(), id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的预警通知` }
  }
  const guarded = terminalGuard(current)
  if (guarded) {
    return guarded
  }
  if (current.status !== '已发布') {
    return { ok: false, status: current.status, message: `只有已发布通知可以登记响应，当前为「${current.status}」。` }
  }
  const text = note.trim()
  if (!text) {
    return { ok: false, status: current.status, message: '请填写响应处置情况后再登记。' }
  }
  const next: AlarmNotice = { ...current, status: '已响应', responseNote: text, respondedAt: nowLabel() }
  if (!commitVersioned(next, current.version)) {
    return { ok: false, message: '通知刚被其他人提交，请刷新后重试。' }
  }
  return { ok: true, status: '已响应', message: '响应情况已登记。' }
}

export function releaseNotice(id: number, conclusion: string): AlarmActionResult {
  const current = findRow(load(), id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的预警通知` }
  }
  const guarded = terminalGuard(current)
  if (guarded) {
    return guarded
  }
  if (current.status !== '已发布' && current.status !== '已响应') {
    return { ok: false, status: current.status, message: `发布后的通知才能解除，当前为「${current.status}」。` }
  }
  const text = conclusion.trim()
  if (!text) {
    return { ok: false, status: current.status, message: '解除结论必填：解除后通知将永久保留这份结论。' }
  }
  const timestamp = nowLabel()
  const next: AlarmNotice = { ...current, status: '已解除', releaseConclusion: text, releasedAt: timestamp }
  if (!commitVersioned(next, current.version)) {
    return { ok: false, message: '通知刚被其他人提交，请刷新后重试。' }
  }
  return { ok: true, status: '已解除', message: `预警已解除，结论已归档：${text}` }
}

export function markFalseAlarm(id: number, reason: string): AlarmActionResult {
  const current = findRow(load(), id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的预警通知` }
  }
  const guarded = terminalGuard(current)
  if (guarded) {
    return guarded
  }
  const allowed: AlarmStatus[] = ['待发布', '待分派', '发布失败', '已发布', '已响应']
  if (!allowed.includes(current.status)) {
    return { ok: false, status: current.status, message: `当前状态「${current.status}」不能认定误报。` }
  }
  const text = reason.trim()
  if (!text) {
    return { ok: false, status: current.status, message: '请填写误报判定依据。' }
  }
  const timestamp = nowLabel()
  const next: AlarmNotice = {
    ...current,
    status: '误报',
    releasedAt: timestamp,
    releaseConclusion: `误报：${text}`,
  }
  if (!commitVersioned(next, current.version)) {
    return { ok: false, message: '通知刚被其他人提交，请刷新后重试。' }
  }
  return { ok: true, status: '误报', message: '已认定为误报并归档。' }
}

// ---- 导出 ----

export function exportNotices(): { filename: string; content: string } {
  const header = ['通知编号', '隐患点编号', '预警等级', '触发条件', '发布时间', '接收单位', '发布人', '通知状态', '失败原因']
  const lines = [header.join(',')]
  for (const row of listNotices()) {
    lines.push(
      [
        row.code,
        row.hazardCode,
        row.level,
        row.triggerCondition,
        row.publishedAt,
        splitRecipients(row.recipientsText).join('；'),
        row.publisher,
        row.status,
        row.failureReason,
      ]
        .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
        .join(','),
    )
  }
  return { filename: '预警发布-清单.csv', content: `﻿${lines.join('\n')}` }
}
