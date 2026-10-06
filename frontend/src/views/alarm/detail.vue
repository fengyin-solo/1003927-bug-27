<template>
  <section class="page" data-module="alarm-detail">
    <header class="page-head">
      <div>
        <h2>预警通知详情</h2>
        <p class="page-desc">通知草稿、发布流水线、接收单位回执与解除结论都在这一页留痕。</p>
      </div>
      <div class="page-actions">
        <button class="btn ghost" type="button" @click="back">返回列表</button>
      </div>
    </header>

    <div v-if="!notice" class="empty-state">
      未找到该预警通知，可能已被重置。
      <button class="link" type="button" @click="back">返回列表</button>
    </div>

    <template v-else>
      <div class="detail-head">
        <div>
          <h3>{{ notice.code }}</h3>
          <span class="status-badge" :class="badgeClass(notice.status)">{{ notice.status }}</span>
          <span v-if="inflightIds.has(notice.id)" class="busy-tag">发布流水线执行中…</span>
        </div>
        <div class="detail-actions">
          <button
            v-if="canEdit"
            class="btn"
            type="button"
            :disabled="inflightIds.has(notice.id)"
            @click="goEdit"
          >
            编辑草稿
          </button>
          <button
            v-if="canPublish"
            class="btn primary"
            type="button"
            :disabled="inflightIds.has(notice.id)"
            @click="retryPublish"
          >
            {{ inflightIds.has(notice.id) ? '发布中…' : notice.status === '发布失败' ? `重试发布（从${notice.failedStep}继续）` : '确认发布' }}
          </button>
          <button v-if="notice.status === '已发布'" class="btn" type="button" @click="scrollTo('respond')">登记响应</button>
          <button v-if="notice.status === '已发布' || notice.status === '已响应'" class="btn primary" type="button" @click="scrollTo('release')">
            解除预警
          </button>
        </div>
      </div>

      <div v-if="notice.status === '发布失败'" id="failure" class="alert fail">
        <strong>发布失败（{{ notice.failedStep }}步骤中断）</strong>
        <p>{{ notice.failureReason }}</p>
        <p class="muted">原草稿正文与接收单位均已保留，点击「重试发布」从「{{ notice.failedStep }}」步骤继续，已完成的步骤不会重跑。</p>
      </div>
      <div v-else-if="notice.status === '待分派'" class="alert warn">
        <strong>接收单位为空，当前为待分派</strong>
        <p>该通知不是发布报错：先在下方分派接收单位，分派后即可发布。</p>
      </div>
      <div v-else-if="notice.status === '已解除'" class="alert done">
        <strong>历史解除结论（已于 {{ notice.releasedAt }} 解除）</strong>
        <p>{{ notice.releaseConclusion }}</p>
        <p class="muted">已解除通知的结论永久保留，不再进入发布流程。</p>
      </div>
      <div v-else-if="notice.status === '误报'" class="alert done">
        <strong>已认定误报</strong>
        <p>{{ notice.releaseConclusion }}</p>
      </div>

      <article class="detail-card">
        <h4>通知内容（草稿原文）</h4>
        <dl class="detail-grid">
          <div><dt>隐患点编号</dt><dd>{{ notice.hazardCode || '—' }}</dd></div>
          <div><dt>预警等级</dt><dd>{{ notice.level || '—' }}</dd></div>
          <div><dt>发布人</dt><dd>{{ notice.publisher || '—' }}</dd></div>
          <div><dt>登记时间</dt><dd>{{ notice.createdAt }}</dd></div>
          <div><dt>发布时间</dt><dd>{{ notice.publishedAt || '未发布' }}</dd></div>
          <div><dt>响应时间</dt><dd>{{ notice.respondedAt || '—' }}</dd></div>
        </dl>
        <p class="full-line"><span class="field-label">触发条件：</span>{{ notice.triggerCondition || '—' }}</p>
        <p class="full-line draft-box"><span class="field-label">通知正文：</span>{{ notice.draftContent || '（草稿正文为空）' }}</p>
        <p v-if="notice.responseNote" class="full-line"><span class="field-label">响应处置：</span>{{ notice.responseNote }}</p>
      </article>

      <article class="detail-card">
        <h4>
          接收单位与回执
          <span class="muted small">（接收单位名称含「测试异常」时模拟异常回执）</span>
        </h4>
        <div v-if="!recipientUnits.length" class="alert warn inline">
          暂无接收单位：通知处于待分派，请先分派后再发布。
        </div>
        <table v-else class="data-table">
          <thead>
            <tr><th>接收单位</th><th>回执状态</th><th>回执时间</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="receipt in receiptRows" :key="receipt.unit">
              <td>{{ receipt.unit }}</td>
              <td>
                <span class="receipt-state" :class="receipt.state === '异常回执' ? 'state-abnormal' : receipt.state === '已接收' ? 'state-ok' : 'state-pending'">
                  {{ receipt.state }}
                </span>
              </td>
              <td>{{ receipt.receivedAt || '—' }}</td>
              <td>{{ receipt.note || (receipt.state === '异常回执' ? '回执异常，待核实' : '—') }}</td>
            </tr>
          </tbody>
        </table>

        <div v-if="notice.status === '待分派'" id="dispatch" class="action-panel">
          <h5>分派接收单位</h5>
          <textarea v-model="dispatchText" rows="3" placeholder="每行一个接收单位，也可用逗号、顿号分隔"></textarea>
          <div class="panel-foot">
            <button class="btn primary" type="button" :disabled="inflightIds.has(notice.id)" @click="submitDispatch">分派并进入待发布</button>
          </div>
        </div>
      </article>

      <article class="detail-card">
        <h4>发布流水线记录</h4>
        <ol v-if="notice.stepLogs.length" class="step-list">
          <li v-for="(log, index) in notice.stepLogs" :key="index" :class="log.ok ? 'step-ok' : 'step-fail'">
            <span class="step-name">{{ log.step }}</span>
            <span class="step-time">{{ log.at }}</span>
            <span class="step-msg">{{ log.message }}</span>
          </li>
        </ol>
        <p v-else class="muted">尚未执行发布。</p>
      </article>

      <article v-if="notice.status === '已发布'" id="respond" class="detail-card action-panel">
        <h5>登记响应</h5>
        <textarea v-model="responseNote" rows="3" placeholder="记录现场响应、转移人数、处置措施等"></textarea>
        <div class="panel-foot">
          <button class="btn primary" type="button" :disabled="inflightIds.has(notice.id)" @click="submitResponse">提交响应登记</button>
        </div>
      </article>

      <article
        v-if="notice.status === '已发布' || notice.status === '已响应'"
        id="release"
        class="detail-card action-panel"
      >
        <h5>解除预警</h5>
        <p class="muted small">解除结论提交后永久保留，通知再次进入时仍显示该结论，不会退回待发布。</p>
        <textarea v-model="releaseConclusion" rows="3" placeholder="填写解除依据，如现场核查情况、监测数据变化、后续监测安排"></textarea>
        <div class="panel-foot">
          <button class="btn primary" type="button" :disabled="inflightIds.has(notice.id)" @click="submitRelease">确认解除并归档</button>
        </div>
      </article>

      <article
        v-if="!['已解除', '误报', '发布中'].includes(notice.status)"
        class="detail-card action-panel"
      >
        <h5>认定误报</h5>
        <div class="panel-foot false-row">
          <input v-model="falseReason" placeholder="误报判定依据" />
          <button class="btn" type="button" :disabled="inflightIds.has(notice.id)" @click="submitFalse">标记误报</button>
        </div>
      </article>

      <footer class="page-foot">
        <span v-if="flash" :class="flash.ok ? 'success-text' : 'error-text'">{{ flash.text }}</span>
      </footer>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import {
  dispatchRecipients,
  getNotice,
  inflightIds,
  markFalseAlarm,
  publishNotice,
  recordResponse,
  releaseNotice,
  splitRecipients,
} from '@/data/alarm/store'
import type { AlarmNotice, AlarmStatus, Receipt } from '@/data/alarm/types'

