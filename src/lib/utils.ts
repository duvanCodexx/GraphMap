export function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

export function formatSeconds(s: number | null): string {
  if (s == null || Number.isNaN(s)) return '-'
  const total = Math.max(0, Math.floor(s))
  const hh = Math.floor(total / 3600)
  const mm = Math.floor((total % 3600) / 60)
  const ss = total % 60
  if (hh > 0) return `${hh}h ${String(mm).padStart(2, '0')}m ${String(ss).padStart(2, '0')}s`
  if (mm > 0) return `${mm}m ${String(ss).padStart(2, '0')}s`
  return `${ss}s`
}

export function ellipsisMiddle(s: string, max: number): string {
  if (s.length <= max) return s
  const keep = Math.max(4, Math.floor((max - 3) / 2))
  return `${s.slice(0, keep)}...${s.slice(-keep)}`
}

export function copyToClipboard(text: string): Promise<void> {
  return navigator.clipboard.writeText(text)
}

export function formatTimeAgo(ts: number | null | undefined): string {
  if (!ts) return ''
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 5) return 'justo ahora'
  if (diffSec < 60) return `hace ${diffSec}s`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `hace ${diffMin}m`
  const diffHours = Math.floor(diffMin / 60)
  return `hace ${diffHours}h`
}

