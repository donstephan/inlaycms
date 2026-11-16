# Admin acceptance checklist

This is a manual check of the admin in a real browser. It covers what the automated tests can't: focus moving where it should, how a screen reader announces the pages, the branded theme, zoom, and an axe audit. Run it against the example site whenever the admin's views, CSS or client code change.

The automated sweep is `tests/admin/a11y.test.ts`, which checks the markup of every screen (labels, headings, landmarks, unique ids, no inline script). If it fails, fix it before you start here.

## Before you start

1. **Start from fresh data,** so the first visit goes to setup. This deletes the example database:

   ```sh
   docker compose down
   docker volume rm inlay_data
   ```

2. **Start the dev service:**

   ```sh
   docker compose up -d --build dev
   docker compose logs -f dev    # keep this open: it's the server log
   ```

3. Use a current Chrome or Firefox with the [axe DevTools](https://www.deque.com/axe/devtools/) extension, and a screen reader (VoiceOver on macOS, NVDA on Windows, or Orca on Linux).

Write down anything that fails, with the screen, the step and what happened.

## 1. Keyboard only

Put the mouse away. Use only Tab, Shift+Tab, Enter, Space, Escape and the arrow keys. On every page, check that the focus outline is always visible and that the order follows the page from top to bottom.

- [ ] Open `http://localhost:3000/admin`. It goes to setup. Press Tab once: "Skip to main content" appears. Press Enter, and focus moves to the page content.
- [ ] Create the owner account on the setup page. You land on the dashboard, signed in.
- [ ] Log out with the "Log out" button in the menu, then log in again from the login page.
- [ ] Go to **Pages**, then open **Home**.
- [ ] Change the hero **Headline**.
- [ ] Under **Features**, press "Add to Features". A new, empty item appears, and focus doesn't jump to the top of the page. Fill in its title and text. On another item, "Move up", "Move down" and "Remove" work, and each button's name says which item it acts on.
- [ ] On the hero **Image**, press "Choose…". The picker dialog opens with focus inside it, and Tab stays inside the dialog. Search, choose an image with Enter, and the dialog closes. Focus is back on "Choose…", and the chosen file's name shows next to it.
- [ ] Open the picker again and press Escape. It closes, focus returns to "Choose…", and the image is unchanged.
- [ ] Press "Save". The page says the changes were saved.
- [ ] Open **About**. Tab into the **Body** text. Type a sentence and select a word with Shift+arrow keys. Shift+Tab to the formatting toolbar. Focus lands on one toolbar button. The Left and Right arrow keys move between the buttons, and Home and End go to the first and last. Make the word bold with Enter. The Bold button now reads as pressed. Tab back into the text.
- [ ] Add a link from the toolbar. The link picker opens. Choose a page, and focus returns to the text.
- [ ] Press "Save and preview". The preview opens and shows your changes.
- [ ] Back in the admin, press "Save and publish" on Home. The page doesn't reload: "Last saved" updates and the "Publish changes" dialog opens with focus on "Publish". Press "Publish". The dialog says "Published", and focus is on "Close". Press it: you're still on Home's editor, now marked "Published". Open `http://localhost:3000/` and the new headline is live.
- [ ] Press "Publish" in the top bar with nothing waiting. The dialog says there is nothing to publish. Escape closes it and focus returns to the button.
- [ ] In the menu, visit Media, Redirects, Users, Backups and Your account. Each one works by keyboard, including the "Delete" and "Remove" confirmation pages.

## 2. Screen reader

Use the screen reader's landmarks list and headings list, and read the forms with Tab.

- [ ] Every page has landmarks for the main menu ("Main menu"), the main content, and, where present, "You are here". Each page has exactly one level-one heading, which matches the page title.
- [ ] On Home's editor, every field is read with its label. "Required to publish" is read as part of the label where it applies. Help text (such as Headline's) is read after the label.
- [ ] Groups (such as the hero's **Button** link) are read as a group named after the field. The choice between "A page on this site" and "A web address" is read as a radio group.
- [ ] Clear the hero's **Headline** and press "Save". The page shows the problem. The field is announced as invalid, and its problem is read with it.
- [ ] Notices ("Your changes are saved") and errors are announced when the page loads.
- [ ] In the picker, the number of results is announced as you type a search.
- [ ] The rich-text **Body** is announced as a multi-line text box named "Body", and its toolbar as "Formatting: Body".
- [ ] Times such as "Last saved" are read in your own time zone.

### Backups, export and import (owner)

- [ ] On Backups, press "Back up now". A new "Made by hand" backup appears in the table, and its "Download" link works by keyboard.
- [ ] Press "Download an export". A `.tar.gz` file downloads.
- [ ] Under "Restore content from an export", the file input has a visible label. Tab to it, choose the file you just downloaded, and press "Check the file" with the keyboard. Focus lands on the new page, and the page title and the one level-one heading read "Review the export".
- [ ] With a screen reader, the table of content types has a caption and column headers, and each status ("What happens") is read as text, not only shown by color.
- [ ] The replace warning is read before the "Restore content" button. Press the button. You land back on Backups with a notice, and a "Before restoring content" backup is listed.
- [ ] Choose a file that isn't an export (for example a text file) and check it. The page shows a plain problem message, with no technical terms, and nothing is changed.
- [ ] Sign in as an editor. Backups is not in the menu, and `/admin/backups` is refused.

### Missing information after a site update

- [ ] Make sure at least one post is published. In `example/site.tsx`, add `subtitle: f.text({ label: 'Subtitle' }),` to the `Post` template's fields and save. `inlaycms dev` restarts the site.
- [ ] The dashboard shows "Missing information on the live site" with a line for Posts, and its link goes to the Posts list. The screen reader reads the line as text.
- [ ] On the Posts list, each published post is marked "Needs attention", read as text, not only shown by color. Drafts that were never published aren't marked.
- [ ] Open a marked post. One notice says it is live with a required field left empty and names Subtitle; the field itself carries the usual "needed before publishing" hint, once, not twice. Fill in Subtitle and publish: the marker and the dashboard line for that post are gone.
- [ ] Put the example back as it was.

## 3. Branded theme

The example site declares `admin: { name: 'Example Studio', logo: '/public/logo.svg' }` in `defineSite`.

- [ ] The header shows the Example Studio logo, and the screen reader reads it as "Example Studio". Browser tab titles end in "Example Studio".
- [ ] `/admin/assets/admin.css?v=…` loads with status 200 (check the Network tab).
- [ ] In `example/site.tsx`, set `theme: 'dark'` next to `name` and save. `inlaycms dev` restarts the site (the log says `site.tsx changed`); reload the page. The admin is dark, and text on buttons, badges and alerts is still easy to read.
- [ ] Set `theme: { colors: { primary: '#ffff00', 'primary-content': '#ffffff' } }` and save. The server log warns once about the contrast of `primary-content` on `primary`. The site still starts.
- [ ] Put the example back as it was.

## 4. Zoom to 200%

Set the browser zoom to 200% on a window about 1280 pixels wide.

- [ ] On the dashboard, a list, Home's editor, Media and History, nothing is cut off or overlapping, and nothing needs sideways scrolling except wide tables.
- [ ] The menu stacks above the content, and you can still reach every item.
- [ ] The picker dialog fits on the screen, and its results scroll.

## 5. axe DevTools

Run axe DevTools ("Scan all of my page") once on each screen. There must be no issues marked **critical** or **serious**. Note any moderate ones.

- [ ] Setup (fresh data), and Login (signed out)
- [ ] Dashboard
- [ ] Pages, Site-wide content, and a collection list (Posts)
- [ ] A new Post (the "Add new" form)
- [ ] Home's editor, and About's editor (rich text)
- [ ] Home's editor, showing a save problem
- [ ] History, and one version from it
- [ ] The publish dialog: the review, and "Published" after it
- [ ] Media, and one file's page
- [ ] The image picker, while it's open
- [ ] Redirects, and Import redirects
- [ ] Users, and one user's page (owner)
- [ ] Your account
- [ ] Backups (owner)
- [ ] Releases, and one release's page (owner)

## 6. Live preview

Use a window at least 1280 pixels wide unless a step says otherwise, and open Home's editor. The page shows on the right, next to the form.

- [ ] Type into the hero **Headline**. The preview shows the new headline within about half a second of when you stop typing. It doesn't flash white, and if you had scrolled the preview down, it stays where it was. The status next to the address reads "Updating…" and then "Up to date".
- [ ] Clear the hero **Headline**. The preview dims, and the status names the field to fill in. A screen reader announces the same message. Type a headline again: the preview is no longer dimmed.
- [ ] Press the Tablet and Phone buttons, then Desktop. The page is shown at that width, scaled down to fit with the zoom (such as "62%") next to the buttons. The pressed button reads as pressed. Reload the page: the size you chose last is still selected.
- [ ] Tab into a field in the **Features** card. The card is marked, the features block is outlined in the preview, and the preview scrolls to it. Tab into a field in the page's own card (at the top). No block is outlined.
- [ ] Click the testimonials block in the preview. Its card opens, the form scrolls to it, and focus lands on its first control. Clicking a link in the preview doesn't go anywhere.
- [ ] Press "Hide preview". The form takes the whole width, and a "Show preview" button appears. Reload: the preview is still hidden. Change a field, then press "Show preview". The preview comes back showing the change.
- [ ] Make the window narrower than 1024 pixels. Only the form shows, with Edit and Preview buttons in the header. Press Preview: the page shows instead of the form, and the screen reader reads Preview as pressed. Press Edit to go back. Both buttons are reached with Tab. Click a block in the preview: you are taken back to Edit, at that block's card.
- [ ] Under **Features**, open one item and close the **Hero** card. Use "Move down" on another item, then "Remove" on a third. Each time, the item you opened is still open, the Hero card is still closed, and the preview shows the new order.
- [ ] Open About's editor. Type in the rich-text **Body** and make a word bold. The preview updates. On Home, choose a different hero **Image** and then remove it. The preview updates each time.
- [ ] Every edit marks the header "Unsaved changes" with a dot. Pressing "Save" still saves, and the preview never saves anything: History shows no new version until you save.
- [ ] Open **Site-wide content**, then **Navigation**. Its editor has no preview pane and no Edit and Preview buttons.
- [ ] Open Home's editor, then log out in another tab. Back in the editor, change a field. The preview says you were signed out. The sign-in page is not shown inside the preview.

## 7. Releases (owner)

Under `inlaycms dev` (the dev service), the Releases screen lists the releases in the data folder but can't preview or activate them. Check that first, then the host with the `serve` service.

- [ ] Signed in as the owner, open **Releases** from the menu. The table lists any releases, each state read as text, not only shown by color. With none, the page says so.
- [ ] Press "Upload a release". The sheet opens with focus inside it and a labelled file input. Choose a file that isn't a release and upload it: the page shows a plain problem message and nothing is listed.
- [ ] Open a release's page if there is one. It says that previewing and activating need the site to run with "inlaycms serve", and has no Activate button.
- [ ] Sign in as an editor. Releases is not in the menu, and `/admin/releases` is refused.

Now the host. Pack the example (`pnpm run example:pack`), then start the host with the example's development key trusted and give it its first release (the commands are in the README under "Running a host"): `INLAY_SECRET` set to 32 or more characters, `INLAY_TRUSTED_KEYS="$(cat example/keys/dev.pub)"`, `docker compose up -d serve`, and `docker compose run --rm -v "$PWD/example/data/release.tgz:/release.tgz:ro" serve node dist/adapters/cli/bin.js activate /release.tgz` while it is stopped. Create the owner at `/admin/setup`.

- [ ] Releases lists the release as "Live". Its page shows its facts (who pushed it, when it went live, the key it was signed with, the secrets it needs), its migration functions and the content it hides ("nothing" on a fresh host), and has neither Activate nor Delete.
- [ ] Change something visible in `example/site.tsx` (add an optional field to a template), pack again, and upload `example/data/release.tgz` with the sheet. You land on the new release's page, "Ready to activate", which lists the field as added and what the release does to the content.
- [ ] Press "Preview". The site opens in a new tab with a banner naming the release. Its `/admin` is the live admin, where everything still works. (The preview's own admin, read-only with a banner naming the release, is never reachable from a browser; `tests/admin/read-only.test.ts` and `tests/host/app.test.ts` cover it.)
- [ ] Back on the release's page, press "Activate". You land on the page again with a notice; the release is "Live" and the first one is "Previously live". The site shows the change.
- [ ] On the first release's page, press "Activate" to roll back, then delete the release that is no longer live. It is marked deleted, and the live release has no Delete button.
- [ ] Put the example back as it was.
