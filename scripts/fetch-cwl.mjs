// Fetches the current CWL group + all round wars for a clan and writes
// a flat attack-level data.json that the site's frontend can render.
//
// Required environment variables (set as GitHub Actions secrets):
//   COC_API_TOKEN  - your Clash of Clans API token (registered to the
//                    RoyaleAPI proxy IPs, not your own IP)
//   CLAN_TAG       - your clan tag, e.g. #2CGG82GUJ

// BASE is chosen automatically:
//   - Running inside GitHub Actions (GITHUB_ACTIONS=true, set automatically
//     by GitHub on every run) -> use the RoyaleAPI proxy, since Actions
//     runners get a different IP every run and can't be whitelisted directly.
//   - Running anywhere else (your own machine, local testing) -> call the
//     Clash of Clans API directly, since your token is whitelisted to your
//     own fixed IP there.
// You can still force one or the other by setting COC_API_BASE yourself.
const BASE =
  process.env.COC_API_BASE ||
  (process.env.GITHUB_ACTIONS === 'true'
    ? 'https://cocproxy.royaleapi.dev/v1'
    : 'https://api.clashofclans.com/v1');

console.log('Using API base:', BASE, '(GITHUB_ACTIONS =', process.env.GITHUB_ACTIONS || 'unset', ')');

const TOKEN = process.env.COC_API_TOKEN;
const CLAN_TAG = process.env.CLAN_TAG;

if (!TOKEN || !CLAN_TAG) {
  console.error('Missing COC_API_TOKEN or CLAN_TAG environment variable.');
  process.exit(1);
}

function encTag(tag) {
  return encodeURIComponent(tag.startsWith('#') ? tag : '#' + tag);
}

async function apiGet(path) {
  const res = await fetch(BASE + path, {
    headers: { Authorization: 'Bearer ' + TOKEN },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status} on ${path}: ${body}`);
  }
  return res.json();
}

// Same as apiGet, but returns { notFound: true } instead of throwing when
// the API responds 404 - used for the leaguegroup check, since a 404 there
// just means "this clan isn't in an active CWL right now," which is a
// normal, expected state (e.g. right after CWL ends, or between seasons),
// not a real error.
async function apiGetAllow404(path) {
  const res = await fetch(BASE + path, {
    headers: { Authorization: 'Bearer ' + TOKEN },
  });
  if (res.status === 404) {
    return { notFound: true };
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status} on ${path}: ${body}`);
  }
  return res.json();
}

async function main() {
  console.log('Fetching CWL group for', CLAN_TAG);
  const group = await apiGetAllow404(`/clans/${encTag(CLAN_TAG)}/currentwar/leaguegroup`);

  if (group.notFound) {
    console.log('No active CWL group right now (clan is between seasons, or CWL just ended). Leaving data.json untouched.');
    return; // exit cleanly, success, no changes to data.json
  }

  const attacks = [];
  const rounds = {};
  let roundNumber = 0;

  for (const round of group.rounds) {
    roundNumber++;
    for (const warTag of round.warTags) {
      if (warTag === '#0') continue; // placeholder, war not started yet

      let war;
      try {
        war = await apiGet(`/clanwarleagues/wars/${encTag(warTag)}`);
      } catch (e) {
        console.warn('Skipping unavailable war tag', warTag, e.message);
        continue;
      }

      // Figure out which side is "our" clan
      const isClan1 = war.clan.tag.toUpperCase() === CLAN_TAG.toUpperCase().replace(/^#?/, '#');
      const ourClan = isClan1 ? war.clan : war.opponent;
      const otherClan = isClan1 ? war.opponent : war.clan;

      if (ourClan.tag.toUpperCase() !== CLAN_TAG.toUpperCase().replace(/^#?/, '#')) {
        // our clan tag didn't match either side, skip defensively
        continue;
      }

      // Per-round metadata, used by the page to compute possible stars and
      // label each round tab with the opponent.
      rounds[roundNumber] = {
        round: roundNumber,
        state: war.state,
        teamSize: war.teamSize ?? ourClan.members.length,
        opponent: otherClan.name,
        opponentTag: otherClan.tag,
        ourStars: ourClan.stars ?? 0,
        theirStars: otherClan.stars ?? 0,
        ourDestruction: ourClan.destructionPercentage ?? 0,
        theirDestruction: otherClan.destructionPercentage ?? 0,
        endTime: war.endTime || null,
      };

      for (const member of ourClan.members) {
        const ath = member.townhallLevel;
        if (member.attacks && member.attacks.length > 0) {
          const atk = member.attacks[0]; // CWL = 1 attack per member per war
          const defender = otherClan.members.find(m => m.tag === atk.defenderTag);
          attacks.push({
            round: roundNumber,
            name: member.name,
            tag: member.tag,
            ath,
            dth: defender ? defender.townhallLevel : null,
            amap: member.mapPosition ?? null,
            dmap: defender ? defender.mapPosition ?? null : null,
            stars: atk.stars,
            dest: Math.round(atk.destructionPercentage * 100) / 100,
            missed: false,
            pending: false,
          });
        } else if (war.state === 'warEnded') {
          // War is fully over and they never attacked = a real miss.
          attacks.push({
            round: roundNumber,
            name: member.name,
            tag: member.tag,
            ath,
            dth: null,
            amap: member.mapPosition ?? null,
            dmap: null,
            stars: 0,
            dest: 0,
            missed: true,
            pending: false,
          });
        } else if (war.state === 'inWar') {
          // War is live but the attack window hasn't closed yet - they
          // still have a chance to attack, so this is NOT a miss.
          attacks.push({
            round: roundNumber,
            name: member.name,
            tag: member.tag,
            ath,
            dth: null,
            amap: member.mapPosition ?? null,
            dmap: null,
            stars: 0,
            dest: 0,
            missed: false,
            pending: true,
          });
        }
        // war.state === 'preparation': war hasn't started yet, skip entirely
      }
    }
  }

  const output = {
    clanTag: CLAN_TAG,
    season: group.season,
    fetchedAt: new Date().toISOString(),
    totalRounds: group.rounds.length,
    rounds: Object.values(rounds).sort((a, b) => a.round - b.round),
    attacks,
  };

  const fs = await import('fs');
  fs.writeFileSync('data.json', JSON.stringify(output, null, 2));
  console.log(`Wrote ${attacks.length} attack records to data.json`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
