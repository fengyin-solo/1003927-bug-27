<template>
  <section class="page alarm-publish">
    <header class="page-head">
      <div>
        <h2>{{ pageTitle }}</h2>
        <p class="page-desc">{{ pageDesc }}</p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" :to="notice ? `/alarm/${notice.id}` : '/alarm'">返回</RouterLink>
      </div>
    </header>

    <p v-if="message" class="inline-message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</p>

    <!-- 失败现场：重试页顶部明确失败步骤与原因，说明从哪里继续 -->
    <article v-if="notice?.failure" class="panel panel-fail">
      <h3>上次发布中断（重试将从该步骤继续）</h3>
      <p class="fail-line">
        中断步骤：<strong>{{ notice.failure.failedStep }}</strong>
        （第 {{ notice.failure.attemptsAtStep }} 次尝试）· {{ notice.failure.failedAt }}
      </p>
      <p class="error-text">{{ notice.failure.reason }}</p>
      <p class="hint">原草稿、接收单位清单和已推送回执均已保留；已完成步骤不会重复执行。</p>
    </article>

    <form class="panel form-panel" @submit.prevent="save">
      <h3>{{ notice ? '编辑通知草稿' : '登记通知草稿' }}</h3>
      <div class="form-grid">
        <label class="form-item">
          <span>通知编号 *</span>
          <input v-model="form.通知编号" :disabled="locked" placeholder="如 ALAR-2026-009" />
        </label>
        <label class="form-item">
          <span>隐患点编号 *</span>
          <input v-model="form.隐患点编号" :disabled="locked" placeholder="如 HAZA-0001" />
        </label>
        <label class="form-item">
          <span>预警等级 *</span>
          <select v-model="form.预警等级" :disabled="locked">
            <option value="">请选择</option>
            <option>蓝色预警</option>
            <option>黄色预警</option>
            <option>橙色预警</option>
            <option>红色预警</option>
          </select>
        </label>
        <label class="form-item">
          <span>发布人 *</span>
          <input v-model="form.发布人" :disabled="locked" />
        </label>
        <label class="form-item full">
          <span>触发条件 *</span>
          <textarea v-model="form.触发条件" :disabled="locked" rows="2" placeholder="说明触发预警的监测/巡查依据"></textarea>
        </label>
        <label class="form-item full">
          <span>
            接收单位（留空 = 待分派，不会报错）
            <em v-if="form.units.length === 0" class="warn-text">当前为空，保存后进入「待分派」</em>
          </span>
          <textarea v-model="unitsText" :disabled="locked" rows="2" placeholder="多个单位用逗号或顿号分隔，如：枫树坪村委会、镇应急办"></textarea>
          <small class="hint">当前解析出 {{ form.units.length }} 个单位；发布中断后该清单原样保留。</small>
        </label>
      </div>
      <div class="form-actions">
        <button class="btn primary" type="submit" :disabled="running || locked">
          {{ notice ? '保存草稿修改' : '保存草稿' }}
        </button>
        <button v-if="notice && notice.status === '待分派'" class="btn" type="button" :disabled="running || !form.units.length" @click="assign">
          分派接收单位
        </button>
      </div>
    </form>

    <!-- 演练用故障注入：验证中断保留、断点续跑、异常回执说明 -->
    <details v-if="notice && retryable" class="panel drill-panel">
      <summary>故障演练注入（可选）</summary>
      <p class="hint">仅用于演练：在指定步骤的第 N 次尝试制造一次中断或异常回执，验证失败保留与重试行为。不设置则全部成功。</p>
      <div class="drill-row">
        <label>
          作用步骤
          <select v-model="drill.step">
            <option v-for="step in steps" :key="step" :value="step">{{ step }}</option>
          </select>
        </label>
        <label>
          第几次尝试触发
          <input v-model.number="drill.attempt" type="number" min="1" max="9" />
        </label>
        <label>
          故障类型
          <select v-model="drill.kind">
            <option value="interrupt">链路中断</option>
            <option value="abnormal-receipt">异常回执</option>
          </select>
        </label>
        <label class="drill-reason">
          故障描述（中断可带接收单位名以精确定位；异常回执需包含目标单位名）
          <input v-model="drill.reason" placeholder="如：推送至「镇应急办」时通讯链路中断" />
        </label>
      </div>
    </details>

    <!-- 发布动作与流水线实时进度 -->
    <article v-if="notice" class="panel">
      <h3>发布执行</h3>
      <div class="form-actions">
        <button
          v-if="retryable"
          class="btn primary"
          type="button"
          :disabled="running"
          @click="publish"
        >
          {{ running ? '发布执行中…' : publishButtonText }}
        </button>
        <span v-if="notice.status === '待分派'" class="hint">需先分派接收单位，分派成功后即可发布。</span>
        <span v-else-if="terminal" class="hint">通知已结案（{{ notice.status }}），历史结论保留，不能再次发布。</span>
        <span v-else-if="notice.status === '已发布' || notice.status === '已响应'" class="hint">通知已发布，可在详情页登记响应或解除。</span>
      </div>

      <ol class="step-list">
        <li v-for="step in steps" :key="step" class="step-item" :class="liveStepClass(step)">
          <div class="step-head">
            <strong>{{ step }}</strong>
            <span class="step-meta">
              <template v-if="notice.stepResults[step]">✓ 完成 {{ notice.stepResults[step]?.at }}</template>
              <template v-else-if="running && currentStep === step">执行中…（第 {{ notice.stepAttempts[step] + 1 }} 次尝试）</template>
              <template v-else-if="notice.failedStep === step">✗ 中断于第 {{ notice.failure?.attemptsAtStep }} 次尝试</template>
              <template v-else>未开始</template>
            </span>
          </div>
          <p class="step-note" v-if="notice.stepResults[step]?.note">{{ notice.stepResults[step]?.note }}</p>
        </li>
      </ol>
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import {
  assignUnits,
  getAlarm,
  isPublishing,
  saveDraft,
  startPublish,
} from '@/api/alarm-service'
import { PUBLISH_STEPS, type FaultInjection, type PublishStep } from '@/data/alarm-types'

