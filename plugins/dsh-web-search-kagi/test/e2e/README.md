# End-to-end probe

Proves the whole path — profile loader → `ctx.web` seam → this provider → HTTP
→ result mapping — inside a real composition, without a Kagi key and without
touching your normal harness home.

## Procedure

```sh
PKG=/absolute/path/to/dsh-web-search-kagi
export DSH_HOME=/tmp/kagi-e2e-home

# 1. Mock Kagi on 127.0.0.1:8788 (leave running).
node "$PKG/test/e2e/mock-kagi.mjs" 8788 &

# 2. Initialize a throwaway web profile and install both packages into it.
dsh plugin --profile web add "$PKG"
dsh plugin --profile web add "$PKG/test/e2e/kagi-probe"

# 3. Compose the provider, the probe, and the pin.
cat > "$DSH_HOME/profiles/web/cordis.patch.yml" <<'YAML'
- insert:
    - id: web-search-kagi
      name: 'dsh-web-search-kagi'
      config:
        baseURL: 'http://127.0.0.1:8788'
        apiKey: 'probe-key'
    - id: kagi-probe
      name: 'kagi-probe'
- id: web
  config:
    searchProvider: kagi
- id: web-search-deepseek
  disabled: true
YAML

# 4. Boot on an unused port; the probe fires a few seconds in.
dsh --profile web --no-open --port 8099
```

## Expected

Mock server stdout:

```text
MOCK POST /search auth=Bearer probe-key body={"query":"probe query","workflow":"search","format":"json","limit":5,"safe_search":true}
```

Harness stdout:

```text
dsh web: http://127.0.0.1:8099/?token=...
PROBE ok sources=2 [{"url":"https://example.com/kagi-result","title":"Mock Kagi result","snippet":"Returned by the local mock Kagi server.","publishedAt":"2025-02-03T04:05:06Z"},{"url":"https://example.com/second","title":"Second result"}]
```

With no `apiKey` and no `KAGI_SEARCH_API_KEY`, the probe line instead reads
`PROBE error code=WEB_PROVIDER_CREDENTIAL_MISSING ...`, which is the same proof
that the pinned provider was selected and reached.

Delete `$DSH_HOME` when finished.
