# Modifier Console

A static, GitHub-Pages-ready site for browsing "star tier" modifiers,
selecting a combo, and sharing the result as a permalink.

Important note on stack: **GitHub Pages only serves static files** — it
does not run Flask, EJS, or any server-side templating. So this is built
as plain HTML / CSS / vanilla JS (`.mjs`/`.cjs` module systems aren't
needed either, since there's no bundler step). This runs as-is with zero
build step, which also makes it the most portable option if you ever
want to mirror it somewhere other than Pages.

## Structure

```
index.html
css/style.css                theme (dark red / grey-black), layout, Zekton @font-face
js/app.js                     all logic: versions, fetch, registry, selection, permalink
data/versions.json            list of available data versions + which one loads by default
data/<version>/1-stars.json   tier 1 modifiers for that version
data/<version>/2-stars.json   tier 2 modifiers for that version
data/<version>/3-stars.json   tier 3 modifiers for that version
data/<version>/4-stars.json   tier 4 modifiers for that version
data/<version>/stars-map.json boost thresholds for that version's 0–4 star gauge
data/<version>/conflict.json  optional: mutually-exclusive modifier groups
fonts/Zekton.ttf              ← add this yourself (folder ships empty, with .gitkeep)
```

Ships with two example versions, `data/v1/` and `data/v2/`, so you can
see the version switcher work out of the box.

## JSON format

Each `N-stars.json` is a **flat array, in display order**, of single-key
objects — one object per modifier. Each modifier carries its own
`boost`, so boosts do **not** need to be sorted; the array can go
`5, 10, 5, 15, 10, 40, ...` in whatever order you actually want them
listed:

```json
[
  { "Early Bird": { "desc": "Must say hi within the first 10 seconds of the encounter.", "boost": 5 } },
  { "Quiet Step": { "desc": "Approach without triggering any alert sounds.", "boost": 10 } },
  { "Polite Guest": { "desc": "Must say hello before making any other request.", "boost": 5 } },
  { "No Second Chances": { "desc": "Cannot repeat a failed action during the encounter.", "boost": 15 } }
]
```

The inner object's key names aren't hard-coded to exactly `desc`/
`boost` — the parser just takes whichever value is a **string** as the
description and whichever value is a **number** as the boost, so
`{ "description": "...", "boost%": 5 }` (or any similar variant) parses
identically. What matters is: one modifier name per object, and the
array order is the display/ID order.

`data/<version>/stars-map.json` sets the minimum total boost needed for
each star rating (each version can have its own thresholds):

```json
{ "zero": 0, "one": 50, "two": 150, "three": 250, "four": 350 }
```

## Versions

`data/versions.json` lists which version folders exist and which one
loads by default:

```json
{
  "default": "v1",
  "versions": [
    { "slug": "v1", "label": "V1 — Launch" },
    { "slug": "v2", "label": "V2 — Balance Pass" }
  ]
}
```

- `slug` must match the folder name under `data/` exactly.
- `label` is what shows up in the version dropdown next to "Copy
  Permalink" — change this freely, it's just display text.
- To add a new version: duplicate a `data/<slug>/` folder, edit its
  five files, and add an entry to `versions.json`. To remove one,
  delete its folder and its entry.
- IDs are assigned **independently per version** (see below), so the
  same numeric ID can mean a completely different modifier in `v1` vs
  `v2`. That's expected and is exactly why the version travels with
  the selection everywhere (URL, and local storage keys).

## Conflicts

`data/<version>/conflict.json` is **optional** — omit it (or ship
`{ "conflicted": [] }`) if a version has no mutually-exclusive
modifiers.

The format you described wasn't valid JSON (`{"conflicted":{[...]},{...}}`
mixes `{`/`[` in a way JSON doesn't allow, and repeats the same key
twice in one object). Here's the valid equivalent — an array of
conflict groups, where every modifier inside a group is mutually
exclusive with every other modifier in that same group:

