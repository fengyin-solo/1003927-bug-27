<template>
  <section class="page alarm-detail" v-if="notice">
    <header class="page-head">
      <div>
        <h2>
          预警通知详情 · {{ notice.通知编号 }}
          <span class="version-tag">v{{ notice.version }}</span>
          <span class="status-tag" :class="statusClass(notice.status)">{{ notice.status }}</span>
          <span v-if="running" class="running-tag">发布中…</span>
        </h2>
        <p class="page-desc">{{ notice.隐患点编号 }} · {{ notice.预警等级 }} · 创建于 {{ notice.createdAt }}</p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" to="/alarm">返回列表</RouterLink>
        <RouterLink v-if="retryable" class="btn primary" :to="`/alarm/publish/${notice.id}`">
          {{ notice.status === '发布失败' ? '重试发布（断点续跑）' : '进入发布' }}
        </RouterLink>
      </div>
    </header>

    <p v-if="message" class="inline-message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</p>

    <!-- 失败现场：失败原因、失败步骤、尝试次数必须显式展示，不能只留一个红色错误标记 -->
    <article v-if="notice.failure" class="panel panel-fail">
      <h3>发布失败现场（草稿与接收单位均已保留）</h3>
      <dl class="detail-grid">
        <div><dt>失败步骤</dt><dd>{{ notice.failure.failedStep }}</dd></div>
        <div><dt>失败时间</dt><dd>{{ notice.failure.failedAt }}</dd></div>
        <div><dt>该步骤尝试次数</dt><dd>第 {{ notice.failure.attemptsAtStep }} 次</dd></div>
        <div class="full"><dt>失败原因</dt><dd class="error-text">{{ notice.failure.reason }}</dd></div>
      </dl>
      <p class="hint">重试将直接从「{{ notice.failure.failedStep }}」继续，已完成步骤与已推送回执不会重复执行。</p>
      <button class="btn primary" type="button" :disabled="running" @click="retry">立即重试</button>
    </article>

    <!-- 空接收单位说明：这是待分派，不是错误 -->
    <article v-if="notice.status === '待分派' || notice.units.length === 0" class="panel panel-warn">
      <h3>接收单位待分派</h3>
      <p class="hint">该通知当前<strong>没有接收单位</strong>，系统已将其置为「待分派」而非报错。请补登接收单位后再发布。</p>
      <div class="assign-row">
        <input v-model="unitInput" placeholder="输入接收单位，多个用逗号或顿号分隔" />
        <button class="btn primary" type="button" :disabled="running" @click="assign">补登并分派</button>
      </div>
    </article>

    <!-- 历史结论：已解除/误报只读保留，重新进入不会再显示待发布 -->
    <article v-if="terminal" class="panel panel-closed">
      <h3>结案结论（只读归档）</h3>
      <dl class="detail-grid">
        <template v-if="notice.status === '已解除'">
          <div><dt>解除时间</dt><dd>{{ notice.releasedAt }}</dd></div>
          <div><dt>解除操作人</dt><dd>{{ notice.releaseOperator }}</dd></div>
          <div class="full"><dt>解除结论</dt><dd>{{ notice.releaseConclusion }}</dd></div>
        </template>
        <template v-else>
          <div class="full"><dt>误报核实情况</dt><dd>{{ notice.falseAlarmReason }}</dd></div>
        </template>
      </dl>
      <p class="hint">该通知已结案，历史结论永久保留，不能再次发布或登记响应。</p>
    </article>

    <article class="panel">
      <h3>通知内容（草稿原件）</h3>
      <dl class="detail-grid">
        <div><dt>通知编号</dt><dd>{{ notice.通知编号 }}</dd></div>
        <div><dt>隐患点编号</dt><dd>{{ notice.隐患点编号 }}</dd></div>
        <div><dt>预警等级</dt><dd>{{ notice.预警等级 }}</dd></div>
        <div><dt>发布人</dt><dd>{{ notice.发布人 }}</dd></div>
        <div><dt>发布时间</dt><dd>{{ notice.publishTime ?? '尚未成功发布' }}</dd></div>
        <div><dt>响应时间</dt><dd>{{ notice.respondedAt ?? '尚未响应' }}</dd></div>
        <div class="full"><dt>触发条件</dt><dd>{{ notice.触发条件 }}</dd></div>
        <div class="full">
          <dt>接收单位（{{ notice.units.length }}）</dt>
          <dd>
            <span v-if="notice.units.length === 0" class="warn-text">空——等待分派</span>
            <ul v-else class="unit-list">
              <li v-for="unit in notice.units" :key="unit">{{ unit }}</li>
            </ul>
          </dd>
        </div>
      </dl>
    </article>

    <article class="panel">
      <h3>发布流水线</h3>
      <ol class="step-list">
        <li v-for="step in steps" :key="step.name" class="step-item" :class="stepClass(step.name)">
          <div class="step-head">
            <strong>{{ step.name }}</strong>
            <span class="step-meta">
              <template v-if="notice.stepResults[step.name]">✓ {{ notice.stepResults[step.name]?.at }}</template>
              <template v-else-if="notice.failedStep === step.name">✗ 第 {{ notice.stepAttempts[step.name] }} 次尝试中断</template>
              <template v-else>未开始（尝试 {{ notice.stepAttempts[step.name] }} 次）</template>
            </span>
          </div>
          <p class="step-desc">{{ step.desc }}</p>
          <p v-if="notice.stepResults[step.name]?.note" class="step-note">{{ notice.stepResults[step.name]?.note }}</p>
        </li>
      </ol>
    </article>

    <article class="panel">
      <h3>
        接收回执（{{ notice.receipts.length }}/{{ notice.units.length }}）
        <span v-if="abnormalCount > 0" class="error-text">含 {{ abnormalCount }} 份异常回执</span>
      </h3>
      <p v-if="notice.receipts.length === 0" class="hint">尚无回执。发布中断时已推送单位的「已送达」记录会保留在这里。</p>
      <table v-else class="data-table receipt-table">
        <thead>
          <tr><th>接收单位</th><th>状态</th><th>送达时间</th><th>确认时间</th><th>异常说明</th></tr>
        </thead>
        <tbody>
          <tr v-for="receipt in notice.receipts" :key="receipt.unit" :class="{ 'receipt-abnormal': receipt.state === '回执异常' }">
            <td>{{ receipt.unit }}</td>
            <td>{{ receipt.state }}</td>
            <td>{{ receipt.sentAt ?? '—' }}</td>
            <td>{{ receipt.acknowledgedAt ?? '—' }}</td>
            <td>
              <span v-if="receipt.state === '回执异常'" class="warn-text">{{ receipt.abnormalReason ?? '缺少异常说明（数据不完整）' }}</span>
              <span v-else class="muted-text">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </article>

    <article v-if="!terminal" class="panel">
      <h3>处置动作</h3>
      <div class="action-row">
        <button v-if="notice.status === '已发布'" class="btn primary" type="button" :disabled="running" @click="respond">登记响应</button>

        <template v-if="notice.status === '已发布' || notice.status === '已响应'">
          <input v-model="conclusion" class="conclusion-input" placeholder="填写解除结论（必填，归档后不可改）" />
          <button class="btn" type="button" :disabled="running || !conclusion.trim()" @click="release">解除预警</button>
          <input v-model="falseReason" class="conclusion-input" placeholder="标记误报需填写核实情况" />
          <button class="btn ghost" type="button" :disabled="running || !falseReason.trim()" @click="markFalse">标记误报</button>
        </template>

        <span v-if="notice.status === '待发布'" class="hint">可从右上角进入发布页确认发布。</span>
        <span v-if="notice.status === '发布失败'" class="hint">建议先查看失败现场，再从失败步骤重试。</span>
      </div>
    </article>
  </section>

  <section v-else class="page">
    <p class="error-text">未找到该预警通知，可能已被删除。</p>
    <RouterLink class="btn" to="/alarm">返回列表</RouterLink>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import {
  assignUnits,
  getAlarm,
  isPublishing,
  markFalseAlarm,
  registerResponse,
  releaseAlarm,
  startPublish,
} from '@/api/alarm-service'
import { PUBLISH_STEPS, STEP_DESCRIPTIONS, type AlarmNotice } from '@/data/alarm-types'
import { useSessionStore } from '@/stores/session'