const route = useRoute()
const router = useRouter()
const id = Number(route.params.id)

const notice = ref<AlarmNotice | undefined>(getNotice(id))
const dispatchText = ref('')
const responseNote = ref('')
const releaseConclusion = ref('')
const falseReason = ref('')
const flash = ref<{ ok: boolean; text: string } | null>(null)
let pollTimer: ReturnType<typeof setInterval> | undefined
let flashTimer: ReturnType<typeof setTimeout> | undefined

const recipientUnits = computed(() => (notice.value ? splitRecipients(notice.value.recipientsText) : []))

/** 已产生的回执按当前接收单位顺序展示，单位被调整时不会残留错位回执 */
const receiptRows = computed<Receipt[]>(() => {
  if (!notice.value) {
    return []
  }
  const byUnit = new Map(notice.value.receipts.map((receipt) => [receipt.unit, receipt]))
  return recipientUnits.value.map((unit) => byUnit.get(unit) ?? { unit, state: '待接收', note: '', receivedAt: '' })
})

const canEdit = computed(() =>
  notice.value ? ['草稿', '待发布', '待分派', '发布失败'].includes(notice.value.status) : false,
)
const canPublish = computed(() =>
  notice.value ? ['待发布', '发布失败'].includes(notice.value.status) : false,
)

function badgeClass(status: AlarmStatus): string {
  if (status === '发布失败') return 'badge-fail'
  if (status === '发布中') return 'badge-busy'
  if (status === '待分派') return 'badge-warn'
  if (status === '已发布' || status === '已响应') return 'badge-ok'
  if (status === '已解除' || status === '误报') return 'badge-done'
  return 'badge-idle'
}

function showFlash(ok: boolean, text: string) {
  flash.value = { ok, text }
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    flash.value = null
  }, 6000)
}

