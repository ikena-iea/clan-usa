// Hourly collector. Writes raw history that scoring reads later.
//
//   history/members/YYYY-MM-DD.json   daily roster snapshot (overwritten hourly)
//   history/wars/{warId}.json         archived completed wars (write-once)
//   history/raids/{endTime}.json      archived raid weekends (write-once)
//   history/first-seen.json           tag -> first date we ever saw them
//
// Everything is write-once except the current day's member snapshot, which is
// refreshed each hour so the final version of the day is the most complete.

import fs from 'fs';
import path from 'path';
import {
  apiGet,
  apiGetSoft,
  encTag,
  normTag,
  requireEnv,
  today,
  CLAN_TAG,
  BASE,
} from './lib/api.mjs';

requireEnv();

const H = 'history';
const DIRS = {
  members: path.join(H, 'members'),
  wars: path.join(H, 'wars'),
  raids: path.join(H, 'raids'),
};

for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

const OUR_TAG = normTag(CLAN_TAG);
const TODAY = today();

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// --- 1. Member snapshot -----------------------------------------------------

async function collectMembers() {
  const clan = await apiGet(`/clans/${encTag(CLAN_TAG)}`);

  const members = clan.memberList.map(m => ({
    tag: m.tag,
    name: m.name,
    role: m.role,
    th: m.townHallLevel ?? null,
    expLevel: m.expLevel,
    trophies: m.trophies,
    donations: m.donations,
    donationsReceived: m.donationsReceived,
    capitalContributions: m.clanCapitalContributions ?? 0,
  }));

  writeJson(path.join(DIRS.members, `${TODAY}.json`), {
    date: TODAY,
    capturedAt: new Date().toISOString(),
    clanLevel: clan.clanLevel,
    memberCount: clan.members,
    members,
  });

  // first-seen ledger, keyed on tag, never reset on rejoin
  const fsPath = path.join(H, 'first-seen.json');
  const seen = readJson(fsPath, {});
  let added = 0;
  for (const m of members) {
    if (!seen[m.tag]) {
      seen[m.tag] = { firstSeen: TODAY, name: m.name };
      added++;
    } else {
      seen[m.tag].name = m.name;
    }
  }
  writeJson(fsPath, seen);

  console.log(`Members: ${members.length} snapshotted, ${added} new to ledger`);
  return members;
}

// --- 2. Wars ----------------------------------------------------------------

// Regular wars have no id field, so build a stable one from the two clan tags
// plus the preparation start time.
function warId(war) {
  const a = normTag(war.clan.tag).replace('#', '');
  const b = normTag(war.opponent.tag).replace('#', '');
  const t = (war.preparationStartTime || war.startTime || '').replace(/\D/g, '');
  return `${t}_${a}_vs_${b}`;
}

// Computes INCREMENTAL stars/destruction per attack by replaying all attacks
// in `order` and tracking each defending base's running best.
function buildAttackRecords(war, ourSide, theirSide, source) {
  const all = [];
  for (const m of ourSide.members) {
    for (const a of m.attacks || []) {
      all.push({ ...a, attackerTH: m.townhallLevel, attackerName: m.name, attackerTag: m.tag });
    }
  }
  // Opponent attacks matter too: they change nothing for our scoring, but the
  // running-best must only consider OUR attacks on THEIR bases.
  all.sort((x, y) => (x.order || 0) - (y.order || 0));

  const best = {}; // defenderTag -> { stars, dest }
  const thByTag = {};
  for (const m of theirSide.members) thByTag[m.tag] = m.townhallLevel;

  const records = [];
  for (const a of all) {
    const prev = best[a.defenderTag] || { stars: 0, dest: 0 };
    const starsGained = Math.max(0, (a.stars || 0) - prev.stars);
    const destGained = Math.max(0, (a.destructionPercentage || 0) - prev.dest);

    best[a.defenderTag] = {
      stars: Math.max(prev.stars, a.stars || 0),
      dest: Math.max(prev.dest, a.destructionPercentage || 0),
    };

    records.push({
      attackerTag: a.attackerTag,
      attackerName: a.attackerName,
      attackerTH: a.attackerTH,
      defenderTH: thByTag[a.defenderTag] ?? null,
      stars: a.stars,
      dest: a.destructionPercentage,
      starsGained,
      destGained: Math.round(destGained * 100) / 100,
      order: a.order,
      missed: false,
      source,
    });
  }

  // Rostered members with unused attacks = misses (war has ended by now)
  const perMember = war.attacksPerMember || (source === 'cwl' ? 1 : 2);
  for (const m of ourSide.members) {
    const used = (m.attacks || []).length;
    for (let i = used; i < perMember; i++) {
      records.push({
        attackerTag: m.tag,
        attackerName: m.name,
        attackerTH: m.townhallLevel,
        defenderTH: null,
        stars: 0,
        dest: 0,
        starsGained: 0,
        destGained: 0,
        order: null,
        missed: true,
        source,
      });
    }
  }

  return records;
}

