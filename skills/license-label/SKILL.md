---
name: license-label
description: Make a plain-language "licence label" for the current project - which open-source licences are inside the app, the strictest one, and the minimum the builder must do. Use when someone asks "what licences am I using", "can I sell / ship / host this", "do I need to credit anyone", "is there any GPL in here", asks for a licence check, third-party notices or an SBOM in plain English, or has just added or upgraded dependencies. Also spelled license label.
---

# Licence label

Writes one self-contained HTML page, like a nutrition label, for the open-source parts inside an app. It is for people who build apps (often with an AI coding agent) and are not licence experts.

## Run it

From the project folder:

```bash
node <this skill's folder>/scripts/license-label.js . -o license-label.html
```

- Needs Node 18 or later, which any npm project already has. Nothing to install. It only reads the project and writes `license-label.html` and `license-label.json` (the data, used next time to show what changed).
- `--notices THIRD-PARTY-NOTICES.txt` also collects the licence texts of the packages in the app into one file.
- `--verify` asks deps.dev (a public index run by Google) what licence it has on record for each package in the app, and shows any that land on a different step. Ask before using it: it sends the app's package names and versions to deps.dev.
- `--online` looks up Python licences on pypi.org when the packages are not installed. Ask first, for the same reason.
- `--fail-above 3` exits with code 2 if anything in the app is beyond step 3, or unknown. For hooks and CI.
- `--accept "package=why it is fine"` records that the person has checked a package, so it stops being flagged. It is saved in `license-label.config.json` with the date and the licence it declared, and is asked again if that licence changes.
- `--seen` clears the open flags.
- `--if-changed` only refreshes: it does nothing unless a label already exists and a lockfile changed since it was made.
- `--summary FILE` writes a short Markdown summary, for pull-request comments.

**One label per app.** If the project holds more than one app (for example a product at the root and a marketing site in `website/`), each folder with its own dependencies gets its own label on the page. A licence applies to the software that contains the code, so answer per app: what is inside the website does not change the rules for the product being sold. Ask which app the person means if it is not clear.

**How it is shipped changes the answer.** Each label is written for one of four ways of shipping:

| `--ship` | Means | The label talks about |
|---|---|---|
| `hosted` | People use it over the internet | handing out copies versus running a service |
| `copies` | People download or install it (desktop, phone, on their own servers) | handing out copies |
| `static` | A site built once and served as finished pages | building the site versus what visitors receive |
| `package` | A library or tool published for others to install | what you hand out versus what your users inherit |

The tool guesses from `package.json` and says on the label that it is a guess and what the clue was. Check the guess with the person in plain words ("how do people get this: do they visit it, download it, or install it as a package?"). Set it with `--ship static`, or `--ship website=static` for one folder. To make it stick, offer to write `license-label.config.json` in the project root, which also lets you give each app a proper name:

```json
{ "apps": { ".": { "ship": "hosted", "name": "My product" }, "website": { "ship": "static" } } }
```

What it reads: `package-lock.json` (licences are in the lockfile, including indirect packages). For yarn, pnpm and bun it follows `package.json` through the installed `node_modules`. For Python it reads `requirements*.txt`, `pyproject.toml`, `uv.lock`, `poetry.lock` and `Pipfile.lock`, plus an installed `.venv`.

## The scale

1. **No conditions** - use it however you like (0BSD, Unlicense, CC0).
2. **Keep the notice** - keep the author's copyright and licence text with it (MIT, BSD, ISC, Apache).
3. **Share changes to that part** - your code stays yours; changes to that part's own files are shared (MPL, LGPL, EPL).
4. **Share the whole program** - hand out the app, and the whole app's source goes with it (GPL).
5. **Share it even when hosted** - the same, and it also applies when people only use it over the internet (AGPL).

Anything else (commercial licences, "see licence in file", source-available, missing) is **not open source, or unknown**, and sits off the scale as "needs a look".

Build tools (dev dependencies) are counted separately. They are not part of what gets handed out.

## Then tell the person

After running it, open or link the HTML and say, in this order and in plain words:

1. Which app you are talking about, if there is more than one. Then the strictest step found in that app, and what it means for **handing out copies** versus **running it as a service**.
2. Anything that needs a look. Read that package's licence file and say what it says. Do not guess.
3. The minimum to do (usually: keep the notices; leave share-changes parts unmodified).
4. What moved since the last label, if there was one.

Rules:

- Say "the licence this package declares". Declared licences can be wrong or missing, and the tool does not read every file.
- This is not legal advice. Say so once, plainly. For step 4 or 5, unknowns, or anything that matters commercially, suggest reading the licence and asking a lawyer.
- Be fair to the projects named. A commercial or copyleft licence is a choice, not a fault.
- Mention what the label cannot see: code, fonts, images or snippets copied into the project (including code an assistant pasted in), and online services the app calls.
- Do not change dependencies, add notices files or edit the project unless asked.

## Flags: when to speak up

The tool compares each run with the last one and raises a flag only for these four changes, in the app's own parts (not build tools):

1. The strictest step went up (to step 3 or beyond).
2. A new part arrived at step 4 or 5.
3. A new part cannot be placed on the scale (commercial, unknown, no licence).
4. A part the project already had now declares a stricter licence.

A flag is printed as `FLAG (new)` once, shown in an amber box at the top of the label, and stays open (`FLAG (open)`) until its cause goes away or the person records a check.

When you see a new flag, tell the person straight away, before anything else, in two or three plain sentences: what changed, what it means for how they ship, and one thing they can do (replace the part, read its licence, or record that they checked it). Do not bury it at the end of a long reply and do not decide for them.

Only record a check (`--accept`) when the person tells you they have looked and are fine with it, and use their reason as the note. Never accept on your own judgement.

## Keeping it current

The label is only true for the lockfile it was made from.

- **Claude Code plugin:** if this skill was installed as the `license-label` plugin, a hook already refreshes `license-label.html` in the project root when a lockfile changes, and hands you a message when something is newly flagged. Pass that message on. The hook never creates a label on its own, so make the first one at the project root with the default name.
- **Any agent:** suggest adding one line to the project's `AGENTS.md` or `CLAUDE.md`: "After changing dependencies, run the license-label skill and tell me if the strictest step moved."
- **GitHub:** the `Justusability/license-label` Action remakes the label on pull requests and comments only when the strictest step moves or something unknown arrives.
