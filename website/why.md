---
title: Why Inlay
sidebar: false
---

# Why Inlay

Inlay is a CMS for content sites. You build the site in code: its templates, the blocks they're made of, its collections, site-wide content and languages. The site's owner fills in the content, in the slots you cut for it. Everything lives in one SQLite file. Inlay is the whole server: you pack the site into a signed release, push it to a host running `inlaycms serve`, preview it on the live content and activate it when it's ready.

This page is for a developer deciding whether Inlay fits: why we made it, the bet it makes on assistants, and what follows from that bet.

## Why we made it

The CMSs we tried all sat at the wrong point. Each camp gets something right, and each falls short for a site that its owner runs long after the developer has moved on.

### Schema in the database

WordPress-style systems and Directus. They get the owner's side right: a real server, with sign-in, where editors change the site without waiting for a developer. But the content model is reshaped at runtime, so rebuilding a site from code means replaying seed files, and editors and plugins can move the walls. The design is only as safe as the last person who changed a setting.

### App frameworks

Payload and Strapi. The right model, with the schema in code, so the site can be rebuilt, reviewed and versioned like the rest of the code. But heavy: you end up building a whole app, and looking after it, when what you wanted was a content site.

### Git- or file-based

Keystatic, Tina and Decap. Also the right model, and light: content sits next to the code, and there's little to run. But too light: there's no real server, so no history, no sign-in, and nothing for an assistant to talk to.

### Between them

Inlay sits between them. Templates and schema are code, the database only ever holds content, and the server is real enough to provide history, drafts and publishing, accounts, backups and an MCP server.

## Built for an assistant

That last one matters most. We expect most owners to run their site by talking to an AI assistant: "change the home page headline", "write a post from these notes", "translate About into Spanish". The admin is for looking, checking and fixing, and has full hand-editing as the fallback. The goal is a site a non-technical owner can run mostly through an assistant, without ever being able to break the design the developer built.

So the assistant gets a proper way in. Every site has an MCP server at `/mcp`; the owner signs in with their Inlay account and allows the assistant on a consent page. Every change the assistant makes is a draft with a preview link, and nothing goes live until the owner confirms a publish. The labels and help text you write in code are what the assistant reads, so it knows what each field is for. Releases can't be pushed or activated over MCP: the site's code stays yours. [Connect your assistant](/docs/guides/assistant) walks through it.

## What follows from that

A few things follow from that.

### No page builder

Editors fill slots. They never rearrange the layout or add sections, so every arrangement a page can take is one the developer designed. That holds for an assistant too: it fills the same fields an editor does, so "make the home page more exciting" can change the words but not the layout. You decide what a page is made of with templates, blocks and slots; the [content model](/docs/guides/content-model) guide covers what their fields can hold.

### Problems are caught before deploy

`inlaycms check` tells you whether the content fits new site code before you ship it, rather than a running site finding out. Run it in CI against the code alone, or with `--db` against the site's database. `inlaycms pack` type-checks the site when it has a `tsconfig.json`, and `inlaycms push` reports what a release would change before it goes live, including published pages a new required field leaves with a gap. Even then, a schema change never stops the site from starting: stored content is read against the current code, and values that don't fit take their defaults. See `check` and the other commands in the [CLI reference](/docs/reference/cli).

### The site belongs to its owner

It runs on their server, with their data and their backups, and the [export format](https://github.com/donstephan/inlaycms/blob/main/docs/export-format.md) is documented well enough to read without Inlay. Inlay backs the site up every day and after publishing, and an export carries the content and its history to another install. [Backups, export and restore](/docs/guides/backups) covers both.

### One install per site

An agency with ten clients runs ten installs, and can come back months later to push an update. Each update is a signed release: a host runs only releases signed with a key it trusts, previews a pushed release on a copy of the live content, and rolls back by making an earlier release live again. [Releases and hosting](/docs/guides/releases) shows how to pack, push and activate one.

## Try it

The [quickstart](/docs/quickstart) takes you from `npm install` to a site running on your computer. No Node? [The Docker image](/docs/docker) runs every command instead.
