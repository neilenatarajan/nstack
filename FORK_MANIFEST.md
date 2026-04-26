# Fork Manifest — nstack

This file documents every intentional divergence between nstack (neilenatarajan/nstack)
and its upstream (garrytan/gstack). Any Claude Code agent can read this file and perform
a correct upstream merge without prior knowledge of nstack's history.

## Upstream

- Repository: garrytan/gstack
- Branch: main
- Remote name: upstream (`git remote add upstream git@github.com:garrytan/gstack.git`)
- Fork point: commit dbc09c7 (first nstack-specific commit after forking)

## Added

Files and directories that do not exist upstream. These merge cleanly every time.

| Path | Description |
|------|-------------|
| `research/` | Academic API search binary (Semantic Scholar, PubMed, arXiv, OpenAlex) |
| `research-synthesis/` | /research-synthesis skill template (literature review) |
| `research-peer-review/` | /research-peer-review skill template (adversarial review) |
| `write-draft/` | /write-draft skill template (writing pipeline) |
| `write-review/` | /write-review skill template (editing pipeline) |
| `scripts/resolvers/writing.ts` | VOICE_PROFILE_CHECK, FORMAT_DETECTION resolvers + SLOP_RULES (shared) |
| `FORK_MANIFEST.md` | This file |
| `bin/verify-fork-integrity` | Post-merge verification script |

## Removed

Upstream content intentionally deleted. Must not be re-introduced after merge.

| What | Where | Why |
|------|-------|-----|
| YC recruitment CTA | `scripts/resolvers/preamble.ts` (`generateVoiceDirective()` at tier >= 2) | "consider applying to YC" text removed |
| garryslist.org links | `scripts/resolvers/preamble.ts` (`generateLakeIntro()`) | URL and browser-open removed |
| Marketing-enforcement tests | `test/skill-validation.test.ts` | Tests that enforced YC promotional content |
| Career CTA from docs | Various SKILL.md files | Removed via regeneration after template changes |
| Auto-update check behavior | Preamble resolver | Disabled |
| Founder signal references | `scripts/resolvers/review.ts` | "founder signal" concept removed |
| Office-hours Phase 4.5 + Phase 6 | `office-hours/SKILL.md.tmpl` | Founder Signal Synthesis and Founder Discovery sections removed |

**Important:** Upstream brand identity references like "Garry Tan" and "YC partner energy"
in the voice section are intentionally RETAINED. Only recruitment/promotional content is banned.

## Modified

Files that exist upstream but are intentionally different in nstack.

| File | What changed |
|------|-------------|
| `scripts/resolvers/index.ts` | Exports writing resolvers (VOICE_PROFILE_CHECK, FORMAT_DETECTION, SLOP_RULES) |
| `scripts/resolvers/preamble.ts` | YC recruitment content stripped (brand identity kept) |
| `setup` | Adjusted for research binary build |
| `package.json` | Research binary build scripts added |
| `.gitignore` | Additional entries for fork-specific artifacts (.writing/) |

**Policy for new upstream files:** New files added by upstream in `scripts/resolvers/`
should be accepted unless they conflict with writing.ts exports. New skill directories
from upstream should always be accepted.

## Conflict Hotspots

Files that will likely conflict on every upstream merge.

| File | Resolution strategy |
|------|-------------------|
| `CHANGELOG.md` | Keep both entries. nstack entries go on top. |
| `VERSION` | Take upstream's version, then bump for nstack. |
| `scripts/resolvers/preamble.ts` | Accept upstream structural changes, then remove banned patterns (see step 5 in merge checklist). Check `generateVoiceDirective()` and `generateLakeIntro()` specifically. |
| `scripts/resolvers/index.ts` | Additive merge — keep both upstream's new exports and nstack's writing resolver exports. |
| `package.json` | Merge both. Keep nstack's research binary build scripts. |
| `setup` | Merge both. Keep nstack's research binary build step. |
| `CLAUDE.md` | Merge both. Keep nstack's fork-specific sections. |

## Banned Patterns

Content that must never appear in nstack source files after a merge. The verification
script (`bin/verify-fork-integrity`) is the single source of truth for the grep strings.
This section describes them in human-readable terms.

**Banned strings (grep -F):**
- `garryslist.org`
- `consider applying to YC`
- `founder signal`
- `open https://garryslist.org`

**NOT banned** (intentionally retained):
- "Garry Tan"
- "YC partner energy"
- "YC" in general (only recruitment CTAs are banned)

## Watch List

If upstream ever adds skills with these names, flag for human review rather than
silently accepting or rejecting:

- /research-synthesis
- /research-peer-review
- /write-draft
- /write-review

## Merge Checklist

Run this monthly (or whenever upstream has changes you want).

### Setup (one-time)
```bash
git remote get-url upstream 2>/dev/null || git remote add upstream git@github.com:garrytan/gstack.git
```

### Monthly merge
```bash
# 1. Fetch upstream
git fetch upstream

# 2. Create a sync branch (never merge directly to main)
git checkout -b sync/upstream-$(date +%Y-%m-%d)

# 3. Merge upstream
git merge upstream/main

# 4. Resolve conflicts per the Conflict Hotspots section above

# 5. For preamble.ts specifically:
#    - Accept all upstream structural changes
#    - Check generateVoiceDirective() and generateLakeIntro() for banned content
#    - Run: bin/verify-fork-integrity (grep patterns are the definitive list)
#    - Delete any lines the script flags

# 6. For generated SKILL.md files: just mark as resolved (step 8 overwrites them)

# 7. Install dependencies (upstream may have changed them)
bun install

# 8. Regenerate SKILL.md files
bun run gen:skill-docs

# 9. Verify fork integrity
bin/verify-fork-integrity

# 10. Run tests
bun test

# 11. If all pass, merge to main
git checkout main
git merge sync/upstream-$(date +%Y-%m-%d)
git push

# 12. If verification fails: fix on the sync branch, re-run steps 9-10, then merge
```

### First merge note

The first merge may be larger than subsequent ones (nstack was 17 commits behind
at the time this manifest was created). Run `git diff upstream/main --stat` before
starting to assess the conflict surface. After the first merge, expect ~15-20
commits with the documented 8-file overlap monthly.
