# BlindVault — Architecture

> Complements `overview.md`, which is normative. This document records how the repository is
> built, which dependencies it uses and why, and what is reused from BlindPass.

## Repository

pnpm workspaces: `apps/web`, `packages/{crypto,vault,storage,sync,backup}` and `tests`. Packages are
named `@blindvault/*`, ESM only, and source-only: each `exports` points at `src/index.ts`, and Vite
and Vitest consume the TypeScript directly. There is no package build step. `tsc -b` type-checks
every project through the references in the root `tsconfig.json`.

**Package boundaries** are enforced twice:

- ESLint `no-restricted-imports` on `packages/crypto/**` rejects `@blindvault/*`, `react` and
  `react-dom` (covered by `tests/boundaries.test.ts`).
- Every package is a composite TypeScript project with `include: ["src", ...]` and no project
  references unless it declares a dependency, so `tsc -b` rejects a relative import that leaves the
  package (TS6059/TS6307).

## Dependencies

Every dependency is listed here with its justification. Versions are pinned exactly in
`package.json` and resolved only once they are at least 14 days old (`minimumReleaseAge`). No
dependency may run install scripts (`onlyBuiltDependencies: []`).

### Development tooling

| Dependency | Where | Justification |
| --- | --- | --- |
| `typescript` 6.0 | root | Strict typing (stack). Held on 6.0 because `typescript-eslint` 8 supports `<6.1`. |
| `eslint`, `@eslint/js`, `typescript-eslint`, `globals` | root | Linting with type information (`strictTypeChecked`) and the package-boundary rule. |
| `prettier` | root | Formatting. Markdown is excluded so the normative docs keep their hand formatting. |
| `@types/node` 24 | root, `apps/web` | Types for config files and tests running in Node. Matches the pinned Node major. |
| `vitest`, `@vitest/coverage-v8` | each package, `tests` | Unit tests (stack) and the 95% coverage gate on `packages/*`. |
| `@playwright/test` | `apps/web` | End-to-end tests on Chromium, Firefox and WebKit (stack). |
| `vite`, `@vitejs/plugin-react` | `apps/web` | Build and dev server (stack). |
| `tailwindcss`, `@tailwindcss/vite` | `apps/web` | Styling (stack). |
| `@types/react`, `@types/react-dom` | `apps/web` | Types for React. |

### Runtime

| Dependency | Where | Justification |
| --- | --- | --- |
| `react`, `react-dom` | `apps/web` | UI (stack). |

Runtime cryptographic, serialization and protocol dependencies are added with their phase and
recorded here first.
