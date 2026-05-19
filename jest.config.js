export default {
  testEnvironment: 'node',
  transform: {},
  testMatch: ['**/src/__tests__/**/*.test.js'],
  forceExit: true,
  collectCoverageFrom: ['src/**/*.js', '!src/__tests__/**'],
  coverageReporters: ['text', 'lcov'],
}
