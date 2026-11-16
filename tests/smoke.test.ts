it('runs on Node 24 or newer', () => {
  expect(Number(process.versions.node.split('.')[0])).toBeGreaterThanOrEqual(24)
})
