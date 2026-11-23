---
title: Connect your assistant
---

# Connect your assistant

How an editor connects an AI assistant such as Claude to a running site over MCP, and what the assistant can and can't do. Read this when you hand a site to its owner.

Editors run the site from an AI assistant such as Claude, through the MCP server at `https://<your-site>/mcp`.

1. **First run.** Open `https://<your-site>/admin`. With no users yet, it sends you to `/admin/setup`, where you create the owner account. On a server without a browser, `inlaycms create-owner --email <email> --name <name>` does the same and reads the password from stdin. If you are locked out of the only owner account, run `inlaycms reset-password --email <email>` on the server to set a new password.
2. **Connect.** Add `https://<your-site>/mcp` to your assistant as a custom connector. In Claude Code, that's `claude mcp add --transport http inlay https://<your-site>/mcp`.
3. **Log in.** The assistant opens the Inlay login page. Sign in with your Inlay account, then allow the assistant on the consent page. The consent page names the assistant and where it will send you back to, so check both before you allow it.

Every change the assistant makes is a draft with a preview link. Nothing goes live until you confirm a publish, either in the assistant or on the confirmation page it links to.

`describe_site` tells the assistant the name of the release the site runs and, per type, how many published pages and entries are missing something the site now requires (a required field a release added after they were published). `list_gaps` lists those pages and entries with each missing field, so the assistant can fill them in and publish again. Content a release hid (types or languages the site no longer has) isn't readable over MCP; `describe_type` on such a type says it is hidden. Releases can't be pushed or activated over MCP.

To change wording that appears in many places, such as a product name or a button's call to action, `find_text` finds a phrase in every page, global and entry, in every language. It ignores case and accents and matches whole words. It searches text, rich text and button and link labels, but not link addresses, image alt text, or the words of pages designed in code (those are in the site's templates, so only a developer can change them). Each match comes with its field path, the exact way it's written and numbered occurrences with a snippet around each. The assistant then changes each document with `update_document`, using a change like `{ path, find, replace }` that swaps just that text inside the field and keeps the rest of it, its formatting and its links as they are. Adding `occurrences` changes only some of them. Each document becomes its own draft, so you can preview and publish them like any other change.

The manual check against Claude clients is in `docs/mcp-acceptance.md`.

