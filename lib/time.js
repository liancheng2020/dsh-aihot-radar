// Shared wall-clock helpers (timezone-aware) for digest scheduling and radar
// quiet hours. Default tz is Asia/Shanghai; callers may pass an IANA zone.

export const DEFAULT_TZ = 'Asia/Shanghai'

export function validTz(tz) {
  if (!tz || typeof tz !== 'string') return false
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true } catch { return false }
}

export function resolveTz(tz, logger) {
  if (validTz(tz)) return tz
  if (tz) logger?.warn?.(`时区 "${tz}" 非法，回落 ${DEFAULT_TZ}`)
  return DEFAULT_TZ
}

// Wall-clock date/minutes in the given zone. hour12:false can yield "24" at
// midnight in some engines; normalize to 0.
export function tzParts(now = new Date(), tz = DEFAULT_TZ) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]))
  const date = `${parts.year}-${parts.month}-${parts.day}`
  const hour = Number(parts.hour === '24' ? '0' : parts.hour)
  const minute = Number(parts.minute)
  return { date, hour, minute, minutes: hour * 60 + minute }
}

// Validate HH:mm; illegal values fall back to 08:30 with a warning.
export function validateTime(time, logger) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''))
  if (m) {
    const h = Number(m[1]), mm = Number(m[2])
    if (h >= 0 && h <= 23 && mm >= 0 && mm <= 59) return `${String(h).padStart(2, '0')}:${m[2]}`
  }
  logger?.warn?.(`time 非法值 "${time}"，回落 08:30`)
  return '08:30'
}

const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''))
  if (!m) return null
  const h = Number(m[1]), mm = Number(m[2])
  if (h > 23 || mm > 59) return null
  return h * 60 + mm
}

// Milliseconds until the next occurrence of HH:mm in the given zone.
export function msUntilNext(timeHHmm, now = new Date(), tz = DEFAULT_TZ) {
  const [h, m] = String(timeHHmm).split(':').map(Number)
  const hh = Number.isFinite(h) ? Math.min(23, Math.max(0, h)) : 8
  const mm = Number.isFinite(m) ? Math.min(59, Math.max(0, m)) : 30
  const target = hh * 60 + mm
  const { minutes } = tzParts(now, tz)
  let deltaMin = target - minutes
  if (deltaMin <= 0) deltaMin += 24 * 60
  const sec = now.getSeconds() * 1000 + now.getMilliseconds()
  return deltaMin * 60 * 1000 - sec
}

// Quiet-hours window (supports overnight wrap). Empty start/end = disabled.
// During quiet hours radar defers (does not drop) notifications.
export function isQuietNow(quiet, now = new Date(), tz = DEFAULT_TZ) {
  const s = toMin(quiet?.start), e = toMin(quiet?.end)
  if (s == null || e == null || s === e) return false
  const { minutes } = tzParts(now, tz)
  return s < e ? (minutes >= s && minutes < e) : (minutes >= s || minutes < e)
}
