const msg = require('./util').greet('world')

require('./side')

it('supports member access on a require and bare evaluation requires', () => {
  expect(msg).toBe('hi world')
  expect(globalThis.__cjsSideEffectRan).toBe(1)
})
