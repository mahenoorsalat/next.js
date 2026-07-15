const { value } = require('./esm')
const lib = require('./lib')

it('shares one inlined ESM module across two CJS requirers', () => {
  expect(value).toBe(42)
  expect(lib.libValue).toBe(42)
  expect(lib.libDoubled).toBe(84)
  expect(globalThis.__sharedEsmEvals).toBe(1)
})
