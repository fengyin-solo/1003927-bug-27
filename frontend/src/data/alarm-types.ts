/** 预警通知领域模型：发布是一个多步骤、可中断、可断点续跑的流程，数据按整版本号原子落库。 */

// 发布流水线步骤，顺序固定；中断在哪一步，重试就从哪一步继续。
export type PublishStep = '校验通知内容' | '推送接收单位' | '收集回执'

export const PUBLISH_STEPS: PublishStep[] = ['校验通知内容', '推送接收单位', '收集回执']

export const STEP_DESCRIPTIONS: Record<PublishStep, string> = {
  校验通知内容: '核对通知编号、隐患点、预警等级、触发条件与发布人，形成正式发布单。',
  推送接收单位: '按接收单位清单逐个推送，中途中断不会产生半截回执。',
  收集回执: '回收各单位送达/确认情况，异常回执必须带异常说明。',
}

// 待发布=草稿；发布失败=中断后保留草稿；待分派=接收单位为空，等分派后才能推送。
export type AlarmStatus =
  | '待发布'
  | '发布失败'
  | '待分派'
  | '已发布'
  | '已响应'
  | '已解除'
  | '误报'

// 已解除、误报是结案态：历史结论只读保留，不允许再发布或改状态。
export const TERMINAL_STATUSES: AlarmStatus[] = ['已解除', '误报']

// 允许发起（或重试）发布的状态。
export const PUBLISHABLE_STATUSES: AlarmStatus[] = ['待发布', '发布失败', '待分派']

export type ReceiptState = '已送达' | '已确认' | '回执异常'

export type Receipt = {
  unit: string
  state: ReceiptState
  sentAt: string | null
  acknowledgedAt: string | null
  // 回执异常时必填的人工说明，列表和详情直接展示，不允许只留一个异常标记。
  abnormalReason: string | null
}

export type FailureInfo = {
  failedStep: PublishStep
  reason: string
  failedAt: string
  // 该步骤已经是第几次尝试，重试时 +1，用于说明「从失败步骤继续」。
  attemptsAtStep: number
}

export type StepResult = {
  status: 'done' | 'failed'
  at: string
  note?: string
}

// 演练用故障注入：只在指定步骤的第 triggerAttempt 次尝试时生效一次。
export type FaultInjection = {
  step: PublishStep
  triggerAttempt: number
  kind: 'interrupt' | 'abnormal-receipt'
  reason: string
}

export type AlarmNotice = {
  id: number
  通知编号: string
  隐患点编号: string
  预警等级: string
  触发条件: string
  发布人: string
  // 接收单位清单是正式数据：发布中断后必须原样保留，绝不清空。
  units: string[]
  receipts: Receipt[]
  status: AlarmStatus
  publishTime: string | null
  respondedAt: string | null
  releasedAt: string | null
  releaseConclusion: string | null
  releaseOperator: string | null
  falseAlarmReason: string | null
  // 失败现场：失败步骤、原因、各步骤尝试次数、已完成步骤。
  failedStep: PublishStep | null
  failure: FailureInfo | null
  stepResults: Partial<Record<PublishStep, StepResult>>
  stepAttempts: Record<PublishStep, number>
  faultInjections: FaultInjection[]
  // 乐观锁版本：每次落库 +1，并发重试只有持当前版本的那一个能写成功。
  version: number
  createdAt: string
  updatedAt: string
  // 给通用看板用的派生标记。
  pending: boolean
  abnormal: boolean
}

export type AlarmDraftInput = {
  通知编号: string
  隐患点编号: string
  预警等级: string
  触发条件: string
  发布人: string
  units: string[]
}

export type AlarmListResult = {
  items: AlarmNotice[]
  total: number
}

export type AlarmActionResult = {
  ok: boolean
  message: string
  notice?: AlarmNotice
  // 并发冲突（已有在执行的发布，或版本已过期）时置位，页面据此提示而不是覆盖数据。
  conflict?: boolean
}

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as string[]).includes(status)
}

export function isPublishable(status: string): boolean {
  return (PUBLISHABLE_STATUSES as string[]).includes(status)
}