const route = useRoute()
const router = useRouter()
const id = route.params.id ? Number(route.params.id) : null

const steps = PUBLISH_STEPS
const notice = ref(id ? getAlarm(id) : null)
const running = ref(id ? isPublishing(id) : false)
const currentStep = ref<PublishStep | null>(null)
const message = ref('')
const messageOk = ref(false)
let timer: number | undefined

const form = reactive({
  通知编号: notice.value?.通知编号 ?? '',
  隐患点编号: notice.value?.隐患点编号 ?? '',
  预警等级: notice.value?.预警等级 ?? '',
  触发条件: notice.value?.触发条件 ?? '',
  发布人: notice.value?.发布人 ?? '值班管理员',
  units: notice.value ? [...notice.value.units] : [],
})
const unitsText = ref(notice.value?.units.join('、') ?? '')

const drill = reactive<{ step: PublishStep; attempt: number; kind: 'interrupt' | 'abnormal-receipt'; reason: string }>({
  step: '推送接收单位',
  attempt: 1,
  kind: 'interrupt',
  reason: '推送至「镇应急办」时通讯链路中断（网关超时 30s）',
})

watch(unitsText, (text) => {
  form.units = text.split(/[,，、\n]/).map((u) => u.trim()).filter(Boolean)
})

const locked = computed(() =>
  notice.value ? notice.value.status === '已发布' || notice.value.status === '已响应' || notice.value.status === '已解除' || notice.value.status === '误报' : false,
)
const terminal = computed(() => notice.value?.status === '已解除' || notice.value?.status === '误报')
const retryable = computed(() =>
  notice.value ? ['待发布', '发布失败', '待分派'].includes(notice.value.status) : false,
)

const pageTitle = computed(() => {
  if (!notice.value) return '登记预警通知'
  if (notice.value.status === '发布失败') return '重试发布预警通知'
  if (notice.value.status === '待分派') return '分派接收单位并发布'
  return `发布预警通知 · ${notice.value.通知编号}`
})
const pageDesc = computed(() => {
  if (!notice.value) return '先保存草稿；接收单位可以留空，留空会进入待分派而不是报错。'
  if (notice.value.failure) return '发布曾中断，草稿和失败原因已保留，重试从失败步骤继续。'
  return '确认通知内容与接收单位后发起发布；成功与失败数据均按整版本原子落库。'
})
const publishButtonText = computed(() => {
  if (!notice.value) return '保存草稿后发布'
  if (notice.value.status === '发布失败') return `从「${notice.value.failedStep}」重试发布`
  if (notice.value.status === '待分派') return '分派后发布'
  return '确认发布'
})

function flash(text: string, ok: boolean) {
  message.value = text
  messageOk.value = ok
}

