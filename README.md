# github-core-forge

A standalone, GitHub-compatible git forge in a single process — the entry for the
make.fun `github-core-clone-01` bounty ("Build a GitHub-compatible git forge").

## What it serves

One Node 22 process, standard library only (`node:http`, `node:crypto`, `node:zlib`),
in-memory store, deterministic timestamps (no wall clock in any stored value):

- **Git smart HTTP** (`/{owner}/{repo}.git`): upload-pack protocol v2
  (`ls-refs` with peel/symrefs/unborn/ref-prefix, `fetch` with shallow/deepen,
  unshallow reporting, sideband packfiles of plain objects) and v0 fetch,
  receive-pack v0 with per-ref fast-forward enforcement and report-status.
  Packfiles are written and read with SHA-1 verification; trees sort git-style;
  commits, tags, and blobs are content-addressed exactly like git.
- **REST v3** (`/api/v3`): repositories (create/list/get/patch/delete, pagination
  with `Link: rel="next"`), branches, commits, contents (create/update/delete with
  stale-sha 409, branch auto-creation), labels, issues (filter/sort/paginate,
  comments), pull requests (files diff, squash merge with real conflict
  detection against the merge base).
- **GraphQL v4** (`/api/graphql`): a small recursive-descent parser (named
  operations, variables, enums, inline inputs, aliases, inline and named
  fragments) over `viewer`, `repository`, `node`, issues/pull-request
  connections with cursor pagination, and the `createIssue`, `closeIssue`,
  `createPullRequest`, `mergePullRequest`, and `addComment` mutations — plus
  `__type` introspection. Unknown fields return a `noSuchFieldOnViewer` error.
- **MCP** (`/mcp`): JSON-RPC 2.0 Streamable HTTP, protocol revision
  `2026-07-28` (`server/discover`) with the legacy `initialize` fallback, and
  six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) over the same store as REST.

## Running

Requires Node 22.18+ (type stripping is built in; no build step, no dependencies).

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

The server binds an ephemeral port on `127.0.0.1`. When `MAKEFUN_ENV_URL` is
set (the grading harness), it POSTs `{"port": N}` to `$MAKEFUN_ENV_URL/register`,
polls `$MAKEFUN_ENV_URL/done`, and exits 0 when the harness is done. Without
that variable it just serves until killed, which is how the local conformance
run works:

```sh
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types main.ts &
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token test-token
```

## Design notes

- **Authentication**: every API call must carry `Authorization: Bearer
  <MAKEFUN_SHOP_TOKEN>`; without the token env var, any non-empty bearer is
  accepted. `/healthz` is unauthenticated; the git endpoints do not enforce
  auth (the suite never requires a 401 there). Every response carries an
  `X-GitHub-Request-Id`.
- **Viewer identity**: the scenario's viewer is fixed by the kit's seed, so the
  forge serves as `adaiversen` (id 1000). Repositories belong to that user;
  any other owner is a 404, matching GitHub's behaviour for private repos.
- **Determinism**: commit author/committer timestamps and ordering counters
  come from a monotonic counter seeded at 1700000000, never `Date.now()`, so
  repeated runs on one instance behave identically.
- **Merge semantics**: a squash merge takes the head tree with the base tip as
  parent; a merge conflicts when a file changed on both sides of the merge
  base resolves to different blobs. After a merge the pull request is closed,
  `merged: true`, with `merged_at` and `merge_commit_sha` set.
- **Shallow fetch**: depth-limited commit walks with an exact boundary set;
  `shallow` lines list the boundary, `unshallow` lists previously-shallow
  commits that are now included.

## Layout

- `main.ts` — the whole forge (~3,000 lines): object model and packfiles,
  in-memory store, REST, GraphQL, MCP, git smart HTTP, router, lifecycle.
- `package.json`, `tsconfig.json` — Node 22, ESM, strict, erasable TypeScript.
- `LICENSE` — MIT.

## License

MIT — see `LICENSE`.
