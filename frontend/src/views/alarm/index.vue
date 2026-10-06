<template>
  <section class="page" data-module="alarm">
    <header class="page-head">
      <div>
        <h2>预警发布管理</h2>
        <p class="page-desc">围绕通知编号、隐患点、预警等级与接收单位做登记、发布与状态流转。发布中断后草稿与失败原因完整保留，可从失败步骤重试。</p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn primary" to="/alarm/publish">登记预警通知</RouterLink>
        <button class="btn" type="button" @click="resetAll">恢复示例数据</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ 'error-text': item.danger }">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>通知编号</span>
        <input v-model="filters['通知编号']" placeholder="按通知编号检索" />
      </label>
      <label class="filter-item">
        <span>隐患点编号</span>
        <input v-model="filters['隐患点编号']" placeholder="按隐患点检索" />
      </label>
      <label class="filter-item">
        <span>接收单位</span>
        <input v-model="filters['接收单位']" placeholder="按接收单位检索" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table alarm-table">
      <thead>
        <tr>
          <th>通知编号</th>
          <th>隐患点编号</th>
          <th>预警等级</th>
          <th>接收单位</th>
          <th>发布人</th>
          <th>发布时间</th>
          <th>回执情况</th>
          <th>当前状态</th>
          <th>失败/异常说明</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id" :class="{ 'row-failed': row.status === '发布失败' }">
          <td>
            <RouterLink class="link" :to="`/alarm/${row.id}`">{{ row.通知编号 }}</RouterLink>
            <span class="version-tag">v{{ row.version }}</span>
          </td>
          <td>{{ row.隐患点编号 }}</td>
          <td>
            <span class="level-tag" :class="levelClass(row.预警等级)">{{ row.预警等级 }}</span>
          </td>
          <td>
            <span v-if="row.units.length">{{ row.units.length }} 个：{{ row.units.slice(0, 2).join('、') }}{{ row.units.length > 2 ? ' 等' : '' }}</span>
            <span v-else class="warn-text">空（待分派）</span>
          </td>
          <td>{{ row.发布人 }}</td>
          <td>{{ row.publishTime ?? '—' }}</td>
          <td>
            <span v-if="row.receipts.length === 0" class="muted-text">暂无回执</span>
            <span v-else>
              {{ receiptSummary(row) }}
              <span v-if="abnormalCount(row) > 0" class="error-text">（异常 {{ abnormalCount(row) }}）</span>
            </span>
          </td>
          <td><span class="status-tag" :class="statusClass(row.status)">{{ row.status }}</span></td>
          <td class="reason-cell">
            <template v-if="row.failure">
              <span class="error-text">中断于「{{ row.failedStep }}」：{{ row.failure.reason }}</span>
            </template>
            <template v-else-if="abnormalCount(row) > 0">
              <span class="warn-text">
                {{ row.receipts.find((r) => r.state === '回执异常')?.abnormalReason ?? '存在异常回执' }}
              </span>
            </template>
            <template v-else-if="row.status === '待分派'">
              <span class="warn-text">接收单位为空，等待分派后发布</span>
            </template>
            <template v-else>—</template>
          </td>
          <td class="row-actions">
            <template v-if="row.status === '发布失败'">
              <RouterLink class="link strong-link" :to="`/alarm/publish/${row.id}`">重试发布</RouterLink>
              <RouterLink class="link" :to="`/alarm/${row.id}`">详情</RouterLink>
            </template>
            <template v-else-if="row.status === '待发布'">
              <RouterLink class="link strong-link" :to="`/alarm/publish/${row.id}`">确认发布</RouterLink>
              <RouterLink class="link" :to="`/alarm/${row.id}`">详情</RouterLink>
            </template>
            <template v-else-if="row.status === '待分派'">
              <RouterLink class="link strong-link" :to="`/alarm/publish/${row.id}`">分派接收单位</RouterLink>
              <RouterLink class="link" :to="`/alarm/${row.id}`">详情</RouterLink>
            </template>
            <template v-else-if="row.status === '已发布' || row.status === '已响应'">
              <RouterLink class="link" :to="'/alarm/' + row.id">详情与处置</RouterLink>
            </template>
            <template v-else>
              <RouterLink class="link" :to="`/alarm/${row.id}`">查看结论</RouterLink>
            </template>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="10" class="empty-state">暂无预警通知，可先登记一条</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条预警通知；发布失败只保留错误标记、草稿丢失等旧问题已修复</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { alarmStats, listAlarms } from '@/api/alarm-service'