```json
{
  "conflicted": [
    ["Early Bird", "Quiet Step"],
    ["Silver Tongue", "No Witnesses", "Ghost Protocol"]
  ]
}
```

In the second group above: selecting any one of Silver Tongue / No
Witnesses / Ghost Protocol immediately blocks the other two — same
idea as your "Mod A blocks B, B blocks A, A selected means no B or C"
example, just generalized to a group of any size. A modifier can
appear in more than one group if it conflicts with different, unrelated
sets of modifiers.

Matching is by **exact modifier name** against that version's own
data — names should be unique within a version for this to behave
predictably.

**Behavior in the UI:** when a modifier is selected, every other
modifier that conflicts with it gets its row background greyed out,
its checkbox disabled, and hovering the checkbox shows a tooltip
naming what's blocking it. Clicking a greyed checkbox does nothing but
show a toast telling you what to deselect first (the modifier's name
and description are still viewable by clicking its name — only
selecting it is blocked). The modifier you already have selected
itself is never greyed out, so you can always deselect it directly;
doing so immediately un-greys everything it was blocking.

## Global modifier IDs

IDs are **not** stored in the JSON — they're assigned automatically, in
order, the moment a version's data loads:

1. Walk files in order `1 → 2 → 3 → 4`.
2. Within a file, walk the array top to bottom, exactly as written.

The first modifier encountered gets `id = 1`, the next `id = 2`, and so
on — starting over at `1` for each version. This means **array order
is meaningful** — adding or reordering a modifier shifts every ID
after it within that version, which will change what old permalinks
for that version point to. Append new modifiers at the end of a file
if you want existing permalinks to stay stable; if you need to
retire/replace a modifier without disturbing IDs, consider cutting a
new version instead of editing the old one in place.

## Permalinks

Selecting modifiers updates the URL live:

```
thisgit.github.io/?b=<base64 of comma-separated selected IDs>&cf=<version slug>
```

Example: on version `v1`, selecting IDs `1, 3, 4` → `b = btoa("1,3,4")`,
giving `?b=MSwzLDQ%3D&cf=v1`. Loading a URL with both params loads that
exact version, decodes `b` against *that* version's IDs, and recomputes
the boost total / star gauge. `cf` is required for `b` to apply — a
`b` value from another version is ignored rather than misapplied to
the wrong modifier set. The "Copy Permalink" button copies the current
URL (including `cf`) to the clipboard.

## Caching

- **JSON data itself is never cached** — every fetch uses
  `cache: "no-store"`, and nothing from `data/` is written to
  `localStorage`. Edit any file under `data/` and the very next reload
  picks it up — no need to clear cache/cookies/history.
- Only two small, non-content things persist in `localStorage`:
  - the current **selection**, namespaced per version
    (`mc_selection::<slug>`), so it survives a revisit without needing
    a permalink;
  - the **last version viewed** (`mc_last_version`), used when there's
    no `?cf=` in the URL.

## Adding the font

`fonts/` ships empty (just a `.gitkeep` so git tracks the folder before
you add anything). Drop `Zekton.ttf` in there — `css/style.css` already
points to `../fonts/Zekton.ttf` via `@font-face`, so nothing else needs
to change. If the file's missing, the browser just falls back to
Chakra Petch.

## Deploying to GitHub Pages

1. Push this folder's contents to the root of a repo (or `/docs`).
2. Add your `Zekton.ttf` into `fonts/`.
3. Repo → Settings → Pages → set the source branch/folder.
4. Your site is live at `https://<user>.github.io/<repo>/`.

No build step, no dependencies beyond the Google Fonts `<link>` for the
body typeface (Chakra Petch) — everything else is self-contained.

## Removing focus/tap highlight color

The default browser blue tap-highlight (mobile) and blue focus ring
have both been removed globally in `css/style.css`, replaced with a
themed red `:focus-visible` outline that only shows for keyboard/
assistive-tech navigation (so mouse/touch interaction stays clean, and
keyboard accessibility isn't lost).