const route = useRoute()
const session = useSessionStore()
const id = Number(route.params.id)

const notice = ref<AlarmNotice | null>(getAlarm(id))
const message = ref('')
const messageOk = ref(false)
const running = ref(isPublishing(id))
const unitInput = ref('')
const conclusion = ref('')
const falseReason = ref('')
let timer: number | undefined

const steps = PUBLISH_STEPS.map((name) => ({ name, desc: STEP_DESCRIPTIONS[name] }))
const terminal = computed(() => notice.value?.status === '已解除' || notice.value?.status === '误报')
const retryable = computed(() =>
  notice.value ? ['待发布', '发布失败', '待分派'].includes(notice.value.status) : false,
)
const abnormalCount = computed(() => notice.value?.receipts.filter((r) => r.state === '回执异常').length ?? 0)

function refresh() {
  notice.value = getAlarm(id)
  running.value = isPublishing(id)
}

function flash(text: string, ok: boolean) {
  message.value = text
  messageOk.value = ok
}

async function retry() {
  if (!notice.value) return
  const expected = notice.value.version
  running.value = true
  const result = await startPublish({
    id,
    expectedVersion: expected,
    onStep: (latest) => {
      notice.value = latest
    },
  })
  refresh()
  flash(result.message, result.ok)
}

