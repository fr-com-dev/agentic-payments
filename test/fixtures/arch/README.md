# Architecture rule fixtures (T-ARCH-*, SPEC §4.1)

Each `a<n>-violation.ts` contains exactly one violation of rule A<n>. Its first line declares
the virtual path it is checked under (`// @virtual-path: src/...`). `test/architecture.test.ts`
reads these files as text and passes them to the pure `checkFile(path, source)`; it asserts
that each produces exactly `["A<n>"]` (Principle VIII must-fail proof).

These files are never imported by `src/`, are excluded from `tsc` (tsconfig `exclude`), and
are not test files.
