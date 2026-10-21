import { useEffect, useRef, useState } from 'react'

export function useInterval(callback: () => void, delayMs: number | null) {
  const cbRef = useRef(callback)
  cbRef.current = callback

  useEffect(() => {
    if (delayMs == null) return
    const id = window.setInterval(() => cbRef.current(), delayMs)
    return () => window.clearInterval(id)
  }, [delayMs])
}

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(id)
  }, [value, delayMs])
  return debounced
}
