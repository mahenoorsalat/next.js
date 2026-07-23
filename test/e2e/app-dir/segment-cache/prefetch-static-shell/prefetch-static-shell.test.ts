import { nextTestSetup } from 'e2e-utils'
import { retry } from 'next-test-utils'
import type * as Playwright from 'playwright'
import { createRouterAct } from 'router-act'

// This suite tests the static App Shell prefetch attempt.
//
// When a route's tree prefetch response carries the static-prefetch hint —
// set iff the render that produced the tree accessed NO runtime data
// (cookies, headers, searchParams, fallback params) — the client's Shell
// prefetch phase attempts STATIC per-segment prefetches of the App Shell
// instead of the runtime shell request it would otherwise issue. Each static
// response signals whether a runtime request would return more than it did,
// and when the responses arrive the scheduler checks that signal for each
// shell segment:
//
// - If every shell segment is sufficient, the Shell phase completes with no
//   runtime request. A segment can be sufficient even when it's partial, as
//   long as its holes are *dynamic* (only fillable by the navigation-time
//   dynamic request, e.g. `connection()`), not *runtime* (fillable by a
//   runtime prefetch, e.g. cookies).
// - If any shell segment is insufficient, the existing single batched
//   runtime shell prefetch fires as a fallback. The attempt is serial,
//   never raced: static attempt → observe → runtime only if needed.
//
// If the hint is unset, the client goes straight to the runtime shell
// request (previous behavior).
//
// All of the above concerns the NEW part of the target tree — the segments
// that differ from the current page. Segments shared with the current page
// are outside the shell-attempt machinery entirely: the shared part of the
// tree always performs the ordinary static per-segment prefetch, in every
// phase, regardless of the hint — mirroring how runtime requests also cover
// only the new part. In this suite the shared part is always just the root
// layout (every link is prefetched from the home page), and its cache entry
// is already populated from the initial page load's seed data, so the shared
// walk is a cache hit and no request fires for it. What the tests can pin is
// the other half of the model: runtime requests never cover the shared part
// (see the layout rejection in the cookies test).
//
// The hint reflects the WHOLE render that produced the tree: any runtime-
// data access unsets it, no matter how late in the render the access
// happened. The per-segment signal is finer-grained: the shell variant of a
// segment response covers only what rendered during the shell stage, so an
// access recorded after that stage leaves the shell variant clean ("no
// runtime request needed for the shell") even though the full response
// records it. A stale cached tree can also disagree with fresh segment
// responses — the divergent fixtures below exploit this deliberately.
//
// This suite asserts directly on App Shell prefetch responses, so every
// `createRouterAct` call passes `{ includeAppShellRequests: true }` — by
// default router-act excludes runtime shell requests from assertions.
// Expectations additionally use `kind: 'static' | 'runtime'` to assert HOW a
// piece of content arrived: 'static' matches per-segment static prefetch
// requests (including the route tree prefetch), 'runtime' matches dynamic
// prefetch requests (e.g. the runtime shell request).
describe('static App Shell prefetch attempt', () => {
  const { next, isNextDev } = nextTestSetup({
    files: __dirname,
  })
  if (isNextDev) {
    // The feature depends on build-time prerenders and ISR regeneration
    // semantics that don't exist in dev.
    it('is skipped', () => {})
    return
  }

  it('prefetches a fully static route with static requests only, then navigates instantly from cache', async () => {
    let page: Playwright.Page
    const browser = await next.browser('/', {
      beforePageLoad(p: Playwright.Page) {
        page = p
      },
    })
    const act = createRouterAct(page, { includeAppShellRequests: true })

    // Reveal the LinkAccordion for /fully-static. The route accesses no
    // runtime data, so its tree carries the static-prefetch hint and the
    // Shell phase attempts static per-segment prefetches. The static
    // responses are complete, so no runtime shell request fires.
    await act(async () => {
      await browser
        .elementByCss('input[data-link-accordion="/fully-static"]')
        .click()
    }, [
      // The shell content arrives in a static per-segment response...
      { includes: 'Fully static page content', kind: 'static' },
      // ...and must NOT arrive in a runtime prefetch response — the
      // static attempt was sufficient, so no runtime request fires.
      {
        includes: 'Fully static page content',
        kind: 'runtime',
        block: 'reject',
      },
    ])

    // Navigate to the prefetched route. Everything was cached by the static
    // prefetch, so the navigation completes without any requests.
    await act(async () => {
      await browser.elementByCss('a[href="/fully-static"]').click()
      expect(await browser.elementById('page-content').text()).toBe(
        'Fully static page content'
      )
    }, 'no-requests')
  })

  it('goes straight to a runtime shell prefetch when the shell reads cookies (hint unset)', async () => {
    let page: Playwright.Page
    const browser = await next.browser('/', {
      beforePageLoad(p: Playwright.Page) {
        page = p
      },
    })
    const act = createRouterAct(page, { includeAppShellRequests: true })

    // Reveal the LinkAccordion for /uses-cookies. The page reads cookies in
    // the shell stage of every prerender, so the tree hint is unset and the
    // Shell phase issues the runtime shell request for the new part of the
    // tree directly, with no static shell attempt preceding it. (The shared
    // part — the root layout — is outside the hint's scope: it always gets
    // the ordinary static prefetch, which here is a cache hit against the
    // initial page load's seed data, so no request fires for it.)
    await act(async () => {
      await browser
        .elementByCss('input[data-link-accordion="/uses-cookies"]')
        .click()
    }, [
      // The page (the new part) arrives in the runtime shell response.
      // (The bare cookies() read itself isn't resolved by the runtime
      // prerender — it stays a hole for the navigation-time dynamic
      // request — so we only assert on the shell text.)
      { includes: 'Cookies page shell text', kind: 'runtime' },
      // No static attempt for the new part: the page content must not
      // arrive in a static per-segment response. (The route tree prefetch
      // is also `kind: 'static'`, but its response doesn't contain rendered
      // page content, so it can't match this.)
      {
        includes: 'Cookies page shell text',
        kind: 'static',
        block: 'reject',
      },
      // The runtime shell request covers only the new part of the tree:
      // the shared root layout's content must never arrive in a
      // runtime response.
      {
        includes: 'Root layout static text',
        kind: 'runtime',
        block: 'reject',
      },
    ])
  })

  it('goes straight to a runtime shell prefetch when the shell reads searchParams (hint unset)', async () => {
    let page: Playwright.Page
    const browser = await next.browser('/', {
      beforePageLoad(p: Playwright.Page) {
        page = p
      },
    })
    const act = createRouterAct(page, { includeAppShellRequests: true })

    // Reveal the LinkAccordion for /uses-search-params?q=test. Observing
    // searchParams is a runtime-data access (search params hang during a
    // static prerender but resolve during a runtime one), so like the
    // cookies route the tree hint is unset and the Shell phase issues the
    // runtime shell request directly.
    await act(async () => {
      await browser
        .elementByCss('input[data-link-accordion="/uses-search-params?q=test"]')
        .click()
    }, [
      // The shell content arrives in the runtime shell response. (The
      // query-dependent content is URL data, which is never part of an
      // App Shell, so we only assert on the shell text.)
      { includes: 'Search params page shell text', kind: 'runtime' },
      // No static attempt for the new part preceded it.
      {
        includes: 'Search params page shell text',
        kind: 'static',
        block: 'reject',
      },
    ])
  })

  it('falls back to a runtime shell prefetch when the static attempt is insufficient', async () => {
    // Divergence test: the client fetches the route tree while the hint is
    // SET (from a stale, clean render), but by the time the static segment
    // prefetches hit the server, a fresh render records a cookies() access
    // in the shell stage — so the static shell attempt is insufficient and
    // the batched runtime fallback fires. See app/divergent-cookies/page.tsx
    // for how the fixture makes the renders diverge on the test's cue.
    //
    // Mechanism for splitting the tree fetch from the segment fetches: the
    // Shell phase always fetches the route tree first and only issues the
    // per-segment requests once the tree response arrives. A nested `act`
    // with 'block' withholds the (clean, hint-carrying) tree response from
    // the client while the test flips the fixture to its DIVERGED
    // generation — the one that reads cookies. Releasing the tree then lets
    // the client run its static attempt against the diverged generation.
    // This is more robust than two links or the router.prefetch testing API
    // because it needs no second route entry and keeps the entire flow
    // inside one prefetch task.
    //
    // Reset the fixture to its clean generation first (relevant on Jest
    // retries, where a previous attempt may have left it diverged), then
    // poll with page requests until the server serves the clean generation:
    // prefetch requests (tree and per-segment) are served straight from the
    // route cache and never trigger an ISR revalidation; only page requests
    // regenerate the route. The fixture renders a `generation:` marker so a
    // plain page fetch can observe which generation is being served.
    await next.fetch('/api/diverge?tag=diverge-cookies&reset=1')
    await retry(async () => {
      const response = await next.fetch('/divergent-cookies')
      expect(await response.text()).toContain('generation: clean')
    }, 10_000)

    let page: Playwright.Page
    const browser = await next.browser('/', {
      beforePageLoad(p: Playwright.Page) {
        page = p
      },
    })
    const act = createRouterAct(page, { includeAppShellRequests: true })

    await act(async () => {
      // Reveal the LinkAccordion for /divergent-cookies and block the
      // route tree response. The response was produced by the (stale)
      // clean generation, so it carries the static-prefetch hint.
      await act(async () => {
        await browser
          .elementByCss('input[data-link-accordion="/divergent-cookies"]')
          .click()
      }, 'block')

      // While the tree response is withheld from the client, flip the
      // fixture to its diverged generation and poll with page requests
      // until the server serves it. After this, the current generation on
      // the server reads cookies in the shell stage. When the outer scope
      // exits, the blocked tree response is released and the client's
      // static attempt runs against the diverged generation.
      await next.fetch('/api/diverge?tag=diverge-cookies')
      await retry(async () => {
        const response = await next.fetch('/divergent-cookies')
        expect(await response.text()).toContain('generation: diverged')
      }, 10_000)
    }, [
      // The static attempt fires first: the shell content arrives in a
      // static per-segment response. The session content is a hole in the
      // static response (the fresh render's cookies() access hangs), and
      // the response signals that a runtime request would return more,
      // marking the shell variant insufficient...
      { includes: 'Divergent-cookies page shell text', kind: 'static' },
      // ...so the batched runtime shell fallback fires afterwards,
      // re-delivering the shell in a runtime response. Both requests
      // occurred, in order: static attempt, then runtime fallback. (The
      // session content itself is NOT part of the fallback response: a
      // bare cookies() read isn't resolved by a runtime prerender either —
      // it remains a hole for the navigation-time dynamic request.)
      { includes: 'Divergent-cookies page shell text', kind: 'runtime' },
      // The session content must never arrive statically. (If the static
      // responses were still served from the clean generation, they would
      // contain 'Divergent cookie: not-read' and this rejection would
      // flag it.)
      { includes: 'Divergent cookie:', kind: 'static', block: 'reject' },
    ])
  })

  it('does not fall back to a runtime shell prefetch for a partial segment whose holes are dynamic (connection)', async () => {
    let page: Playwright.Page
    const browser = await next.browser('/', {
      beforePageLoad(p: Playwright.Page) {
        page = p
      },
    })
    const act = createRouterAct(page, { includeAppShellRequests: true })

    // Reveal the LinkAccordion for /uses-connection. `connection()` is
    // dynamic data (it hangs during runtime prerenders too), so it's not
    // recorded as a runtime-data access: the tree hint is set, the static
    // attempt fires, and although the page segment is partial, it's
    // sufficient — a runtime prefetch would have the same hole. No runtime
    // fallback fires.
    await act(async () => {
      await browser
        .elementByCss('input[data-link-accordion="/uses-connection"]')
        .click()
    }, [
      { includes: 'Connection page shell text', kind: 'static' },
      // Neither the shell nor the dynamic content may arrive in a runtime
      // prefetch response — no runtime request should fire at all.
      {
        includes: 'Connection page shell text',
        kind: 'runtime',
        block: 'reject',
      },
      { includes: 'Connection content', kind: 'runtime', block: 'reject' },
    ])

    // Navigate. The prefetched shell renders instantly; the dynamic hole is
    // filled by the navigation-time dynamic request, as always.
    await act(
      async () => {
        await browser.elementByCss('a[href="/uses-connection"]').click()

        // While the navigation response is blocked (we're still inside the
        // `act` scope), the prefetched shell is already visible, with the
        // loading fallback in place of the dynamic content.
        expect(await browser.elementById('page-content').text()).toBe(
          'Connection page shell text'
        )
        expect(await browser.elementById('connection-loading').text()).toBe(
          'Loading connection content...'
        )
      },
      // The dynamic content streams in with the navigation response.
      { includes: 'Connection content' }
    )
    expect(await browser.elementById('connection-content').text()).toBe(
      'Connection content'
    )
  })

  it('reuses the static App Shell across different param values of a dynamic route', async () => {
    let page: Playwright.Page
    const browser = await next.browser('/', {
      beforePageLoad(p: Playwright.Page) {
        page = p
      },
    })
    const act = createRouterAct(page, { includeAppShellRequests: true })

    // Reveal the LinkAccordion for /dynamic-param/one. Every URL of the
    // route is prerendered at build time and accesses no runtime data, so
    // the route tree prefetch carries the static-prefetch hint and the
    // Shell phase attempts static per-segment prefetches. The static
    // responses are sufficient, so no runtime request fires.
    await act(async () => {
      await browser
        .elementByCss('input[data-link-accordion="/dynamic-param/one"]')
        .click()
    }, [
      // The shell content arrives in a static per-segment response. The
      // response is the full prerender for this URL; the client extracts
      // the param-agnostic shell prefix and caches it at a key shared by
      // every param value of the route. (The response also carries this
      // URL's param content — a fully static prerender isn't truncated —
      // but that's incidental, so we don't assert on it.)
      { includes: 'Dynamic-param page shell text', kind: 'static' },
      // No runtime request fires — the static attempt was sufficient.
      {
        includes: 'Dynamic-param page shell text',
        kind: 'runtime',
        block: 'reject',
      },
    ])

    // Reveal the LinkAccordion for /dynamic-param/two — a different param
    // value of the same route. Everything this prefetch needs is already
    // cached: the App Shell entries cached by the previous prefetch are
    // param-agnostic, so they're cache hits for this URL too, and the
    // earlier route tree prefetch also taught the client the route's shape
    // and its statically-known param values, so even the target route is
    // constructed locally. And because the route is non-eager, the per-URL
    // content is left for the navigation-time dynamic request. So no request
    // of any kind fires — in particular, nothing re-fetches the shared
    // shell content.
    await act(async () => {
      await browser
        .elementByCss('input[data-link-accordion="/dynamic-param/two"]')
        .click()
    }, 'no-requests')

    // Navigate to /dynamic-param/two. The App Shell reused from the other
    // param's prefetch renders instantly, before the navigation response
    // arrives; the param content streams in with the navigation response.
    await act(
      async () => {
        await browser.elementByCss('a[href="/dynamic-param/two"]').click()

        // While the navigation response is blocked (we're still inside the
        // `act` scope), the reused shell is already visible, with the
        // loading fallback in place of the param content.
        expect(await browser.elementById('page-content').text()).toBe(
          'Dynamic-param page shell text'
        )
        expect(await browser.elementById('slug-loading').text()).toBe(
          'Loading param content...'
        )
      },
      // The param content arrives with the navigation response.
      { includes: 'Dynamic param content: two' }
    )
    expect(await browser.elementById('slug-content').text()).toBe(
      'Dynamic param content: two'
    )
  })

  // TODO(hint-bits): This test needs the cross-render divergence (stale
  // clean tree + fresh post-shell-accessing segment render) only because the
  // tree hint reflects the whole render: a page that always reads cookies
  // after the shell stage never carries the hint on its own fresh tree, even
  // though its shell is perfectly reusable. If the server emitted two
  // separate hints — one for the whole render ("a static prefetch is as
  // complete as a runtime one") and one for the shell stage ("a static SHELL
  // attempt is worthwhile even though the page accesses runtime data
  // post-shell") — this rewind behavior could be exercised directly, without
  // the divergence setup.
  it('accepts the static shell when the runtime-data access is recorded after the shell stage (rewind)', async () => {
    // Same blocked-tree divergence mechanism as the fallback test above —
    // see that test and app/divergent-cookies-after-shell/page.tsx. The
    // difference: the diverged render's cookies() access sits behind a
    // short-stale cached gate that resolves post-shell, so the access is
    // recorded AFTER the shell stage. The full static response records the
    // access, but the shell variant covers only what rendered during the
    // shell stage and therefore reads as clean — so the static shell is
    // accepted and NO runtime fallback fires, despite the full response
    // recording the access.
    //
    // Reset the fixture to its clean generation and poll until the server
    // serves it — see the fallback test above for the full explanation.
    await next.fetch('/api/diverge?tag=diverge-after-shell&reset=1')
    await retry(async () => {
      const response = await next.fetch('/divergent-cookies-after-shell')
      expect(await response.text()).toContain('generation: clean')
    }, 10_000)

    let page: Playwright.Page
    const browser = await next.browser('/', {
      beforePageLoad(p: Playwright.Page) {
        page = p
      },
    })
    const act = createRouterAct(page, { includeAppShellRequests: true })

    await act(async () => {
      // Reveal the link and block the (stale, clean, hint-carrying) tree
      // response.
      await act(async () => {
        await browser
          .elementByCss(
            'input[data-link-accordion="/divergent-cookies-after-shell"]'
          )
          .click()
      }, 'block')

      // While the tree response is withheld, flip the fixture to its
      // diverged generation and poll until the server serves it, so the
      // static segment responses come from the cookie-reading generation
      // (see the fallback test above).
      await next.fetch('/api/diverge?tag=diverge-after-shell')
      await retry(async () => {
        const response = await next.fetch('/divergent-cookies-after-shell')
        expect(await response.text()).toContain('generation: diverged')
      }, 10_000)
    }, [
      // The static attempt fires and the shell content arrives
      // statically...
      { includes: 'After-shell page shell text', kind: 'static' },
      // ...and is accepted: no runtime request fires, so neither the
      // shell nor the session content may arrive in a runtime response.
      {
        includes: 'After-shell page shell text',
        kind: 'runtime',
        block: 'reject',
      },
      { includes: 'After-shell cookie:', kind: 'runtime', block: 'reject' },
    ])

    // Navigate. The statically-prefetched shell renders instantly; the
    // post-shell session content is filled by the navigation-time dynamic
    // request.
    await act(
      async () => {
        await browser
          .elementByCss('a[href="/divergent-cookies-after-shell"]')
          .click()

        // While the navigation response is blocked, the prefetched shell is
        // already visible.
        expect(await browser.elementById('page-content').text()).toBe(
          'After-shell page shell text'
        )
      },
      // The session content arrives with the navigation response.
      { includes: 'After-shell cookie: none' }
    )
    expect(await browser.elementById('after-shell-session').text()).toBe(
      'after-shell gate content; After-shell cookie: none'
    )
  })

  // The three tests below exercise the SPECULATIVE half of the unified
  // model: Partial Prefetching segments require runtime-completeness in
  // every phase, and the Speculative phase only processes such a segment
  // when the link opts in (prefetch={true} — the speculative-* accordions on
  // the home page set it; non-eager routes are otherwise shell-only by
  // design). The same hint-gated attempt applies: hint set → the segment
  // joins the normal static prefetch walk and each response's sufficiency
  // signal decides whether the batched runtime fallback fires; hint unset →
  // straight to the runtime prefetch. This relies on the server emitting
  // static data for Partial Prefetching segments unconditionally.

  it('speculative: prefetch={true} with the hint set prefetches statically with no runtime request', async () => {
    let page: Playwright.Page
    const browser = await next.browser('/', {
      beforePageLoad(p: Playwright.Page) {
        page = p
      },
    })
    const act = createRouterAct(page, { includeAppShellRequests: true })

    // Reveal the prefetch={true} LinkAccordion for /speculative-static. The
    // route accesses no runtime data, so its tree carries the
    // static-prefetch hint; both the Shell phase and the Speculative phase
    // attempt static prefetches of the page segment, and the complete
    // static responses make any runtime request unnecessary.
    await act(async () => {
      await browser
        .elementByCss('input[data-link-accordion="/speculative-static"]')
        .click()
    }, [
      // The page content arrives in a static per-segment response...
      { includes: 'Speculative-static page content', kind: 'static' },
      // ...and must NOT arrive in a runtime prefetch response — the static
      // attempt was sufficient, so neither the runtime shell request nor
      // the Speculative phase's runtime prefetch fires, despite the
      // segment's runtime-completeness requirement.
      {
        includes: 'Speculative-static page content',
        kind: 'runtime',
        block: 'reject',
      },
    ])

    // Navigate to the prefetched route. Everything was cached by the static
    // prefetch, so the navigation completes without any requests.
    await act(async () => {
      await browser.elementByCss('a[href="/speculative-static"]').click()
      expect(await browser.elementById('page-content').text()).toBe(
        'Speculative-static page content'
      )
    }, 'no-requests')
  })

  it('speculative: goes straight to runtime for a segment that already reported insufficiency', async () => {
    // Same blocked-tree cross-render divergence mechanism as the Shell-phase
    // fallback test above — see that test and
    // app/speculative-divergent/page.tsx. The difference: the link is
    // prefetch={true}, so the page segment is also prefetched during the
    // SPECULATIVE phase — and unlike the divergent-cookies fixture, the
    // Speculative runtime prefetch resolves the cookies() read, so the
    // session content itself arrives in that response.
    //
    // The Speculative phase does not repeat the static attempt. The entry it
    // finds was written by the Shell phase's runtime fallback, so it is
    // recorded at the RuntimeShell tier — below this phase's own runtime tier
    // (PPRRuntime), which is exactly what says a runtime request would still
    // return more. Re-attempting static would be insufficient for the same
    // reason as the first attempt and could only be followed by the same
    // fallback, delivering the segment twice.
    //
    // Reset the fixture to its clean generation and poll until the server
    // serves it — see the Shell-phase fallback test for the full
    // explanation.
    await next.fetch('/api/diverge?tag=diverge-speculative&reset=1')
    await retry(async () => {
      const response = await next.fetch('/speculative-divergent')
      expect(await response.text()).toContain('generation: clean')
    }, 10_000)

    let page: Playwright.Page
    const browser = await next.browser('/', {
      beforePageLoad(p: Playwright.Page) {
        page = p
      },
    })
    const act = createRouterAct(page, { includeAppShellRequests: true })

    await act(async () => {
      // Reveal the link and block the (stale, clean, hint-carrying) tree
      // response.
      await act(async () => {
        await browser
          .elementByCss('input[data-link-accordion="/speculative-divergent"]')
          .click()
      }, 'block')

      // While the tree response is withheld, flip the fixture to its
      // diverged generation and poll until the server serves it, so the
      // static segment responses come from the cookie-reading generation.
      await next.fetch('/api/diverge?tag=diverge-speculative')
      await retry(async () => {
        const response = await next.fetch('/speculative-divergent')
        expect(await response.text()).toContain('generation: diverged')
      }, 10_000)
    }, [
      // The Shell phase's static attempt fires first: the page content
      // arrives in a static per-segment response. The fresh render's
      // cookies() access hangs there (session content is a hole), and the
      // response signals that a runtime request would return more, marking
      // the attempt insufficient...
      { includes: 'Speculative-divergent page shell text', kind: 'static' },
      // ...so the Shell phase's batched runtime fallback fires afterwards,
      // re-delivering the page in a runtime response.
      { includes: 'Speculative-divergent page shell text', kind: 'runtime' },
      // Then the Speculative phase runs. It does NOT attempt static again:
      // the entry it finds was written by the runtime fallback above, which
      // is itself proof that this segment reported insufficiency — a second
      // static attempt would be insufficient for the same reason and could
      // only be followed by the same fallback. So the phase goes straight to
      // its per-link runtime prefetch, which re-delivers the page a third
      // time (and, like the hint-unset test below, resolves the cookies()
      // read — incidental, so not asserted on).
      //
      // The corresponding static rejection is below: the page content must
      // arrive statically exactly once, from the Shell phase's attempt.
      { includes: 'Speculative-divergent page shell text', kind: 'runtime' },
      // The session content must never arrive statically. (If the static
      // responses were still served from the clean generation, they would
      // contain 'Speculative-divergent cookie: not-read' and this rejection
      // would flag it.)
      {
        includes: 'Speculative-divergent cookie:',
        kind: 'static',
        block: 'reject',
      },
    ])
  })

  it('speculative: goes straight to a runtime prefetch when the hint is unset', async () => {
    let page: Playwright.Page
    const browser = await next.browser('/', {
      beforePageLoad(p: Playwright.Page) {
        page = p
      },
    })
    const act = createRouterAct(page, { includeAppShellRequests: true })

    // Reveal the prefetch={true} LinkAccordion for /speculative-cookies. The
    // page reads cookies in the shell stage of every prerender, so the tree
    // hint is unset and the scheduler skips the static attempt entirely: the
    // page segment is runtime prefetched directly, in both the Shell and
    // Speculative phases.
    await act(async () => {
      await browser
        .elementByCss('input[data-link-accordion="/speculative-cookies"]')
        .click()
    }, [
      // Two runtime responses arrive, in order, and each resolves the
      // cookies() read (a runtime prefetch renders with the request's
      // cookies):
      //
      // 1. The Shell phase's runtime shell request — the same direct
      //    runtime shell behavior the hint-unset tests above exercise,
      //    except that here the session content resolves instead of
      //    remaining a hole.
      { includes: 'Speculative-cookies page shell text', kind: 'runtime' },
      { includes: 'Speculative-cookies cookie: none', kind: 'runtime' },
      // 2. The Speculative phase's runtime prefetch of the page segment,
      //    which re-delivers the page content. (It fires on top of the
      //    runtime shell entry because a per-URL runtime prefetch can
      //    provide content a URL-independent shell response cannot.)
      { includes: 'Speculative-cookies page shell text', kind: 'runtime' },
      { includes: 'Speculative-cookies cookie: none', kind: 'runtime' },
      // No static attempt in either phase: the page content must not
      // arrive in ANY static per-segment response. (The server does emit
      // static data for the segment — the shell text is in it — but with
      // the hint unset nothing fetches it: this blanket rejection
      // was verified empirically against the full request log. The route
      // tree prefetch is also kind: 'static', but its response doesn't
      // contain rendered page content, so it can't match this.)
      {
        includes: 'Speculative-cookies page shell text',
        kind: 'static',
        block: 'reject',
      },
    ])
  })
})
