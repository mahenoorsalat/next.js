import { Suspense } from 'react'
import { cookies } from 'next/headers'
import { connection } from 'next/server'
import { cacheLife, cacheTag, unstable_cache } from 'next/cache'

// The post-shell variant of the divergent-cookies fixture, for testing that
// a segment's shell-sufficiency is decided by WHEN during the render the
// runtime-data access happened. Same token-pair divergence mechanism (see
// app/divergent-cookies/page.tsx for the full explanation of the tagged
// current token, the unstable_cache-captured copy, and the /api/diverge
// endpoint that flips and resets the pair), with one addition: the token
// comparison — and therefore the cookies() access on diverged generations —
// is gated behind `getDelayedGate`, a cached entry whose stale time (60
// seconds) is below the 5 minute shell threshold but above the 30 second
// prefetchable minimum. During a static prerender such an entry is delayed
// to resolve in the POST-shell stage, so the cookies() access is recorded
// AFTER the shell stage:
//
// - The full static response records the runtime-data access, but only in
//   the portion past the shell boundary.
// - The shell variant of the response — which covers only what rendered
//   during the shell stage — therefore reads as clean: the SHELL doesn't
//   depend on runtime data even though the full page does.
//
// So a static shell attempt against a diverged generation should be accepted
// with no runtime fallback, despite the full response recording the access.

async function getDelayedGate(): Promise<string> {
  'use cache'
  // stale is below the shell threshold (300) but still prefetchable (>= 30):
  // during a static prerender this entry only resolves after the shell stage.
  cacheLife({ stale: 60, revalidate: 3600, expire: 3600 })
  return 'after-shell gate content'
}

async function getCurrentToken(): Promise<number> {
  'use cache'
  cacheTag('diverge-after-shell')
  cacheLife({ stale: 3600, revalidate: 3600, expire: 3600 })
  return Math.random()
}

const getCapturedToken = unstable_cache(
  async (): Promise<number> => getCurrentToken(),
  ['diverge-after-shell-captured'],
  { tags: ['diverge-after-shell-captured'], revalidate: false }
)

// A connection()-gated hole whose only purpose is to make this route a
// PARTIAL prerender at build time (like the uses-connection fixture), rather
// than a fully static one. `connection()` is dynamic data, not runtime data,
// so it affects neither the tree's static-prefetch hint nor the segment's
// shell-sufficiency — but it changes how the server serves navigation
// requests: RSC navigation
// requests for routes that were FULLY static at build are served straight
// from the static cache with no dynamic resume, so once this route's
// generation diverges (leaving the cookie-gated session content as a hole
// in the cached entry), the navigation response would end with the hole
// unresolved and the test's final navigation could never render the session
// content. With a dynamic hole present from the start, navigation requests
// take the dynamic render path and resolve the post-shell cookie content.
async function AlwaysDynamicContent() {
  await connection()
  return <div id="after-shell-dynamic">After-shell dynamic content</div>
}

// Renders which generation the server is serving, without reading any
// runtime data — so it's visible to the test's plain page fetches in both
// generations.
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

async function DelayedSessionContent() {
  // Resolves post-shell during static prerenders, which positions everything
  // after it — including the cookies() access — past the shell stage.
  const gate = await getDelayedGate()
  // Await the plain cached token BEFORE the unstable_cache-captured copy: the
  // direct call is what populates the prerender resume data cache during the
  // cache-warming phase, and an unstable_cache lookup may resolve after that
  // phase has ended, so anything awaited after it would miss warming.
  const current = await getCurrentToken()
  const captured = await getCapturedToken()
  if (captured !== current) {
    const cookieStore = await cookies()
    const value = cookieStore.get('testCookie')?.value ?? 'none'
    return (
      <div id="after-shell-session">{`${gate}; After-shell cookie: ${value}`}</div>
    )
  }
  return (
    <div id="after-shell-session">{`${gate}; After-shell cookie: not-read`}</div>
  )
}

export default function Page() {
  return (
    <main>
      <p id="page-content">After-shell page shell text</p>
      <GenerationMarker />
      <Suspense
        fallback={
          <p id="after-shell-loading">Loading after-shell session...</p>
        }
      >
        <DelayedSessionContent />
      </Suspense>
      <Suspense
        fallback={
          <p id="after-shell-dynamic-loading">Loading dynamic content...</p>
        }
      >
        <AlwaysDynamicContent />
      </Suspense>
    </main>
  )
}
