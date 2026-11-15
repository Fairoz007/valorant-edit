import { setActiveLocale } from '../src/shared/locale'

/**
 * Valorant Editor ships with English as the default locale. The behavioral test suite inherited from Aditor asserts
 * the Traditional Chinese source catalog (the `tr()` keys), so it is pinned to that locale here. English output is
 * covered separately by `src/shared/english-default.test.ts` and the catalog coverage tests.
 * A test file can opt out with `// @vitest-environment-options {"url":"http://localhost/"}` and `setActiveLocale('en')`.
 */
setActiveLocale('zh-TW')
