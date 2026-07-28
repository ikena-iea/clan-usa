# Clan USA

A self-updating static site that tracks Clash of Clans clan contribution and
war performance, scored with published formulas so members can see exactly how
their numbers are calculated.

Two pages:

- **Members** (`index.html`) — clan score and war score per member, tiered
  Common through Legendary
- **CWL** (`cwl.html`) — current CWL leaderboard, round-by-round attack detail

## How it works

```
GitHub Actions (hourly)  -->  RoyaleAPI proxy  -->  Clash of Clans API
        |
        | fetch-cwl.mjs   current CWL       -> data.json
        | collect.mjs     roster/wars/raids -> history/
        | score.mjs       history/          -> scores.json
        v
    committed to this repo
        |
        v  served by GitHub Pages
    index.html / cwl.html  -->  rendered in the browser
```

Nothing runs in the visitor's browser except rendering. The API token lives
only in GitHub Secrets and never reaches the client.

## Setup

### 1. In-game

Set the clan **war log to Public**. If it's private, `/currentwar` returns 403
and regular wars will never be archived, which silently starves the war score.
CWL works either way, so this is easy to miss. The collector prints a warning
if it hits this.

### 2. API token

1. Register at https://developer.clashofclans.com
2. Create a key with **Allowed IP** set to `45.79.218.79`
   (the RoyaleAPI proxy — GitHub Actions runners get a different IP every run,
   so a key whitelisted to your own IP will fail on every scheduled run)
3. Copy the token

Check https://docs.royaleapi.com/proxy.html if that IP ever stops working.

### 3. Repo secrets

Settings → Secrets and variables → Actions → New repository secret:

| Name | Value |
|---|---|
| `COC_API_TOKEN` | the proxy-whitelisted token from step 2 |
| `CLAN_TAG` | your clan tag, e.g. `#2CGG82GUJ` |

### 4. GitHub Pages

Settings → Pages → Source: **Deploy from a branch** → `main` / root.

### 5. First run

Actions tab → **Update CWL data** → **Run workflow**. Read the log: the
collector prints exactly what it found and why anything was skipped.

## File layout

```
index.html              member scores (landing page)
cwl.html                CWL leaderboard
data.json               current CWL, written by fetch-cwl.mjs
scores.json             computed scores, written by score.mjs
scores.demo.json        fake data for previewing, see Demo mode below

history/                accumulates over time, never backfillable
  members/YYYY-MM-DD.json   daily roster snapshot
  wars/{warId}.json         archived completed wars
  raids/{endTime}.json      archived raid weekends
  first-seen.json           tag -> first date observed

scripts/
  fetch-cwl.mjs         current CWL -> data.json
  collect.mjs           roster, wars, raids -> history/
  score.mjs             history/ -> scores.json
  make-demo.mjs         generates scores.demo.json
  test-scoring.mjs      unit tests, no network needed
  lib/
    api.mjs             shared API helper, auto-detects proxy vs direct
    scoring.mjs         all scoring formulas, pure functions
```

`scripts/lib/` matters. If those two files land in `scripts/` instead, every
import breaks.

## Scoring

Two independent scores. Clan score is the basis for staying in the clan. War
score affects whether you get picked for the next war. Not warring does not
hurt your clan score, and a strong war record does not cover for contributing
nothing.

Tiers are **absolute thresholds, not a ranking**. Everyone can be Legendary at
the same time.

| Tier | Score |
|---|---|
| Legendary | 85+ |
| Epic | 70 to 84 |
| Rare | 55 to 69 |
| Uncommon | 40 to 54 |
| Common | below 40 |

### Clan score

```
clan = 0.40 x donations + 0.35 x raids + 0.25 x capital contributions
```

- **Donations** counts troops given only. Receiving is never penalized.
  Target is 400 per 30 days for a score of 100.
- **Raids** is attacks used out of attacks available across the last 4
  weekends, at 70%, plus loot efficiency relative to the clan median that
  weekend, at 30%. A weekend you were present for but skipped counts as a
  real zero.
- **Capital contributions** is gold given compared to gold you looted, so it
  measures whether you spend what you earn rather than how much you raid.

Pillars with no data drop out and the remaining weights renormalize.

### War score

```
war = 0.60 x reliability + 0.40 x performance
```

