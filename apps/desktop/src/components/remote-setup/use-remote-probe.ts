import { useEffect, useRef, useState } from 'react'

import type { DesktopConnectionProbeResult } from '@/global'

type ProbeStatus = 'idle' | 'probing' | 'done' | 'error'

interface RemoteProbeOptions {
  enabled: boolean
  url: string
  revision: number
  onResult: (result: DesktopConnectionProbeResult) => void
  onReset: () => void
}

interface RemoteProbe {
  probe: DesktopConnectionProbeResult | null
  probeStatus: ProbeStatus
  targetSeq: React.RefObject<number>
  invalidateProbe: () => void
  acceptProbe: (result: DesktopConnectionProbeResult) => void
}

export function useRemoteProbe({ enabled, url, revision, onResult, onReset }: RemoteProbeOptions): RemoteProbe {
  const [probe, setProbe] = useState<DesktopConnectionProbeResult | null>(null)
  const [probeStatus, setProbeStatus] = useState<ProbeStatus>('idle')
  const targetSeq = useRef<number>(0)
  const callbacks = useRef({ onResult, onReset })
  callbacks.current = { onResult, onReset }

  const invalidateProbe = (): void => {
    targetSeq.current += 1
    setProbe(null)
    setProbeStatus('idle')
  }

  const acceptProbe = (result: DesktopConnectionProbeResult): void => {
    setProbe(result)
    setProbeStatus(result.reachable ? 'done' : 'error')
    callbacks.current.onResult(result)
  }

  const acceptProbeRef = useRef(acceptProbe)
  acceptProbeRef.current = acceptProbe

  // The debounce depends on the target, not on host render callbacks.
  // eslint-disable-next-line no-restricted-syntax -- request generations, not a reactive value mirror
  useEffect(() => {
    const seq = ++targetSeq.current
    let timer: number | undefined

    const cancel = (): void => {
      targetSeq.current += 1
      window.clearTimeout(timer)
    }

    setProbe(null)
    setProbeStatus('idle')
    callbacks.current.onReset()

    if (!enabled || !window.hermesDesktop?.probeConnectionConfig) {
      return cancel
    }

    const plainHttp = /^https?:\/\//i.test(url)

    const startProbe = (): void => {
      setProbeStatus('probing')
      timer = window.setTimeout(() => {
        void window.hermesDesktop
          .probeConnectionConfig(url)
          .then(result => {
            if (seq === targetSeq.current) {
              acceptProbeRef.current(result)
            }
          })
          .catch(() => {
            if (seq === targetSeq.current) {
              setProbeStatus('error')
            }
          })
      }, 500)
    }

    if (plainHttp) {
      startProbe()

      return cancel
    }

    // Everything else (connector-scheme urls like `iroh://…`, opaque pasted
    // pairing material): MAIN owns the dialability decision — the connector
    // registry canonicalizes and answers. The renderer holds no scheme
    // vocabulary; an unclaimed scheme simply never starts probing, exactly
    // like the old regex gate. Cancel-safe: results for a moved-on target
    // are dropped by the same seq guard the probe itself uses.
    if (!window.hermesDesktop.remoteConnectors) {
      return cancel
    }

    void window.hermesDesktop.remoteConnectors
      .accepts(url)
      .then(dialable => {
        if (seq === targetSeq.current && dialable) {
          startProbe()
        }
      })
      .catch(() => {})

    return cancel
  }, [enabled, revision, url])

  return { probe, probeStatus, targetSeq, invalidateProbe, acceptProbe }
}
