# Actual MCP for the NAS

Deployed on the NAS (`financial` stack) at `https://actual-mcp.robbedekien.be/mcp`, behind Access app "Actual MCP" (service token `actual-mcp` only) plus the bearer.

## Deploy / update

Portainer does not build images, and the NAS Docker has no BuildKit. Build on the NAS over SSH with the classic builder, then redeploy the stack (`pull_policy: never` makes it use the local image):

```sh
cd services/actual-mcp
COPYFILE_DISABLE=1 tar --no-xattrs -cf - Dockerfile upstream.patch package.json package-lock.json secrets.ts finance.test.ts \
  | ssh robbedekien@ssh.robbedekien.be 'export PATH=/usr/local/bin:$PATH; rm -rf /tmp/amb && mkdir /tmp/amb && cd /tmp/amb && tar -xf - && DOCKER_BUILDKIT=0 docker build -t actual-mcp:1.14.0-actual26.10 .'
```

Bump the image tag in `docker-compose-finance.yml` and the command together when the build inputs change.

The build fetches s-stefanov/actual-mcp **1.14.0**, commit `16c9274ab4a4370bafb529ff4e20200e5217cbfd`, verifies archive SHA-256 `defd622c94361b771e32b257212d0d971406cddb63dbc4149218a5561175630c`, applies `upstream.patch` and uses this package/lock pair. Both `@actual-app/api` and `@actual-app/core` are pinned to **26.10.0**, matching the existing Actual server. Upstream source is fetched only in the build stage; its license is retained in the runtime image. Source is not vendored here. `secrets.ts` and `finance.test.ts` are copied into the upstream connection directory.

## Required inputs before deployment

Supply the existing authorized owner's Actual **OpenID session token**, the chosen budget's **Sync ID** (Settings → Advanced), its **E2EE password**, an independent random **MCP bearer** (at least 256 bits), and Cloudflare Access service-token Client ID/Secret. Obtain the Actual token from the owner's authenticated session; it is not an OIDC client secret or an Access token. Both clients use this same Actual owner and budget. No password login is enabled.

Choose a real MCP hostname and its Access application audience (AUD). The `.invalid` hostname and AUD placeholder in these examples are intentionally unusable. The MCP Access application needs a **Service Auth** policy restricted to the designated service token. Keep Actual's existing browser/OIDC Access application and policies.

On the NAS, provision four files outside the checkout and backup sources, in a directory owned by `1026:100` with mode `0700`:

| File | Contents |
| --- | --- |
| `session-token` | Actual owner's session token |
| `budget-sync-id` | Selected encrypted budget's Sync ID (the file's `group_id`, not its file id) |
| `e2ee-password` | Its E2EE password |
| `mcp-bearer` | Independent MCP bearer |

Files must be regular files owned by UID 1026, mode `0400` or `0600`, with one nonempty value (optional final newline). Symlinks, public files and embedded newlines are rejected. Use a protected transfer/editor; do not paste values into commands, repository files or rendered Compose output. The directory is `/volume2/docker/services/actual-mcp/secrets`, mounted read-only at `/run/secrets`. Existing `ACTUAL_OPENID_CLIENT_SECRET` and `ACTUAL_BACKUP_GPG_PASSPHRASE` still come from the current protected stack configuration.

## Runtime boundary

`actual-mcp` connects only to `http://actual:5006` on the finance network. Host port 5007 binds only to `127.0.0.1`, for the host-network cloudflared origin. Read-only mounts hold secrets; decrypted cache lives in a 256 MiB tmpfs at `/data` and disappears when the container is removed. It is not in the Actual data or backup mounts, so no backup exclusion change is needed. tmpfs can be swapped by the host: do not claim this protects against NAS root access or unencrypted host swap. Increase its size only if the selected budget requires it.

`restart: unless-stopped` brings it back after a NAS reboot; a restart never replays a request, but see the failed-mutation note below. Existing bank sync remains outside the MCP tool allowlist.

Use the **existing cloudflared native validator**, with `originRequest.access.required: true`, the correct team and this MCP application's AUD. `cloudflared.example.yml` is an ingress template to merge into the existing tunnel configuration once the required inputs and Access policy exist; do not replace the entire tunnel. Native Access JWT verification must be active before exposing the hostname. MCP checks the independent bearer on every HTTP/SSE request. Loopback is a trusted NAS-host boundary; other local privileged processes can reach it. No extra JWT framework is installed. See [Cloudflare origin parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/cloudflared-parameters/origin-parameters/#access).

Every data operation is serialized through upstream's connection queue, validates the owner token against Actual, and syncs before using data. Initialization requires the specified remote budget to be encrypted. A result is returned only after a second successful sync, including dashboard writes through Actual's existing internal handlers. This also syncs after reads to keep one shared boundary. A token/network/API/sync failure latches the connection unavailable; later calls cannot serve cached data or replay a mutation. Unexpected asynchronous exceptions terminate the process. API logs are suppressed and errors are generic to avoid credential/data leaks.

