import { Suspense } from 'react'
import { cookies } from 'next/headers'
import { cacheLife, cacheTag, unstable_cache } from 'next/cache'

// Cross-render divergence fixture: the tree's static-prefetch hint is
// computed per render, so a client that cached a route tree response from an
// old (clean) render can attempt a static prefetch against a fresh render
// that DOES access runtime data. This page lets the consuming test flip the
// route between those two generations on demand, via cache revalidation:
//
// - `getCurrentToken` is a long-lived cached random value tagged
//   'diverge-cookies'. Its stale time is above the shell threshold, so it
//   resolves during the SHELL stage of a static prerender.
// - `getCapturedToken` is a long-lived captured copy of the same value. The
//   capture is wrapped in `unstable_cache`, which acts as a tag-propagation
//   boundary: the tags of caches read inside it do NOT attach to the
//   captured entry. Revalidating 'diverge-cookies' therefore recomputes the
//   current token while the captured copy keeps the old value.
// - While the two tokens are EQUAL (computed in the same render pass — at
//   build, or after a reset), the render is clean: no runtime data is
//   accessed, and the route's tree response carries the static-prefetch
//   hint.
// - When the test revalidates 'diverge-cookies' (via /api/diverge), the next
//   regeneration recomputes the current token, the pair becomes UNEQUAL, and
//   the render reads cookies() in the shell stage. Because the access
//   happens during the shell stage, the static response's shell variant is
//   insufficient — it signals that a runtime request would return more —
//   which forces the runtime fallback.
// - Revalidating BOTH tags (/api/diverge?...&reset=1) resets the pair: the
//   captured copy recomputes and captures the fresh current token, so the
//   pair is equal (clean) again. The consuming test resets at the start to
//   be retry-safe.
//
// Regenerations only happen on the test's cue: prefetch requests (tree and
// per-segment) are served from the route cache without triggering an ISR
// revalidation; only page requests do. The `generation:` marker below lets
// the test observe with a plain page fetch which generation the server is
// currently serving.

async function getCurrentToken(): Promise<number> {
  'use cache'
  cacheTag('diverge-cookies')
  cacheLife({ stale: 3600, revalidate: 3600, expire: 3600 })
  return Math.random()
}

const getCapturedToken = unstable_cache(
  async (): Promise<number> => getCurrentToken(),
  ['diverge-cookies-captured'],
  { tags: ['diverge-cookies-captured'], revalidate: false }
)

// Renders which generation the server is serving, without reading any
// runtime data — so it's visible in the static output (and to the test's
// plain page fetches) in both generations.
async function GenerationMarker() {
  // Await the plain cached token BEFORE the unstable_cache-captured copy: the
  // direct call is what populates the prerender resume data cache during the
  // cache-warming phase, and an unstable_cache lookup may resolve after that
  // phase has ended, so anything awaited after it would miss warming.
  const current = await getCurrentToken()
  const captured = await getCapturedToken()
  return (
    <p id="generation-marker">
      {captured === current ? 'generation: clean' : 'generation: diverged'}
    </p>
  )
}

async function SessionContent() {
  // Await the plain cached token BEFORE the unstable_cache-captured copy: the
  // direct call is what populates the prerender resume data cache during the
  // cache-warming phase, and an unstable_cache lookup may resolve after that
  // phase has ended, so anything awaited after it would miss warming.
  const current = await getCurrentToken()
  const captured = await getCapturedToken()
  if (captured !== current) {
    // Diverged generation: the current token has been revalidated apart from
    // the captured copy. Read cookies, which records a runtime-data access
    // in the shell stage.
    const cookieStore = await cookies()
    const value = cookieStore.get('testCookie')?.value ?? 'none'
    return <div id="divergent-session">{`Divergent cookie: ${value}`}</div>
  }
  // Clean generation: the tokens were computed together, so no runtime data
  // is accessed and the render is clean.
  return <div id="divergent-session">Divergent cookie: not-read</div>
}

export default function Page() {
  return (
    <main>
      <p id="page-content">Divergent-cookies page shell text</p>
      <GenerationMarker />
      <Suspense
        fallback={<p id="divergent-loading">Loading divergent session...</p>}
      >
        <SessionContent />
      </Suspense>
    </main>
  )
}
