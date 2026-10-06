/**
 * 预警通知专用数据模型。
 *
 * 与通用台账（EntryRow）不同，发布是一个多步骤过程：草稿 -> 发布前校验 ->
 * 通知下发 -> 回执确认，任何一步失败都必须保留草稿、接收单位与失败原因，
 * 重试时从失败的那一步继续。
 */

/** 通知生命周期状态 */
export type AlarmStatus =
  | '草稿'
  | '待发布'
  | '待分派' // 接收单位为空：不直接报错，等值班人员分派接收单位
  | '发布中'
  | '发布失败'
  | '已发布'
  | '已响应'
  | '已解除'
  | '误报'

/** 终态：历史结论不允许再被发布动作覆盖（解除后重新进入仍显示原结论） */
export const TERMINAL_STATUSES: AlarmStatus[] = ['已解除', '误报']

/** 发布流水线步骤，顺序敏感，重试从 failedStep 继续 */
export type PublishStep = '校验' | '下发' | '回执'
export const PUBLISH_STEPS: PublishStep[] = ['校验', '下发', '回执']

/** 单个接收单位的回执状态 */
export type ReceiptState = '待接收' | '已接收' | '异常回执'

export type Receipt = {
  unit: string
  state: ReceiptState
  /** 异常回执的说明：列表与详情都要展示，不能只剩一个红点 */
  note: string
  receivedAt: string
}

export type StepLog = {
  step: PublishStep
  ok: boolean
  at: string
  message: string
}

export type AlarmNotice = {
  /** 版本号：每次落盘 +1，并发提交只有版本对得上的那一个生效 */
  version: number
  id: number
  code: string
  hazardCode: string
  level: string
  triggerCondition: string
  publisher: string
  publishedAt: string
  /** 原始草稿正文，发布失败也不能清空 */
  draftContent: string
  /** 接收单位原始字符串，一个单位一行；为空表示尚未分派 */
  recipientsText: string
  status: AlarmStatus
  /** 发布失败时已经走到的步骤；成功为 null */
  failedStep: PublishStep | null
  /** 失败原因，失败时必须保留并在列表/详情说明 */
  failureReason: string
  /** 下发结果：每个接收单位一条回执 */
  receipts: Receipt[]
  /** 发布流水线日志，成功失败都记，异常回执也能溯源 */
  stepLogs: StepLog[]
  /** 登记响应时填写的响应说明 */
  responseNote: string
  respondedAt: string
  /** 解除结论：解除的历史通知永远保留这份结论 */
  releaseConclusion: string
  releasedAt: string
  createdAt: string
  updatedAt: string
}

export type AlarmActionResult = {
  ok: boolean
  message: string
  /** 本次提交后通知的最新状态（并发冲突时可能与预期不同） */
  status?: AlarmStatus
  /** 空接收单位进入待分派时为 true，供页面区分提示而不是当成失败 */
  diverted?: boolean
  /** 新建成功时返回新通知 id */
  id?: number
}

export type AlarmDraftInput = {
  hazardCode: string
  level: string
  triggerCondition: string
  publisher: string
  recipientsText: string
  draftContent: string
}
