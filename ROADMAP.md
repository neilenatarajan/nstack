# nstack Roadmap

## Vision

nstack turns Claude Code into a whole organization, not just an engineering team.

The thesis is "thin harness, fat skills" taken to its natural conclusion. One agent, many domains. The same Claude session that ships your code also writes your LinkedIn posts, reviews your contracts, models your runway, and drafts your hiring loops. Cross-domain context is something siloed SaaS products fundamentally cannot match.

## Expansion Strategy

Sequential pathfinder. Build one domain, extract shared infrastructure, build the next. Start with domains the builder can evaluate (writing, research, strategy) before domains that need external validation (legal, finance).

Each new domain must answer two questions:
1. **Demand evidence** — who actually needs this and how often?
2. **Quality bar** — can someone qualified evaluate the output?

## Domain Roadmap

| Phase | Domain | Status | Skills |
|-------|--------|--------|--------|
| 0 | Engineering | Shipped | ~25 skills (`/ship`, `/review`, `/qa`, `/investigate`, `/cso`, etc.) |
| 0 | Design | Shipped | 5 skills (`/design-consultation`, `/design-shotgun`, `/design-html`, `/design-review`, `/plan-design-review`) |
| 1 | Content & Writing | In progress | `/write-draft`, `/write-review` (shipped); `/content-ideation` + LinkedIn format (this PR) |
| 2 | Research | Exploring | `/research-synthesis`, `/research-peer-review` (shipped); hypothesis design + office-hours research mode (planned) |
| 3 | Legal | Exploring | Triage skills (intake, issue-spotter, red-team, counsel-packet) — needs domain expert validation |
| 4 | Finance | Exploring | Runway modeling, fundraising prep, cap table review |
| 5 | Strategy | Exploring | Strategy memos, competitive analysis, board updates |
| 6 | Hiring | Exploring | Job posts, offer letters, comp benchmarking, interview prep |

**Status legend:**
- **Shipped** — works end-to-end, used in real workflows
- **In progress** — actively being built (this PR or imminent)
- **Exploring** — direction is set but not committed; design and demand validation pending

Domains marked "Exploring" may be reordered, redesigned, or dropped based on demand signals from earlier phases.

## Pathfinder: Content Writing (Phase 1)

The content/writing pipeline tests whether nstack's skill model generalizes beyond engineering. It is the first domain chosen specifically because:

- **Real demand:** the maintainer + peer founders spend hours per week on LinkedIn content
- **Evaluable output:** writing quality is judgeable without a domain expert
- **Different workflow:** social content has different output shape than code or documents
- **Adjacent infrastructure:** `/write-draft` and `/write-review` already exist as primitives

**The pipeline:** `/content-ideation` → `/write-draft` (`linkedin post` format) → `/write-review`

**Kill criteria (30-day check):** if the pipeline isn't used 3+ times on real LinkedIn posts, the pathfinder failed. Evaluate which step is broken (ideation, drafting, or the pipeline concept itself) before proceeding to Phase 2.

## Future Architecture (long-term, not committed)

- **Universal Workflow Loop** — `/office-hours` → plan → execute → review → ship, automated and domain-aware. Every domain gets the same lifecycle.
- **Company Control Plane** — persistent company state + scheduled operating loops. nstack runs weekly checkpoints across every domain you've enabled.

These are tracked here for direction but are NOT roadmap items. They depend on multiple domains being mature enough to operate as a system.

## Principles

- **Thin harness, fat skills** — the harness handles routing and tools; skills carry domain knowledge
- **No MCP** — context bloat is unacceptable
- **Multi-model review for confidence** — the Claude + Codex panel pattern generalizes to any domain where output quality matters
- **Privacy gates for confidential documents** — explicit consent before sending sensitive content to a second model
- **Quality over coverage** — better to ship two excellent skills than ten mediocre ones
- **Demand before domain** — pick the next domain based on signal, not vision

## How to Influence the Roadmap

- File a GitHub issue describing a workflow you want
- Open a PR with a design doc using `/office-hours`
- Ship a skill in your fork and propose merging it back
