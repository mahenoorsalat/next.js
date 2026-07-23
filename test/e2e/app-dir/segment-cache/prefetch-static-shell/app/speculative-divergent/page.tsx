import { Suspense } from 'react'
import { cookies } from 'next/headers'
import { cacheLife, cacheTag, unstable_cache } from 'next/cache'

// The Speculative-phase counterpart of app/divergent-cookies/page.tsx: the
// same token-pair cross-render divergence mechanism (see that fixture for
// the full explanation of the tagged current token, the unstable_cache-
// captured copy, and the /api/diverge endpoint that flips and resets the
// pair), but with RUNTIME prefetching enabled (`allow-runtime`) so the page
// segment requires runtime-completeness during the Speculative phase, too —
// the phase the consuming test exercises via a `prefetch={true}` link.
//
// The choreography is identical: the client fetches the route tree while
// its static-prefetch hint is SET (from a stale, clean render), but by the
// time the static segment prefetches hit the server, a diverged render
// records a cookies() access in the shell stage — the static attempt is
// insufficient and the batched runtime fallback fires. And because a
// runtime prefetch of an allow-runtime segment resolves cookies() reads
// (see app/speculative-cookies/page.tsx) — the token pair is fully cached
// by the time the fallback renders, so the comparison resolves and the
// read is reached — the session content itself arrives in the runtime
// fallback response.
export const prefetch = 'allow-runtime'

async function getCurrentToken(): Promise<number> {
  'use cache'
  cacheTag('diverge-speculative')
  cacheLife({ stale: 3600, revalidate: 3600, expire: 3600 })
  return Math.random()
}

const getCapturedToken = unstable_cache(
  async (): Promise<number> => getCurrentToken(),
  ['diverge-speculative-captured'],
  { tags: ['diverge-speculative-captured'], revalidate: false }
)

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

async function SessionContent() {
  // Await the plain cached token BEFORE the unstable_cache-captured copy: the
  // direct call is what populates the prerender resume data cache during the
  // cache-warming phase, and an unstable_cache lookup may resolve after that
  // phase has ended, so anything awaited after it would miss warming.
  const current = await getCurrentToken()
  const captured = await getCapturedToken()
  if (captured !== current) {
    // Diverged generation: read cookies, recording a runtime-data access in
    // the shell stage.
    const cookieStore = await cookies()
    const value = cookieStore.get('testCookie')?.value ?? 'none'
    return (
      <div id="speculative-divergent-session">{`Speculative-divergent cookie: ${value}`}</div>
    )
  }
  // Clean generation: the tokens were computed together, so the render is
  // clean.
  return (
    <div id="speculative-divergent-session">
      Speculative-divergent cookie: not-read
    </div>
  )
}

export default function Page() {
  return (
    <main>
      <p id="page-content">Speculative-divergent page shell text</p>
      <GenerationMarker />
      <Suspense
        fallback={
          <p id="speculative-divergent-loading">
            Loading speculative-divergent session...
          </p>
        }
      >
        <SessionContent />
      </Suspense>
    </main>
  )
}