After a failed mutation its outcome may be unknown: it may already have reached Actual. Do not retry it automatically. Inspect the authoritative budget, resolve the outcome, restore valid inputs/connectivity and explicitly recreate the MCP container. Shutdown unloads the budget before calling API shutdown, which would otherwise attempt another sync. Restarting discards the tmpfs cache; unconfirmed local-only changes may be lost.

Read/report/dashboard, rule/category/payee create/update, and transaction create/import/update tools remain available. Delete tools, bank sync, widget removal and budget-allocation mutations are excluded from both listing and dispatch. Account and budget deletion are not registered. The allowlist is defined directly in the patched `src/tools/index.ts`.

## Shared Keychain client helper

In macOS **Keychain Access**, create three generic password items with these service names and a single consistent account, using secure entry:

- `actual-mcp-access-id`: Cloudflare service-token Client ID.
- `actual-mcp-access-secret`: Cloudflare service-token Client Secret.
- `actual-mcp-bearer`: the same independent bearer provisioned on the NAS.

`client-headers.py` reads those items through `/usr/bin/security`, returns one JSON header object to the MCP client, and fails without printing values on missing/invalid credentials. Its successful stdout necessarily contains credentials for the client: **do not run it interactively or capture its stdout in logs**. It requires macOS, Python 3.11+ and an unlocked Keychain; never copy it or the client credentials to the NAS. Keep each service name unique; remove obsolete duplicate entries. Rotating an item is picked up when the client's native helper refreshes headers; reconnect clients after rotation.

`codex.example.toml` and `claude.example.json` use the **same absolute helper command**. Replace `.invalid` with the verified HTTPS endpoint and update the helper path if this worktree moves. They contain no credential values. Native HTTP helper support is documented by [OpenAI](https://developers.openai.com/codex/mcp) and [Claude Code](https://code.claude.com/docs/en/mcp#use-dynamic-headers-for-custom-authentication), and parsed successfully here by Codex CLI 0.159.3 / Claude Code 2.1.289. Desktop/remote execution environments that do not run local header helpers are not covered by this preparation.

Only after credentials, deployment and verified Access gates exist: merge the TOML table into `~/.codex/config.toml`; use the Claude JSON as the requested project's `.mcp.json` or pass it via `claude --mcp-config /absolute/path/claude.example.json`. If user-scope Claude registration is desired, register the `actual` object with `claude mcp add-json --scope user`; the whole `mcpServers` wrapper is not the add-json argument. No global configuration has been edited.

Both clients should read first and keep dashboard/categorization/transaction changes within the user's authorized scope. The already-authorized setup and categorization work requires no additional owner approval. A failed write is not evidence it was unsaved. Never invoke bank synchronization or deletion through this MCP. This service provides no Jeff integration.

## Reproduce preparation checks (no production credentials)

From the isolated worktree root:

```sh
docker build --progress=plain -t home-server/actual-mcp:finance-check services/actual-mcp
(cd services/actual-mcp && npm audit --omit=dev)
python3 services/actual-mcp/client-check.py
ACTUAL_OPENID_CLIENT_SECRET=DUMMY-DO-NOT-DEPLOY ACTUAL_BACKUP_GPG_PASSPHRASE=DUMMY-DO-NOT-DEPLOY docker compose -f docker-compose-finance.yml config --quiet
docker run --rm --network none --user 0 --read-only --tmpfs /run/secrets:mode=0755 --tmpfs /data:uid=1026,gid=100,mode=0700 --tmpfs /tmp --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add KILL --security-opt no-new-privileges:true --entrypoint node -v "$PWD/services/actual-mcp/transport-check.mjs:/app/transport-check.mjs:ro" home-server/actual-mcp:finance-check /app/transport-check.mjs
```

The image build runs TypeScript build, the one focused Vitest file, and scoped ESLint. Native transport testing uses disposable dummy secret files in tmpfs, no external network and no real budget. It also exercises the real Actual API 26.10 token-only initialization against a mock loopback origin, rejecting revoked tokens and an unavailable server. `client-check.py` mocks Keychain reads, validates both template shapes, and parses them with the installed Codex/Claude CLIs in temporary configuration directories, without reading credentials or modifying global config. No production authentication, Access rejection, encryption download or persisted dashboard/rule/transaction write has been tested. Validate these later against a disposable encrypted budget before connecting the live budget.

The six inherited production audit findings are resolved by compatible locked versions: `fast-uri` **3.1.8**, `hono` **4.13.7**, `ip-address` **10.7.1**, `@hono/node-server` **1.19.15**, `qs` **6.16.0** and `body-parser` **2.3.0**, plus their required dependencies. Direct dependency pins are unchanged; no overrides or advisory exclusions are used. Re-run the production audit before publishing the endpoint.
