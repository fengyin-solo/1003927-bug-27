import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'geohazard-monitor-prevention:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

/** 读取领域专属集合（结构比通用 EntryRow 复杂时使用），缺省回落到播种值。 */
export function loadCollection<T>(key: string, seed: T[]): T[] {
  const rows = allRows()[key] as unknown as T[] | undefined
  return rows ?? (clone(seed) as T[])
}

/**
 * 整集合原子落库：内存缓存与 localStorage 一次写完，失败抛错不改缓存。
 * 成功/失败数据不允许只写一半，调用方必须先在内存里拼好完整下一版再写入。
 */
export function saveCollection<T>(key: string, rows: T[]): void {
  const next = { ...allRows(), [key]: rows } as Record<string, EntryRow[]>
  if (typeof window !== 'undefined' && window.localStorage) {
    // 先写持久层成功后再换内存缓存，避免出现「内存已改、落库失败」的半写状态。
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  cache = next
}

export function saveRows(key: string, rows: EntryRow[]): void {
  saveCollection(key, rows)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
