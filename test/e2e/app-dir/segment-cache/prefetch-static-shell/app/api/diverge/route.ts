import { revalidateTag } from 'next/cache'
import type { NextRequest } from 'next/server'

// Test-only endpoint that drives the divergent-* fixtures. Each of those
// fixtures compares a tagged cached token against a long-lived captured copy
// of it (see the fixtures for the full explanation); this endpoint flips the
// pair between its two states by revalidating cache tags:
//
// - GET /api/diverge?tag=<tag> revalidates only the token's tag: the token
//   recomputes to a new value while the captured copy keeps the old one, so
//   the pair becomes unequal and the fixture's next regeneration DIVERGES
//   (reads cookies).
// - GET /api/diverge?tag=<tag>&reset=1 revalidates both the token's tag and
//   the captured copy's tag: both recompute together in the next
//   regeneration, so the pair is equal again and the fixture returns to its
//   CLEAN generation. Tests use this at the start to be retry-safe.
//
// Immediate expiration (rather than stale-while-revalidate) so the next page
// request blocks on a fresh render instead of serving a stale generation —
// tests poll the page until the marker text flips.
const expireNow = { stale: 0, revalidate: 0, expire: 0 }

export async function GET(request: NextRequest): Promise<Response> {
  const { searchParams } = request.nextUrl
  const tag = searchParams.get('tag')
  if (tag === null) {
    return new Response('Missing `tag` search param', { status: 400 })
  }
  revalidateTag(tag, expireNow)
  if (searchParams.get('reset') !== null) {
    revalidateTag(`${tag}-captured`, expireNow)
  }
  return new Response('OK')
}