function refresh() {
  notice.value = getNotice(id)
  if (notice.value) {
    if (!dispatchText.value || notice.value.status !== '待分派') {
      dispatchText.value = notice.value.recipientsText
    }
  }
}

function back() {
  router.push('/alarm')
}

function goEdit() {
  router.push(`/alarm/${id}/edit`)
}

function scrollTo(hash: string) {
  const target = document.getElementById(hash)
  target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  target?.classList.add('panel-highlight')
  setTimeout(() => target?.classList.remove('panel-highlight'), 1600)
}

async function retryPublish() {
  if (!notice.value) {
    return
  }
  const result = await publishNotice(id)
  showFlash(result.ok, result.message)
  refresh()
}

function submitDispatch() {
  const result = dispatchRecipients(id, dispatchText.value)
  showFlash(result.ok, result.message)
  refresh()
}

function submitResponse() {
  const result = recordResponse(id, responseNote.value)
  if (result.ok) {
    responseNote.value = ''
  }
  showFlash(result.ok, result.message)
  refresh()
}

function submitRelease() {
  const result = releaseNotice(id, releaseConclusion.value)
  if (result.ok) {
    releaseConclusion.value = ''
  }
  showFlash(result.ok, result.message)
  refresh()
}

function submitFalse() {
  const result = markFalseAlarm(id, falseReason.value)
  if (result.ok) {
    falseReason.value = ''
  }
  showFlash(result.ok, result.message)
  refresh()
}

onMounted(() => {
  refresh()
  if (route.hash === '#dispatch' || route.hash === '#respond' || route.hash === '#release') {
    setTimeout(() => scrollTo(route.hash.slice(1)), 300)
  }
  pollTimer = setInterval(() => {
    if (inflightIds.has(id)) {
      refresh()
    }
  }, 700)
})

onUnmounted(() => {
  clearInterval(pollTimer)
  clearTimeout(flashTimer)
})
</script>

<style scoped>
.detail-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 12px;
}
.detail-head h3 { margin: 0 0 6px; }
.detail-actions { display: flex; gap: 8px; }
.status-badge {
  display: inline-block;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
}
.badge-idle { background: #eef2f7; color: #475569; }
.badge-busy { background: #e0f2fe; color: #0369a1; }
.badge-warn { background: #fef3c7; color: #92400e; }
.badge-fail { background: #fee2e2; color: #b42318; }
.badge-ok { background: #dcfce7; color: #166534; }
.badge-done { background: #f1f5f9; color: #334155; }
.busy-tag { margin-left: 8px; color: #0369a1; font-size: 12px; }
.alert { border-radius: 8px; padding: 10px 14px; margin-bottom: 12px; font-size: 13px; border: 1px solid; }
.alert strong { display: block; margin-bottom: 4px; }
.alert p { margin: 4px 0; }
.alert.fail { background: #fef2f2; border-color: #fecaca; color: #991b1b; }
.alert.warn { background: #fffbeb; border-color: #fde68a; color: #92400e; }
.alert.done { background: #f8fafc; border-color: #cbd5e1; color: #334155; }
.alert.inline { margin: 8px 0; }
.detail-card {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 12px;
}
.detail-card h4 { margin: 0 0 10px; }
.detail-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px 20px;
  margin: 0 0 8px;
}
.detail-grid dt { font-size: 12px; color: var(--muted); }
.detail-grid dd { margin: 2px 0 0; }
.full-line { margin: 6px 0; font-size: 13px; }
.field-label { color: var(--muted); }
.draft-box { background: #f8fafc; border-radius: 6px; padding: 8px 10px; }
.receipt-state { border-radius: 999px; padding: 1px 8px; font-size: 12px; }
.state-ok { background: #dcfce7; color: #166534; }
.state-pending { background: #eef2f7; color: #475569; }
.state-abnormal { background: #fef3c7; color: #b45309; }
.step-list { list-style: none; margin: 0; padding: 0; }
.step-list li {
  display: grid;
  grid-template-columns: 56px 140px 1fr;
  gap: 10px;
  padding: 6px 8px;
  border-left: 3px solid;
  margin-bottom: 6px;
  background: #f8fafc;
  font-size: 13px;
}
.step-ok { border-color: #16a34a; }
.step-fail { border-color: #dc2626; background: #fef2f2 !important; }
.step-name { font-weight: 600; }
.step-time { color: var(--muted); }
.action-panel textarea,
.action-panel input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  font: inherit;
  box-sizing: border-box;
}
.panel-foot { margin-top: 8px; display: flex; justify-content: flex-end; }
.false-row { gap: 8px; }
.false-row input { flex: 1; }
.muted { color: var(--muted); }
.small { font-size: 12px; font-weight: 400; }
.success-text { color: #166534; }
.panel-highlight { outline: 2px solid var(--brand); outline-offset: 4px; transition: outline 0.3s; }
.btn:disabled { color: #94a3b8; cursor: not-allowed; }
</style>
