# dsh-web-search-kagi

Kagi Search API v1 provider for the DeepSeek Harness web capability seam
(`ctx.web`).

The package registers a `WebSearchProvider` with the id `kagi`. Each search
POSTs to Kagi's `/search` endpoint with bearer authentication and maps
`data.search[]` onto the seam's portable citation shape (`url`, `title`,
`snippet`, `publishedAt`). Provider selection, result capping, cancellation
plumbing and error routing stay owned by `@deepseek-ai/dsh-web`; this package
owns only the Kagi wire format.

Verified against the published OpenAPI document
(<https://kagi.com/api/docs>) and a live unauthenticated probe of
`https://kagi.com/api/v1/search`.

## Install

Add the package to the profile that runs the web app. From a checkout:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-web-search-kagi
```

Or from a registry, if you publish it:

```sh
dsh plugin --profile web add dsh-web-search-kagi
```

Then compose it in `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
# Mount the Kagi provider.
- insert:
    - id: web-search-kagi
      name: 'dsh-web-search-kagi'

# Point the web seam at it.
- id: web
  config:
    searchProvider: kagi

# Stop mounting the shipped DeepSeek provider so the two never compete.
- id: web-search-deepseek
  disabled: true
```

The `web` profile uses live reload, so a running harness recomposes on save.
Without live reload, restart the harness.

Optional per-instance configuration goes on the inserted row:

```yaml
- insert:
    - id: web-search-kagi
      name: 'dsh-web-search-kagi'
      config:
        apiKeyEnv: KAGI_SEARCH_API_KEY
        limit: 10
        safeSearch: true
```

## API key

Create a key in the Kagi API portal (<https://kagi.com/api/keys>). The provider
resolves `KAGI_SEARCH_API_KEY` through `ctx.credentials`, which layers the
process environment, the invoking directory's `.env`, the harness home `.env`,
and the provider-managed store. The simplest durable option is
`$DSH_HOME/.credentials.yaml`:

```yaml
KAGI_SEARCH_API_KEY: your-kagi-api-key
```

A literal `apiKey` in the row config also works, but keeps the secret in
configuration; `apiKeyEnv` is preferred. A missing key fails the call with
`WEB_PROVIDER_CREDENTIAL_MISSING` naming the reference, without dispatching a
request.

This package ships no browser settings card, so the key is not editable from
**Settings → Plugins**. Configure it through the credentials file or the
environment. (The shipped DeepSeek provider has its own card in
`@deepseek-ai/dsh-client-ui-settings-web-search`; a Kagi card would be a
companion client package, not this one.)

## Config

Every field is volatile: a change is committed into the live references rather
than remounting the plugin, so the running provider serves the next search with
the new value.

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKey` | (omitted) | Literal Kagi API key. A non-empty literal wins over `apiKeyEnv`. |
| `apiKeyEnv` | `KAGI_SEARCH_API_KEY` | Credential reference resolved once per search. |
| `baseURL` | `https://kagi.com/api/v1` | Kagi API v1 base; `/search` is appended. |
| `limit` | `10` | Upper bound on results requested from Kagi, 1 to 1024. |
| `workflow` | `search` | Kagi workflow: `search`, `news`, `images`, `videos`, `podcasts`. |
| `safeSearch` | `true` | Sends Kagi `safe_search`. |
| `timeoutMs` | `30000` | Per-search timeout, combined with the caller's cancellation signal. |

`limit` is a cost/latency optimization only: the request asks for
`min(limit, request.maxResults)`, and the seam still enforces `maxResults` on
what comes back.

## Behaviour

- **Request**: `POST {baseURL}/search`, `authorization: Bearer <key>`, body
  `{ query, workflow, format: 'json', limit, safe_search }`. Redirects are
  rejected rather than followed.
- **Response**: `data.search[]` is mapped; when that group is empty the
  provider falls back to Kagi's other page-bearing groups (`news`,
  `interesting_finds`, `code`, …). Sources are deduplicated by URL, and blank
  titles, snippets and timestamps are omitted rather than invented. `time`
  becomes `publishedAt`.
- **Availability**: `available()` is a purely structural, network-free check.
  It deliberately does not prove a key is present, because the credential
  service cannot be read synchronously; reporting `false` there would make a
  pinned provider look unavailable while its key is stored. A missing key
  therefore surfaces at search time.
- **Errors**: transport, HTTP, and body failures are `WEB_PROVIDER_ERROR`;
  caller cancellation is `WEB_ABORTED`; a missing key is
  `WEB_PROVIDER_CREDENTIAL_MISSING`. Both the live `errors[]` envelope and the
  OpenAPI-documented `error[]` spelling are read for the diagnostic sentence.

## Development

The source of truth is TypeScript under `src/`; `lib/` is build output, exactly
as the shipped `@deepseek-ai/dsh-*` packages are laid out. `lib/` is
**gitignored** — a fresh clone has no built plugin until `pnpm build` runs, so
`$DSH_HOME/bin/bootstrap.sh` builds it before the harness starts.

| Path | Role |
| --- | --- |
| `src/provider.ts` | The provider: Kagi wire format, response mapping, error taxonomy. No cordis dependency. |
| `src/index.ts` | The plugin entry: `name`, `inject`, the `Config` schema plus its `Volatile<T>` interface, and `apply`. |
| `lib/index.js`, `lib/provider.js` | `tsc` output, the artifact the harness loads. Gitignored. |
| `lib/types/*.d.ts` | `tsc`-emitted declarations (not hand-maintained); gitignored with `lib/`. |
| `test/provider.test.mjs` | Provider tests against a local mock HTTP server. |
| `test/e2e/` | The loader-level probe described in [test/e2e/README.md](test/e2e/README.md). |

```sh
pnpm install
pnpm build       # tsc -> lib/
pnpm typecheck   # tsc --noEmit
pnpm test        # rebuilds lib/ first, then runs node --test
```

The tests are self-contained: the harness packages are peer dependencies and
also devDependencies, so `@deepseek-ai/dsh-web` and friends resolve locally for
typechecking and testing. In a real profile the launcher's runtime resolution
takes precedence for those peer names, so the installed plugin always shares
the harness's own module instances.
