/**
 * Teaches TypeScript about the jest-dom matchers under vitest 5.
 *
 * `@testing-library/jest-dom/vitest` registers the matchers at runtime and
 * ships its own type augmentation, but that augmentation is still written
 * against vitest 4:
 *
 *     declare module 'vitest' {
 *       interface Assertion<T = any> extends TestingLibraryMatchers<any, T> {}
 *     }
 *
 * vitest 5 gave `Assertion` and `Matchers` a leading return-type parameter
 * (`Assertion<R extends void | Promise<void> = void, T = unknown>`), and
 * declaration merging only merges when the type parameter lists match
 * exactly. jest-dom's one-parameter version therefore stops merging, and
 * every `expect(el).toBeInTheDocument()` fails to typecheck with TS2339 —
 * 449 of them across this package. jest-dom 7.0.1 (current latest) ships
 * the identical vitest-4-shaped file, so there is no version to upgrade to.
 *
 * We augment `Matchers` rather than `Assertion` because vitest 5 has
 * `Assertion`, `ExpectStatic` and `AsymmetricMatchersContaining` all extend
 * `Matchers` — that's the documented extension point for custom matchers,
 * so one augmentation covers `expect(...)`, `expect.not` and friends.
 *
 * Delete this file once jest-dom ships vitest 5 types. Runtime registration
 * still comes from the `@testing-library/jest-dom/vitest` import in
 * `src/test-setup.ts`; this file is types only.
 */
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
  // The empty body IS the augmentation — `Matchers` gains its members by
  // extending jest-dom's. `T` is unused here but has to be declared: merging
  // only happens when the type parameter list matches vitest's exactly.
  /* eslint-disable @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars */
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown>
    extends TestingLibraryMatchers<unknown, R> {}
  /* eslint-enable @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars */
}
