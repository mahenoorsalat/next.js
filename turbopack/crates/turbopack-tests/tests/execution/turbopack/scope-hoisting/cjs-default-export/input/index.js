const d = require('./dep')

it('scope-hoists a CJS module with a reserved-word (default) export', () => {
  expect(d.default).toBe('the-default')
  expect(d.named).toBe('the-named')
})
