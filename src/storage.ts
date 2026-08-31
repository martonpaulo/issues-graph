/**
 * Small wrapper over localStorage. Every call is guarded: Safari in private browsing and any
 * blocked-storage setting throw on access, and a viewer that only remembers preferences must not
 * fail to render because of it.
 */

export function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // A preference that cannot be remembered is not a reason to interrupt anything.
  }
}

export function clearStored(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Same reasoning as writeStored: storage being unavailable is not an error to surface.
  }
}