function assign() {
  if (!notice.value) return
  const units = unitInput.value.split(/[,，、\n]/).map((u) => u.trim()).filter(Boolean)
  const result = assignUnits(id, units, notice.value.version)
  if (result.ok && result.notice) {
    notice.value = result.notice
    unitInput.value = ''
  }
  flash(result.message, result.ok)
}

function respond() {
  if (!notice.value) return
  const result = registerResponse(id, notice.value.version)
  if (result.ok && result.notice) notice.value = result.notice
  flash(result.message, result.ok)
}

function release() {
  if (!notice.value) return
  const result = releaseAlarm(id, conclusion.value, session.operator, notice.value.version)
  if (result.ok && result.notice) {
    notice.value = result.notice
    conclusion.value = ''
  }
  flash(result.message, result.ok)
}

function markFalse() {
  if (!notice.value) return
  const result = markFalseAlarm(id, falseReason.value, notice.value.version)
  if (result.ok && result.notice) {
    notice.value = result.notice
    falseReason.value = ''
  }
  flash(result.message, result.ok)
}

function statusClass(status: string): string {
  return {
    待发布: 'st-draft',
    发布失败: 'st-failed',
    待分派: 'st-dispatch',
    已发布: 'st-published',
    已响应: 'st-responded',
    已解除: 'st-closed',
    误报: 'st-false',
  }[status] ?? ''
}

function stepClass(step: string): string {
  if (!notice.value) return ''
  if (notice.value.stepResults[step as keyof AlarmNotice['stepResults']]) return 'step-done'
  if (notice.value.failedStep === step) return 'step-failed'
  return 'step-todo'
}

onMounted(() => {
  // 其它标签页/并发流程在执行发布时，本页轮询感知锁释放与数据变化。
  timer = window.setInterval(refresh, 500)
})

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer)
})
</script>

<style scoped>
.version-tag { margin-left: 8px; color: var(--muted); font-size: 12px; font-weight: 400; }
.running-tag { margin-left: 8px; font-size: 12px; color: var(--brand); }
.panel { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; }
.panel h3 { margin: 0 0 10px; font-size: 14px; }
.panel-fail { border-color: #fda29b; background: #fef3f2; }
.panel-warn { border-color: #fcd34d; background: #fffbeb; }
.panel-closed { border-color: #94a3b8; background: #f8fafc; }
.detail-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px 20px; margin: 0; }
.detail-grid .full { grid-column: 1 / -1; }
.detail-grid dt { font-size: 12px; color: var(--muted); margin-bottom: 2px; }
.detail-grid dd { margin: 0; font-size: 13px; }
.unit-list { margin: 4px 0 0; padding-left: 18px; }
.hint { color: var(--muted); font-size: 12px; margin: 6px 0; }
.warn-text { color: #b45309; }
.muted-text { color: var(--muted); }
.ok-text { color: #166534; }
.inline-message { font-size: 13px; }
.assign-row { display: flex; gap: 8px; }
.assign-row input { flex: 1; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; }
.step-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.step-item { border-left: 3px solid var(--border); padding: 4px 0 4px 12px; }
.step-done { border-left-color: #16a34a; }
.step-failed { border-left-color: #dc2626; background: #fef3f2; padding: 6px 0 6px 12px; border-radius: 0 6px 6px 0; }
.step-todo { opacity: 0.7; }
.step-head { display: flex; gap: 10px; align-items: baseline; }
.step-meta { font-size: 12px; color: var(--muted); }
.step-desc { margin: 2px 0; font-size: 12px; color: var(--muted); }
.step-note { margin: 2px 0; font-size: 12px; }
.receipt-table { font-size: 12px; }
.receipt-abnormal { background: #fffbeb; }
.action-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.conclusion-input { flex: 1; min-width: 220px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; }
.status-tag { padding: 2px 8px; border-radius: 999px; font-size: 12px; }
.st-draft { background: #e5e7eb; color: #374151; }
.st-failed { background: #fee2e2; color: #b42318; }
.st-dispatch { background: #fef3c7; color: #92400e; }
.st-published { background: #dbeafe; color: #1d4ed8; }
.st-responded { background: #dcfce7; color: #166534; }
.st-closed { background: #f1f5f9; color: #475569; }
.st-false { background: #f3e8ff; color: #7e22ce; }
</style>
