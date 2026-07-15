const { add, PI } = require('./math')
const dep = require('./dep')

it('scope-hoists a static CJS require and preserves values', () => {
  expect(add(1, 2)).toBe(3)
  expect(PI).toBe(3.14)
})

it('scope-hoists a namespace require', () => {
  expect(dep.value).toBe(42)
  expect(dep.double(21)).toBe(42)
})