function save() {
  const result = saveDraft({ ...form, id: id ?? undefined })
  if (!result.ok) {
    flash(result.message, false)
    return
  }
  if (!id && result.notice) {
    // 新建草稿后跳到该草稿的发布页，继续分派/发布。
    router.replace(`/alarm/publish/${result.notice.id}`)
    return
  }
  if (result.notice) notice.value = result.notice
  flash(result.message, true)
}

function assign() {
  if (!notice.value) return
  const result = assignUnits(notice.value.id, form.units, notice.value.version)
  if (result.ok && result.notice) {
    notice.value = result.notice
    flash(result.message, true)
  } else {
    flash(result.message, false)
  }
}

function buildFaults(): FaultInjection[] {
  if (!drill.reason.trim()) return []
  return [{ step: drill.step, triggerAttempt: drill.attempt, kind: drill.kind, reason: drill.reason.trim() }]
}

async function publish() {
  if (!notice.value) return
  if (form.通知编号 !== notice.value.通知编号 || form.触发条件 !== notice.value.触发条件) {
    // 允许直接发布未保存修改：先存一次再发。
    const saved = saveDraft({ ...form, id: notice.value.id })
    if (!saved.ok || !saved.notice) {
      flash(saved.message, false)
      return
    }
    notice.value = saved.notice
  }
  const expected = notice.value.version
  running.value = true
  currentStep.value = notice.value.failedStep ?? firstUnfinishedStep(notice.value)
  const result = await startPublish({
    id: notice.value.id,
    expectedVersion: expected,
    faultInjections: buildFaults(),
    onStep: (latest) => {
      notice.value = latest
      currentStep.value = latest.failedStep ?? firstUnfinishedStep(latest)
    },
  })
  if (result.notice) notice.value = result.notice
  currentStep.value = null
  running.value = false
  flash(result.message, result.ok)
}

function liveStepClass(step: PublishStep): string {
  if (!notice.value) return 'step-todo'
  if (notice.value.stepResults[step]) return 'step-done'
  if (running && currentStep.value === step) return 'step-running'
  if (notice.value.failedStep === step) return 'step-failed'
  return 'step-todo'
}

function firstUnfinishedStep(n: { stepResults: Record<string, unknown> }): PublishStep | null {
  return PUBLISH_STEPS.find((step) => !n.stepResults[step]) ?? null
}

function refresh() {
  if (id) {
    const latest = getAlarm(id)
    if (latest && (!notice.value || latest.version !== notice.value.version)) {
      notice.value = latest
    }
    running.value = isPublishing(id)
  }
}

onMounted(() => {
  timer = window.setInterval(refresh, 500)
})
onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer)
})
</script>

<style scoped>
.panel { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; }
.panel h3 { margin: 0 0 10px; font-size: 14px; }
.panel-fail { border-color: #fda29b; background: #fef3f2; }
.drill-panel { font-size: 13px; }
.fail-line { margin: 4px 0; font-size: 13px; }
.inline-message { font-size: 13px; }
.ok-text { color: #166534; }
.warn-text { color: #b45309; font-style: normal; }
.hint { color: var(--muted); font-size: 12px; margin: 4px 0; }
.form-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px 14px; }
.form-item { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
.form-item.full { grid-column: 1 / -1; }
.form-item input, .form-item textarea, .form-item select { padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px; color: #1f2937; }
.form-item input:disabled, .form-item textarea:disabled, .form-item select:disabled { background: #f1f5f9; }
.form-actions { display: flex; gap: 8px; margin-top: 12px; align-items: center; flex-wrap: wrap; }
.drill-row { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }
.drill-row label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
.drill-row select, .drill-row input { padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; min-width: 140px; }
.drill-reason { flex: 1; min-width: 260px; }
.step-list { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.step-item { border-left: 3px solid var(--border); padding: 4px 0 4px 12px; }
.step-done { border-left-color: #16a34a; }
.step-failed { border-left-color: #dc2626; background: #fef3f2; padding: 6px 0 6px 12px; border-radius: 0 6px 6px 0; }
.step-running { border-left-color: var(--brand); background: #eff6ff; padding: 6px 0 6px 12px; border-radius: 0 6px 6px 0; }
.step-todo { opacity: 0.65; }
.step-head { display: flex; gap: 10px; align-items: baseline; }
.step-meta { font-size: 12px; color: var(--muted); }
.step-note { margin: 2px 0; font-size: 12px; }
</style>
