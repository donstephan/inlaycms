# MCP acceptance checklist

This is a manual check of Inlay's MCP server against real Claude clients. Run it against the example site whenever the auth or MCP code changes in a way the tests can't cover: the OAuth handshake, the consent page, how each client shows tools, and whether it supports elicitation.

The automated version of the same session is `tests/mcp/agent-session.test.ts`. If that test fails, fix it before you start here.

## Before you start

1. **Start from fresh data.** The session below translates About into Spanish, so the database must not already hold that translation. Remove the dev data volume first. This deletes the example database:

   ```sh
   docker compose down
   docker volume rm inlay_data
   ```

2. **Start the dev service:**

   ```sh
   docker compose up -d --build dev
   docker compose logs -f dev    # keep this open: it's the server log
   ```

3. **Create the owner.** Open `http://localhost:3000/admin`. It sends you to `/admin/setup`. Create the owner account and note the password.

The server's base URL has to be the exact address the client uses: OAuth tokens are issued for `<base URL>/mcp`, and browser forms are checked against it. So test Claude Code against `http://localhost:3000` first, then restart with the tunnel URL for Claude Desktop and claude.ai.

## Connecting each client

### Claude Code (localhost)

```sh
claude mcp add --transport http inlay http://localhost:3000/mcp
```

Start `claude`, run `/mcp`, choose `inlay` and authenticate. A browser opens on the Inlay login page.

### Claude Desktop and claude.ai (HTTPS tunnel)

Both need a public HTTPS address, so put a tunnel in front of the dev service. Use either of these:

```sh
cloudflared tunnel --url http://localhost:3000    # prints https://<random>.trycloudflare.com
ngrok http 3000                                   # prints https://<random>.ngrok-free.app
```

Restart the dev service with the tunnel URL as its base URL. Use the exact origin, with no trailing slash. `docker compose run -e` overrides the `INLAY_BASE_URL` in `docker-compose.yml`:

```sh
docker compose stop dev
docker compose run --rm --service-ports -e INLAY_BASE_URL=https://<tunnel-host> dev
```

Check that `https://<tunnel-host>/.well-known/oauth-protected-resource/mcp` returns JSON whose `resource` is `https://<tunnel-host>/mcp`.

- **Claude Desktop:** Settings → Connectors → Add custom connector. URL `https://<tunnel-host>/mcp`. Then Connect.
- **claude.ai:** Settings → Connectors → Add custom connector. Use the same URL, then Connect.

A free tunnel URL changes every time the tunnel restarts. When it does, restart the dev service with the new URL and add the connector again.

## What to check, for each client

Work through these steps in order, in one conversation where you can.

1. **Connection and consent.**
   - Connecting opens the Inlay login page. Logging in leads to the consent page.
   - The consent page names the client and the host it will send you back to (`claude.ai`, `localhost`, and so on).
   - Allow → the client shows as connected. Deny → the client reports that access was refused, and no tools appear.
   - better-auth remembers consent per client. A client you have already approved skips the consent screen on reconnect, which is expected. A new or look-alike client (a new registration under another name or redirect host) must still see the consent page.
2. **Tools listed.** The client lists 23 Inlay tools, with readable titles: `describe_site`, `describe_type`, `get_document`, `search_entries`, `update_document`, `create_entry`, `create_translation`, `delete_entry`, `list_pending_changes`, `get_preview_link`, `list_revisions`, `diff_revisions`, `restore_revision`, `publish`, `unpublish`, `list_media`, `set_media_alt`, `delete_media`, `upload_media_from_url`, `request_media_upload`, `list_redirects`, `create_redirect` and `delete_redirect`.
3. **"Change the home page headline to Websites you can run yourself."**
   - The assistant reads the site and Home, then updates `slots.hero.data.headline`.
   - It gives you a preview link. The link opens the draft with the new headline. In a private window, the public `/` still shows the old one.
4. **"Write a post from these notes: we moved into a bigger studio with a garden; same phone and email; meetings can happen outdoors; free parking on Fridays. Use the hero image."**
   - A draft post appears, with Markdown turned into a heading, a list and the image (`inlay:media/<id>` from `list_media`).
   - The preview link shows it.
5. **"Translate About into Spanish."**
   - The assistant calls `create_translation`, then updates the Spanish fields.
   - The preview of `/es/acerca` is in Spanish.
6. **"Publish."**
   - **If the client supports elicitation:** an in-client confirmation lists each document and its first changes. Accept → it's live. Try Decline once too: nothing is published.
   - **Otherwise:** the assistant gives you a confirmation link to `/admin/publish?ids=…`. Open it, check the list, and press Publish.
   - Either way, the public pages now show the new copy.
7. **"Undo that."**
   - The assistant lists revisions and restores the previous one (`restore_revision`), which makes a new draft.
   - Publishing it again goes through the same confirmation.
8. **"Replace the home page image with a photo I'll give you."**
   - The assistant calls `request_media_upload` and gives you an `/admin/upload?token=…` link.
   - Upload a photo there, tell the assistant it's done, and it sets the new image on Home's hero. The preview shows it.

## What to record

Copy this table for each run, one row per client.

| Client | Version | Protocol era | Consent page shown | Elicitation for publish | Steps that failed, with the error |
| --- | --- | --- | --- | --- | --- |
| Claude Code | | | | | |
| Claude Desktop | | | | | |
| claude.ai | | | | | |

- **Protocol era (2025 or 2026).** To read it from the server log, look for `GET /mcp` answered with `405`. That's a 2025-era client opening its event stream, which the stateless server doesn't offer. A 2026-era client sends only POSTs. To see the exact version, read the `mcp-protocol-version` request header in the tunnel's request inspector (ngrok: `http://localhost:4040`).
- **Elicitation.** Did the publish confirmation appear inside the client, or did you get a link? A 2025-era client always gets the link, even if it supports elicitation.
- **Failures.** For any failure, record the step, what the client showed, and the matching lines from the server log.

## If a client won't register: CIMD

Claude's connectors normally register themselves through dynamic client registration. Some clients use Client ID Metadata Documents (CIMD) instead: an HTTPS URL as their `client_id`. A client that does this fails before the login page, usually with an error about an unknown client or about registration.

If you see that:

1. Install `@better-auth/cimd`, and add `cimd()` to the better-auth plugins in `src/core/auth/auth.ts` as its README describes.
2. Rerun `pnpm test tests/core/auth.test.ts tests/auth/oauth.test.ts`, then this checklist.
3. Record here which client needed it, and which versions.

### CIMD notes

_None yet._
