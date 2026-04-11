# CI Failure Diagnosis and TypeScript Build Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore green CI by identifying the failing GitHub Actions check, reproducing it locally, and fixing the TypeScript build so example code no longer breaks library compilation.

**Architecture:** The published package should compile only `src/**/*` into `dist`, while `example/demo.ts` should remain a developer-only entrypoint. The fix separates library build inputs from optional example typechecking, then reruns the failing CI job to confirm the root cause is closed.

**Tech Stack:** Node.js, pnpm, TypeScript, tsx, GitHub Actions, GitHub CLI

---

### Task 1: Confirm The Exact CI Failure And Reproduce It Locally

**Files:**
- Inspect: `package.json`
- Inspect: `tsconfig.json`
- Inspect: `example/demo.ts`

- [ ] **Step 1: Resolve the failing GitHub Actions check**

Run from the actual repository root that owns the CI workflow:

```bash
gh auth status
gh pr view --json number,url,headRefName,baseRefName
python "/Users/stevelife/.codex/plugins/cache/openai-curated/github/fb0a18376bcd9f2604047fbe7459ec5aed70c64b/skills/gh-fix-ci/scripts/inspect_pr_checks.py" --repo "." --pr "<pr-number-or-url>"
```

Expected: a failing GitHub Actions job is identified with a run URL and log snippet. If `gh pr view` fails because the directory is not a git repo, switch to the actual checked-out repository before continuing.

- [ ] **Step 2: Reproduce the failure with the CI-equivalent build command**

```bash
pnpm install --frozen-lockfile
pnpm build
```

Expected: `pnpm build` fails with `TS6059` because `example/demo.ts` is matched by `include` but sits outside `rootDir: "src"`.

- [ ] **Step 3: Record the confirmed root cause**

Use this note in the PR or incident thread:

```text
The current build config compiles `src/**/*` and `example/**/*` in one TypeScript program, but `rootDir` is pinned to `src`. That makes `tsc -p tsconfig.json` fail in CI with TS6059 as soon as it sees `example/demo.ts`.
```

### Task 2: Separate Publishable Build Inputs From Example Typechecking

**Files:**
- Modify: `tsconfig.json`
- Create: `tsconfig.examples.json`
- Modify: `package.json`

- [ ] **Step 1: Keep the package build focused on `src/**/*` only**

Update `tsconfig.json` to:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 2: Add a separate config for example typechecking**

Create `tsconfig.examples.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": "."
  },
  "include": ["src/**/*", "example/**/*"]
}
```

- [ ] **Step 3: Expose the two responsibilities as separate package scripts**

Update the scripts in `package.json` to:

```json
{
  "scripts": {
    "dev": "tsx example/demo.ts",
    "build": "tsc -p tsconfig.json",
    "typecheck:examples": "tsc -p tsconfig.examples.json"
  }
}
```

- [ ] **Step 4: Run the local verification loop**

```bash
pnpm build
pnpm run typecheck:examples
pnpm dev
```

Expected:
- `pnpm build` passes and writes `dist/**/*`
- `pnpm run typecheck:examples` passes without emitting files
- `pnpm dev` still runs `example/demo.ts`

- [ ] **Step 5: Commit**

```bash
git add tsconfig.json tsconfig.examples.json package.json
git commit -m "fix: separate library build from example typechecking"
```

### Task 3: Re-run CI And Close The Incident

**Files:**
- Modify if present in the real repo: `.github/workflows/ci.yml`

- [ ] **Step 1: Re-run the failing checks after the config fix**

```bash
gh pr checks "<pr-number-or-url>"
gh pr checks "<pr-number-or-url>" --watch
```

Expected: the previous `TS6059` failure disappears from the build job.

- [ ] **Step 2: Only update the workflow if it relied on `build` to validate examples**

If the workflow should keep validating `example/**/*`, add an explicit step in `.github/workflows/ci.yml`:

```yaml
- name: Build package
  run: pnpm build

- name: Typecheck examples
  run: pnpm run typecheck:examples
```

If CI only needs distributable package output, leave the workflow unchanged after the `tsconfig` fix.

- [ ] **Step 3: Final verification**

```bash
gh pr checks "<pr-number-or-url>"
```

Expected: all GitHub Actions checks are green, or any remaining failures are unrelated and can be triaged separately.

## Self-Review

**Spec coverage:** The plan covers remote diagnosis, local reproduction, the confirmed TypeScript root cause, the minimal config fix, and CI re-verification.

**Placeholder scan:** The GitHub PR identifier and workflow path depend on the actual upstream repo, which is not present in this workspace. All local file changes and commands are concrete.

**Type consistency:** The plan keeps `build` for distributable library compilation and introduces `typecheck:examples` for the example code path so the responsibilities stay distinct.
