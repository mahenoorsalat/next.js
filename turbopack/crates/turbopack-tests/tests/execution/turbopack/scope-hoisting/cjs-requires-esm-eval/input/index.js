require('./esm')

it('runs an ESM module required only for its side effect', () => {
  expect(globalThis.__esmEvalSideEffect).toBe(1)
})
