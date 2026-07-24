import type { DevToolsConfig } from '../shared'
import { devToolsConfigSchema } from '../../shared/devtools-config-schema'
import { deepMerge } from '../../shared/deepmerge'

let queuedConfigPatch: DevToolsConfig = {}
let timer: ReturnType<typeof setTimeout> | null = null

function flushPatch() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }

  if (Object.keys(queuedConfigPatch).length === 0) {
    return
  }

  const body = JSON.stringify(queuedConfigPatch)
  queuedConfigPatch = {}

  fetch('/__nextjs_devtools_config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    // keepalive in case of fetch interrupted, e.g. navigation or reload
    keepalive: true,
  }).catch((error) => {
    console.warn('[Next.js DevTools] Failed to save config:', {
      data: body,
      error,
    })
  })
}

export function saveDevToolsConfig(patch: DevToolsConfig) {
  const validation = devToolsConfigSchema.safeParse(patch)
  if (!validation.success) {
    console.warn(
      '[Next.js DevTools] Invalid config patch:',
      validation.error.message
    )
    return
  }

  queuedConfigPatch = deepMerge(queuedConfigPatch, patch)

  if (timer) {
    clearTimeout(timer)
  }

  timer = setTimeout(flushPatch, 120)
}

if (typeof window !== 'undefined') {
  // Flush any pending patch before the page goes away (e.g. reload or
  // navigation) so a toggle right before a refresh isn't lost. The fetch in
  // flushPatch uses keepalive, so it survives page teardown.
  window.addEventListener('pagehide', flushPatch)
}
