const { log } = require('./order')

log.push('before')
const { name } = require('./a')
log.push('after')

it('inlines a required module at the require site, preserving order', () => {
  // `order` is shared and must run exactly once; `a` runs where it is required
  // (between `before` and `after`), not hoisted above the earlier side effect.
  expect(log).toEqual(['before', 'a', 'after'])
  expect(name).toBe('a')
})
