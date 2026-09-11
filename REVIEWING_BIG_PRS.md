<p align="center">
  <img src="assets/logo.png" alt="Reviewly" width="96" />
</p>

<h1 align="center">Reviewing a big PR on a repo you don't know</h1>

<p align="center">
  <b>A start-to-finish walkthrough of the fastest path through a 60-, 100-, or 200-file pull request in Reviewly.</b>
</p>

---

Most review tools are built for the ten-line PR. This guide is for the other kind: a large change, in a codebase you haven't worked in, where the expensive part isn't reading the diff — it's working out what the code now *does*, and knowing what you never looked at.

Reviewly's answer is to make the **unread remainder** visible at every level: viewed marks per layer, an evidence grade per AI claim, and unexamined changed lines per PR. You spend attention where it's missing instead of spreading it uniformly.

> New to Reviewly? Start with the [README](README.md) for install and the feature tour. This document assumes the app is running and you're signed in.

## Table of contents

- [The short version](#the-short-version)
- [Phase 0 — Setup that pays for itself](#phase-0--setup-that-pays-for-itself)
- [Phase 1 — Orient before reading a line](#phase-1--orient-before-reading-a-line)
- [Phase 2 — Cut the PR up before reading it](#phase-2--cut-the-pr-up-before-reading-it)
- [Phase 3 — Tour one layer at a time](#phase-3--tour-one-layer-at-a-time)
- [Phase 4 — Working a single stop](#phase-4--working-a-single-stop)
- [Phase 5 — The pass most reviewers skip: coverage](#phase-5--the-pass-most-reviewers-skip-coverage)
- [Phase 6 — Write it up](#phase-6--write-it-up)
- [Keyboard shortcuts for this workflow](#keyboard-shortcuts-for-this-workflow)
- [Anti-patterns](#anti-patterns)

---

## The short version

Clone the repo → **Focus mode** → **split into layers** → tour and complete **one layer at a time** → lean on **Explain behavior** and the **context pane** inside each layer → then let the **coverage strip** tell you what nobody read, before you approve.

---

## Phase 0 — Setup that pays for itself

*Once per repo, about two minutes. Skipping this costs you for the whole review.*

**1. Clone the repo locally and register it** (Repos, `⌘3`).

This is the single highest-leverage step on an unfamiliar codebase. With a local clone:

- **Ask AI runs inside the working directory**, so it reads the real files rather than only the diff.
- The **file tree** gains CODEOWNERS hints, git status, and a change-frequency heatmap — free signal about which parts of an unknown repo are volatile.
- The **context pane** can open files the PR never touched.
- **Per-stop verification** ("check this concern against the repository") becomes possible at all.

**2. Configure AI review** (Settings → AI review).

Pick your provider — the `claude`, `codex`, or `gemini` CLI on your `PATH`, or any OpenAI-compatible endpoint. Then fill in **custom review instructions**: they're prepended to every tour, layer plan, and chat prompt, so your team's standards apply without you restating them per PR.

**3. Open the PR.** `⌘K`, paste the URL (full link or `owner/repo#123`).

---

## Phase 1 — Orient before reading a line

*About two minutes. The goal is knowing the shape and the real size of the change.*

| Step | Why it's first |
| --- | --- |
| **Conversation** tab | The author's description and any prior review discussion. Cheapest context available. |
| **Checks** tab | Find out whether CI is even green before you invest an hour. The tab colour is required-aware, so an optional failure won't read as a red build. |
| **Focus mode** (toolbar toggle on Files) | Hides lockfiles, generated output, snapshots, pure renames, and format-only changes. |

Turn Focus mode on **before** planning anything. On a large PR this is where the file count drops honestly — a "121 file" PR is often 40 files of actual code — and you want the real number driving every decision that follows.

---

## Phase 2 — Cut the PR up before reading it

This is the step that separates Reviewly from a browser tab, and on a big PR you should never skip it. Reading 60 files in alphabetical order means meeting every abstraction before the thing it's built on.

Two ways to split, both from the layered-review bar:

- **Plan with AI** — semantic layers in dependency order: schema, then the types written against it, then the logic, the API surface, the UI, and the tests. Each layer carries a short briefing (what it changes, why it's read *here*, 1–3 concrete things to check) and a risk chip.
- **Split by structure** — instant, offline, no CLI needed. Use it when you just want the shape, or when the AI plan is taking longer than your patience.

**Plans are reconciled against the diff every time you open the PR.** A file pushed after you started resurfaces in the plan instead of quietly falling out of the review. If the plan goes stale — everything collapses into the trailing catch-all layer — the bar flags it. Regenerate rather than trusting it.

Once you're inside a layer, **the whole review loop narrows to that layer**: the file tree, `[` / `]`, and `n` all stay within it, and `n` hands you off to the next layer when the current one is done. Layer progress comes straight from your viewed-files marks, so the stepper always matches what you've actually read — not what the AI thinks it covered.

---

## Phase 3 — Tour one layer at a time

Press **Tour this layer**, not "tour everything". Three reasons:

1. **Budget goes where you are.** The step cap is per layer, so a layer-scoped tour spends its stops on the code you're about to read, instead of spreading thin across every file in the PR.
2. **It overlaps with your reading.** Tours generate in the background and merge at read time, so layer 2 is being written while you read layer 1. A partially-complete deep tour is always a *correct* tour of the layers that have landed.
3. **The verdict stays honest.** A deep tour's suggested verdict is folded only from layers that have landed, so the chip reads `Suggests approve · 3 of 9 layers` and says outright that it is not a verdict on the whole PR.

> **Don't let an early approve chip end your review.** It speaks for the fraction of the PR that has been toured — and the chip tells you which fraction.

---

## Phase 4 — Working a single stop

Three moves, in increasing order of cost. Most stops need only the first.

### 1. Read the evidence grade (free)

Every stop is checked against the diff deterministically — no model call — and graded on where its evidence actually lands:

| Grade | Meaning |
| --- | --- |
| **exact** | Anchored to a line this PR adds, and every identifier it names is present in the diff. |
| **strong** | Anchored inside a real hunk, on context lines. |
| **heuristic** | The anchor missed every hunk, names a file the PR doesn't touch, or quotes an identifier that appears nowhere in the diff. |

Nothing is ever removed — dropping a weakly-grounded concern would trade a visible false positive for an invisible false negative, and you can't audit what you were never shown. A shaky claim simply *reads* as shaky. On an unfamiliar repo, treat every `heuristic` stop as a prompt to go look yourself, not as a finding.

### 2. "Explain behavior" when the diff is dense (one AI call, on demand)

Available on a tour stop or on a hunk in the diff. You get a **before / after** list for the symbol — one bullet per step, each with the line ranges backing it. Unlike a prose summary, each bullet is falsifiable: you can check it line by line, and a wrong one is visibly wrong rather than plausibly vague.

The payoff on a big PR is the `refactor_only` classification. Most large PRs are mostly behavior-preserving, and being told so explicitly — with the before and after lists matching — is what lets you skim a 400-line file honestly instead of re-deriving that conclusion by hand.

It's deliberately on-demand and ephemeral: it describes the diff at the moment you asked, and a stored copy would outlive the code it describes.

### 3. Open the context pane for what isn't in the diff

The callee a changed line invokes, an untouched caller, the test that covers it. The pane has browser-like back/forward history, and — critically — opening something in it **does not** change your active file, your scroll position, or your viewed-files progress. Reading a dependency is not reviewing a change, and the tool refuses to count it as one.

On a repo you don't know, this is the feature that makes the PR tractable at all. `⌘P` quick-opens anything else in the clone.

**As you go:** mark files viewed. Progress is keyed to the PR's head commit, so a force-push resets it rather than leaving you with stale confidence.

---

## Phase 5 — The pass most reviewers skip: coverage

Verification checks that what the AI *said* is true. Nothing checks what it **didn't** say — and on a large PR, that's where a missed defect lives. A tour has a bounded number of stops, so a 121-file PR cannot get a stop on every file by construction.

The **coverage strip** at the top of the tour answers this deterministically. It buckets every changed file:

| Bucket | Meaning |
| --- | --- |
| **toured** | At least one stop lands on it. |
| **pending** | Belongs to a layer whose tour hasn't run yet — *not* a gap. |
| **skippable** | Lockfile, generated, snapshot, or format-only. |
| **tests** | Read differently, rarely worth a stop. |
| **unexamined** | Changed, unexplained, and nobody looked. |

The headline is **coverage of changed lines, not a count of stops** — 28 stops sounds like a lot until you learn they cover 20% of the churn.

Two things to do before you submit:

1. **Open the at-risk list.** Unexamined files touching authentication, crypto, SQL, concurrency, migrations, money, or destructive operations are called out regardless of how tidy the rest of the coverage looks. An unexamined lockfile is fine; an unexamined authorization change is not. Read those raw, yourself.
2. **Check that `pending` is zero** before treating the verdict as covering the PR. An in-flight tour shouldn't be accused of missing what it hasn't reached — but it also hasn't cleared it.

---

## Phase 6 — Write it up

- **Inline comments** batch into a single GitHub review, exactly like the web UI. They're saved to a per-PR draft that survives navigation, refresh, and app restarts, and an unsaved-draft guard warns you before you navigate away.
- **Tour stops can pre-fill** a suggested inline comment, and the tour's verdict seeds the submit dialog so it opens on the right choice.
- **`⌘↵` submits.** Reviewly confirms the review actually landed on GitHub before clearing your draft.

---

## Keyboard shortcuts for this workflow

| Key | Action |
| --- | --- |
| `⌘K` | Command palette — paste a PR URL to open it |
| `⌘B` | Toggle unified ↔ split diff (works inside layered review too) |
| `[` / `]` | Previous / next file — **scoped to the current layer** |
| `n` | Next unviewed file; hands off to the next layer when this one is done |
| `j` / `k` | Move between tour stops |
| `o` | Open the file at the current stop |
| `Enter` / `d` | Expand a stop's detail |
| `x` | Dismiss a stop |
| `⌘P` | Quick-open any file in the clone |
| `⌘↵` | Submit the review |
| `?` | Full shortcut cheatsheet |

---

## Anti-patterns

Things that feel faster and aren't:

- **Reading the file list top to bottom.** Alphabetical order means meeting every consumer before its foundation. Split into layers first.
- **Touring the whole PR at once.** The step budget spreads thin, and you wait on the entire generation before reading anything.
- **Trusting the verdict chip without reading the layer count.** `Suggests approve · 3 of 9 layers` is a verdict on a third of the change.
- **Treating a `heuristic` stop as a finding.** It's a pointer to go look, and sometimes it's pointing at nothing.
- **Approving without opening the coverage strip.** The stops you read are not the same thing as the PR you reviewed.
- **Reviewing without a local clone.** You lose the context pane's reach, CODEOWNERS, churn signal, and repo-grounded AI — the exact things an unfamiliar codebase demands.

---

<p align="center">
  <sub>Part of the <a href="README.md">Reviewly</a> documentation · <a href="LICENSE">GPL-3.0-or-later</a></sub>
</p>