function archiveWar(war, source) {
  const isUs = normTag(war.clan.tag) === OUR_TAG;
  const ourSide = isUs ? war.clan : war.opponent;
  const theirSide = isUs ? war.opponent : war.clan;
  if (normTag(ourSide.tag) !== OUR_TAG) return null;

  const id = warId(war);
  const file = path.join(DIRS.wars, `${id}.json`);
  if (fs.existsSync(file)) return null; // write-once

  const record = {
    id,
    source,
    state: war.state,
    endTime: war.endTime,
    teamSize: war.teamSize,
    attacksPerMember: war.attacksPerMember || (source === 'cwl' ? 1 : 2),
    opponent: { tag: theirSide.tag, name: theirSide.name },
    result: {
      ourStars: ourSide.stars,
      theirStars: theirSide.stars,
      ourDestruction: ourSide.destructionPercentage,
      theirDestruction: theirSide.destructionPercentage,
    },
    roster: ourSide.members.map(m => ({
      tag: m.tag,
      name: m.name,
      th: m.townhallLevel,
      mapPosition: m.mapPosition,
    })),
    attacks: buildAttackRecords(war, ourSide, theirSide, source),
    archivedAt: new Date().toISOString(),
  };

  writeJson(file, record);
  return id;
}

async function collectRegularWar() {
  const war = await apiGetSoft(`/clans/${encTag(CLAN_TAG)}/currentwar`);
  if (war.notFound) {
    console.log(
      war.reason === 'private'
        ? 'Regular war: war log is PRIVATE in-game. Set it to public or war tracking will not work.'
        : 'Regular war: none active.'
    );
    return;
  }
  if (war.state === 'notInWar') {
    console.log('Regular war: not in war.');
    return;
  }
  if (war.state !== 'warEnded') {
    console.log(`Regular war: in progress (${war.state}), not archiving yet.`);
    return;
  }
  const id = archiveWar(war, 'regular');
  console.log(id ? `Regular war archived: ${id}` : 'Regular war already archived.');
}

async function collectCwlWars() {
  const group = await apiGetSoft(`/clans/${encTag(CLAN_TAG)}/currentwar/leaguegroup`);
  if (group.notFound) {
    console.log('CWL: no active league group.');
    return;
  }

  let archived = 0;
  for (const round of group.rounds) {
    for (const tag of round.warTags) {
      if (tag === '#0') continue;
      let war;
      try {
        war = await apiGet(`/clanwarleagues/wars/${encTag(tag)}`);
      } catch (e) {
        console.warn('  skip war tag', tag, e.message);
        continue;
      }
      if (war.state !== 'warEnded') continue;
      const involvesUs =
        normTag(war.clan.tag) === OUR_TAG || normTag(war.opponent.tag) === OUR_TAG;
      if (!involvesUs) continue;
      if (archiveWar(war, 'cwl')) archived++;
    }
  }
  console.log(`CWL: ${archived} newly archived war(s).`);
}

// --- 3. Raid weekends -------------------------------------------------------

async function collectRaids() {
  const res = await apiGetSoft(`/clans/${encTag(CLAN_TAG)}/capitalraidseasons?limit=10`);
  if (res.notFound) {
    console.log('Raids: not available.');
    return;
  }

  let archived = 0;
  for (const season of res.items || []) {
    if (season.state !== 'ended') continue;
    const id = (season.endTime || '').replace(/\D/g, '');
    if (!id) continue;
    const file = path.join(DIRS.raids, `${id}.json`);
    if (fs.existsSync(file)) continue;

    const members = (season.members || []).map(m => ({
      tag: m.tag,
      name: m.name,
      attacksUsed: m.attacks,
      attackLimit: m.attackLimit,
      bonusAttackLimit: m.bonusAttackLimit,
      looted: m.capitalResourcesLooted,
    }));

    // Median loot-per-attack across participants, used for the efficiency
    // sub-score. Relative to the clan that weekend, not an absolute target.
    const rates = members
      .filter(m => m.attacksUsed > 0)
      .map(m => m.looted / m.attacksUsed)
      .sort((a, b) => a - b);
    const median =
      rates.length > 0 ? rates[Math.floor(rates.length / 2)] : 0;

    writeJson(file, {
      id,
      startTime: season.startTime,
      endTime: season.endTime,
      offensiveReward: season.offensiveReward,
      defensiveReward: season.defensiveReward,
      clanMedianLootPerAttack: Math.round(median),
      members,
      archivedAt: new Date().toISOString(),
    });
    archived++;
  }
  console.log(`Raids: ${archived} newly archived weekend(s).`);
}

// --- main -------------------------------------------------------------------

async function main() {
  console.log(`Collector starting. BASE=${BASE} CLAN=${OUR_TAG}`);
  await collectMembers();
  await collectRegularWar();
  await collectCwlWars();
  await collectRaids();
  console.log('Collector done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
