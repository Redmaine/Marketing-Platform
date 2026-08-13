Vendored copy of [imagescript](https://deno.land/x/imagescript) **1.2.15**,
fetched directly from `https://deno.land/x/imagescript@1.2.15/` on 13 Aug
2026, with one deliberate patch to every `utils/wasm/*.js` loader.

## Why this is here instead of a remote import

Every `utils/wasm/*.js` loader in this library (gif, png, font, jpeg, svg,
tiff, zlib) fetches its `.wasm` binary from deno.land's CDN at module
top-level via a top-level `await`. That CDN serves every one of those
assets with a `Content-Encoding: br` response header, but the response body
is already plain, uncompressed WASM — confirmed directly: every asset's raw
bytes start with the `\0asm` magic number even when fetched with
`Accept-Encoding: identity`. Supabase's Edge Runtime (Deno) honours the
(wrong) header and tries to brotli-decode already-plain bytes, which fails
with `TypeError: brotli error` — an uncaught event-loop error that crashes
the importing function before any of its own code (including its own
try/catch and logging) ever runs. This took down `crhq-nightly-content`
silently — see `_shared/image.ts`'s own comment for the full incident.

## Why the loaders are patched, not just vendored unmodified

Each loader already special-cased local-vs-remote loading: `new
URL(import.meta.url.replace('.js', '.wasm'))` resolves to a `file:` URL
when the `.js` file itself is loaded from disk, and the original code did
`'file:' === path.protocol ? Deno.readFile(path) : fetch(...)`. That looked
like it should "just work" by vendoring the source unmodified — but
Supabase's `functions deploy` bundler only includes files it can see via
*static* `import`/`export` statements (real module-graph analysis). A
`Deno.readFile()` call with a computed path is a *dynamic* runtime file
read, invisible to that analysis — so the raw `.wasm` binaries themselves
never made it into the deployed bundle at all (confirmed live: `NotFound:
path not found: .../utils/wasm/zlib.wasm` at runtime, despite the file
existing right there in this same directory locally).

Fix: every WASM binary is base64-encoded into a matching `<name>.wasm.b64.ts`
file (`export default "<base64>"`), and each loader's WASM-instantiation
line is patched to `import wasmB64 from './<name>.wasm.b64.ts'` +
`Uint8Array.from(atob(wasmB64), (c) => c.charCodeAt(0))` instead of
`Deno.readFile`/`fetch`. That's a real static import, so the bundler
includes it like any other source file. Nothing else in any loader was
changed — same WASM bytes, same `WebAssembly.Module`/`Instance` calls,
just a different (bundler-visible) way of getting the bytes in.

## Updating

If bumping to a newer imagescript version: re-fetch the *entire* tree (every
relative import must resolve to a local file, including the ones nested
under `v2/` and `png/` — the "v2" framebuffer API pulls in its own separate
PNG codec, easy to miss), THEN re-apply the same patch to every
`utils/wasm/*.js` loader — base64-encode the `.wasm`, replace the
`Deno.readFile`/`fetch` block with the `atob`-decode block, delete the raw
`.wasm` (it's dead weight once nothing reads it — the bundler doesn't know
to upload it anyway).

Do not hand-edit anything beyond that one block per loader — if imagescript
ships a real fix for the upstream CDN issue, or restructures WASM loading
entirely (1.4.0 moved to native `import ... from './x.wasm'`, which failed
differently here — Supabase pins Deno 1.46, and full native-WASM-import
support only landed in Deno 2.1), re-vendor from scratch rather than
patching around a new pattern blind.
