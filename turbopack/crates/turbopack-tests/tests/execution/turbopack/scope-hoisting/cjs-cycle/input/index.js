const a = require('./a')

it('preserves CommonJS cycle semantics when scope-hoisted', () => {
  expect(a.name).toBe('a')
  expect(a.bName).toBe('b')
})