- **Reliability** is attacks used out of attacks you were rostered for, over
  the last 10 rostered attacks. Below 8 attacks the score blends toward a
  neutral 50, so a small sample cannot produce a perfect score.
- **Performance** scores each attack as
  `(stars gained + destruction gained / 100) x TH multiplier`, where the
  multiplier is `1 + 0.3 x (defender TH - attacker TH)` clamped to 0.4–1.8.
  A perfect 3-star at 100% against an equal Town Hall is 4.0 points, the
  benchmark for a score of 100.

Stars and destruction are **incremental**: a cleanup attack that adds the
third star gets full credit, and an attack on an already 3-starred base
scores zero rather than a fake 3-star.

### Caps

Applied after the weighted average, taking the lowest cap that triggers:

| Condition | War tier capped at |
|---|---|
| 2 misses in last 10 rostered attacks | Rare |
| 3 or more misses in last 10 | Uncommon |
| Performance below 50 (consistent farming) | Rare |
| Fewer than 4 rostered attacks | no tier, shows "New" |

### Grace period

New members are not scored for their first 14 days. Pillars still display so
data can be seen accumulating, but no tier is assigned. The clock starts at
first snapshot, not join date, so everyone shows "New" for the first two weeks
after deploying this. That is expected, not a bug.

## Demo mode

Real scores take two weeks to appear. To preview the layout with realistic
numbers:

```
node scripts/make-demo.mjs
```

Then open the site with `?demo=1` on the end of the URL. A purple banner marks
it as fake data. The demo profiles are run through the real scoring functions,
so changing a weight and regenerating keeps the demo honest.

## Local development

See `TESTING.md` for the full walkthrough. The short version:

```
node scripts/test-scoring.mjs      # ~40 assertions, no token needed
```

```powershell
$env:COC_API_TOKEN="your_local_token"   # whitelisted to YOUR ip
$env:CLAN_TAG="#2CGG82GUJ"
node scripts/collect.mjs
node scripts/score.mjs
```

```
npx serve -p 8000                  # then open http://localhost:8000
```

Your local token and the Actions token are different keys with different IP
whitelists. `lib/api.mjs` detects which environment it's in and picks the
right base URL automatically, so no file editing between the two.

## Tuning

All knobs live in `CONFIG` at the top of `scripts/lib/scoring.mjs`:

| Setting | Default | Effect |
|---|---|---|
| `DONATION_TARGET_30D` | 400 | Troops for a donation score of 100 |
| `RAID_WEEKEND_WINDOW` | 4 | Weekends in the raids window |
| `WAR_ATTACK_WINDOW` | 10 | Rostered attacks in the war window |
| `CONFIDENCE_ATTACKS` | 8 | Attacks before full credit or penalty |
| `PERFECT_ATTACK_POINTS` | 4.0 | Anchor for a performance score of 100 |
| `GRACE_DAYS` | 14 | Days before a member is scored |
| `MIN_WAR_ATTACKS` | 4 | Rostered attacks before a war tier |

Change a value, run `node scripts/test-scoring.mjs`, and the assertions show
exactly what moved. Both pages and the demo generator read the same config, so
they stay in sync.

Expect to retune once real data lands. `DONATION_TARGET_30D` and
`PERFECT_ATTACK_POINTS` are the two most likely to need adjusting, since both
were set from guesses about typical clan behaviour rather than measurements.

## Known limitations

- **Nothing is backfillable.** Wars that ended before the collector ran are
  gone, since `/currentwar` only shows the war happening right now. Raid
  seasons are the exception, as the API returns several recent ones.
- **Defense levels are invisible.** The API exposes troops, spells, heroes,
  and hero equipment, but not defensive buildings. A rushed Town Hall 17 with
  weak defenses is indistinguishable from a maxed one, so the TH multiplier
  cannot account for it. No third-party tool can do this either.
- **No last-online field.** Supercell does not expose it, which is why
  activity is not a scoring pillar here. Check it in-game instead.
- **Clan games are not tracked.** There is no clan-level endpoint, and the
  only source is a per-player achievement diff, which would require ~35 extra
  API calls per day.
- **GitHub Actions scheduling is best-effort.** Runs can be delayed during
  high load, and scheduled workflows are paused automatically on repos with no
  activity for 60 days.