import type { AlarmNotice } from '@/data/alarm-types'
import { resetAlarms } from '@/api/alarm-service'

const rows = ref<AlarmNotice[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})

const statuses = ['待发布', '发布失败', '待分派', '已发布', '已响应', '已解除', '误报']

const statCards = computed(() => {
  const s = alarmStats()
  return [
    { label: '通知总数', value: s.total, danger: false },
    { label: '待发布/待分派', value: s.pending, danger: false },
    { label: '发布中断（可重试）', value: s.failed, danger: s.failed > 0 },
    { label: '在途未结案', value: s.active, danger: false },
    { label: '异常回执', value: s.abnormalReceipts, danger: s.abnormalReceipts > 0 },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => row.status === status).length,
  })),
)

function abnormalCount(row: AlarmNotice): number {
  return row.receipts.filter((r) => r.state === '回执异常').length
}

function receiptSummary(row: AlarmNotice): string {
  const confirmed = row.receipts.filter((r) => r.state === '已确认').length
  const delivered = row.receipts.filter((r) => r.state === '已送达').length
  const abnormal = abnormalCount(row)
  const parts = [`已收 ${row.receipts.length}/${row.units.length}`]
  if (confirmed) parts.push(`确认 ${confirmed}`)
  if (delivered) parts.push(`待确认 ${delivered}`)
  if (abnormal) parts.push(`异常 ${abnormal}`)
  return parts.join('，')
}

function levelClass(level: string): string {
  if (level.includes('红')) return 'level-red'
  if (level.includes('橙')) return 'level-orange'
  if (level.includes('黄')) return 'level-yellow'
  if (level.includes('蓝')) return 'level-blue'
  return ''
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

function resetFilters() {
  filters.value = {}
  reload()
}

function resetAll() {
  if (typeof window === 'undefined' || window.confirm('确定恢复预警通知示例数据？当前改动会被覆盖。')) {
    resetAlarms()
    reload()
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listAlarms(filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '预警通知列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.alarm-table { font-size: 12px; }
.alarm-table th, .alarm-table td { vertical-align: top; }
.version-tag { margin-left: 6px; color: var(--muted); font-size: 11px; }
.muted-text { color: var(--muted); }
.warn-text { color: #b45309; }
.row-failed { background: #fef3f2; }
.reason-cell { max-width: 260px; }
.strong-link { font-weight: 600; }
.btn { display: inline-block; text-decoration: none; line-height: 1.4; }
.level-tag { padding: 1px 8px; border-radius: 4px; font-size: 12px; }
.level-red { background: #fee2e2; color: #b42318; }
.level-orange { background: #ffedd5; color: #c2410c; }
.level-yellow { background: #fef9c3; color: #a16207; }
.level-blue { background: #dbeafe; color: #1d4ed8; }
.status-tag { padding: 2px 8px; border-radius: 999px; font-size: 12px; white-space: nowrap; }
.st-draft { background: #e5e7eb; color: #374151; }
.st-failed { background: #fee2e2; color: #b42318; }
.st-dispatch { background: #fef3c7; color: #92400e; }
.st-published { background: #dbeafe; color: #1d4ed8; }
.st-responded { background: #dcfce7; color: #166534; }
.st-closed { background: #f1f5f9; color: #475569; }
.st-false { background: #f3e8ff; color: #7e22ce; }
</style>
