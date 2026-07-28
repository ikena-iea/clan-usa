// Reads history/ and writes scores.json for the site to render.
// Pure filesystem + scoring, no API calls.

import fs from 'fs';
import path from 'path';
import {
  clanScore,
  warScore,
  tierFor,
  applyCap,
  isInGracePeriod,
  daysBetween,
  CONFIG,
} from './lib/scoring.mjs';

const H = 'history';
const TODAY = new Date().toISOString().slice(0, 10);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function listJson(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}

// --- donations: sum positive deltas across snapshots, ignore season resets ---

function donationDeltas(snapshots) {
  const totals = {}; // tag -> troops donated over the window
  for (let i = 1; i < snapshots.length; i++) {
    const prev = {};
    for (const m of snapshots[i - 1].members) prev[m.tag] = m;
    for (const m of snapshots[i].members) {
      const p = prev[m.tag];
      if (!p) continue;
      const d = m.donations - p.donations;
      if (d > 0) totals[m.tag] = (totals[m.tag] || 0) + d;
      // d < 0 means the season reset. Ignored, not treated as a drop.
    }
  }
  return totals;
}

function capitalDeltas(snapshots) {
  const totals = {};
  for (let i = 1; i < snapshots.length; i++) {
    const prev = {};
    for (const m of snapshots[i - 1].members) prev[m.tag] = m;
    for (const m of snapshots[i].members) {
      const p = prev[m.tag];
      if (!p) continue;
      const d = (m.capitalContributions || 0) - (p.capitalContributions || 0);
      if (d > 0) totals[m.tag] = (totals[m.tag] || 0) + d;
    }
  }
  return totals;
}

function main() {
  // --- load snapshots, trailing 31 days -------------------------------------
  const memberFiles = listJson(path.join(H, 'members'));
  const recentFiles = memberFiles.slice(-31);
  const snapshots = recentFiles
    .map(f => readJson(path.join(H, 'members', f), null))
    .filter(Boolean);

  if (snapshots.length === 0) {
    console.log('No member snapshots yet. Run collect.mjs first.');
    fs.writeFileSync(
      'scores.json',
      JSON.stringify({ generatedAt: new Date().toISOString(), members: [] }, null, 2)
    );
    return;
  }

  const latest = snapshots[snapshots.length - 1];
  const firstSeen = readJson(path.join(H, 'first-seen.json'), {});
  const donated = donationDeltas(snapshots);
  const capitalGiven = capitalDeltas(snapshots);

  // --- raids: last N completed weekends -------------------------------------
  const raidFiles = listJson(path.join(H, 'raids')).slice(-CONFIG.RAID_WEEKEND_WINDOW);
  const raidSeasons = raidFiles.map(f => readJson(path.join(H, 'raids', f), null)).filter(Boolean);

  const raidsByTag = {};
  const lootedByTag = {};
  for (const season of raidSeasons) {
    for (const m of season.members || []) {
      (raidsByTag[m.tag] ||= []).push({
        attacksUsed: m.attacksUsed,
        attackLimit: m.attackLimit,
        bonusAttackLimit: m.bonusAttackLimit,
        looted: m.looted,
        clanMedian: season.clanMedianLootPerAttack,
      });
      lootedByTag[m.tag] = (lootedByTag[m.tag] || 0) + (m.looted || 0);
    }
  }

  // --- wars: chronological attack records per member ------------------------
  const warFiles = listJson(path.join(H, 'wars'));
  const wars = warFiles
    .map(f => readJson(path.join(H, 'wars', f), null))
    .filter(Boolean)
    .sort((a, b) => (a.endTime || '').localeCompare(b.endTime || ''));

  const attacksByTag = {};
  const warsJoined = {};
  let totalWars = 0;
  for (const w of wars) {
    totalWars++;
    for (const r of w.roster || []) warsJoined[r.tag] = (warsJoined[r.tag] || 0) + 1;
    for (const a of w.attacks || []) {
      (attacksByTag[a.attackerTag] ||= []).push(a);
    }
  }

  // --- score each current member --------------------------------------------
  const results = [];
  for (const m of latest.members) {
    const seen = firstSeen[m.tag]?.firstSeen || TODAY;
    const daysPresent = Math.max(1, daysBetween(seen, TODAY));
    const inGrace = isInGracePeriod(seen, TODAY);

    const clan = clanScore({
      donationsLast30d: donated[m.tag] || 0,
      daysPresent,
      weekends: raidsByTag[m.tag] || null,
      goldContributed: capitalGiven[m.tag] || 0,
      goldLooted: lootedByTag[m.tag] || 0,
    });

    const war = warScore(attacksByTag[m.tag] || []);

    const entry = {
      tag: m.tag,
      name: m.name,
      role: m.role,
      th: m.th,
      firstSeen: seen,
      daysPresent,
      inGrace,
      gracePeriodEndsIn: inGrace ? CONFIG.GRACE_DAYS - daysPresent : 0,
      warsJoined: warsJoined[m.tag] || 0,
      warsTotal: totalWars,
      clan: {
        ...clan,
        total: inGrace ? null : clan.total,
        tier: inGrace ? null : tierFor(clan.total)?.name || null,
      },
      war: {
        ...war,
        total: inGrace ? null : war.total,
        tier: inGrace || war.total === null ? null : applyCap(war.total, war.cap)?.name || null,
      },
    };
    results.push(entry);
  }

  results.sort((a, b) => (b.clan.total ?? -1) - (a.clan.total ?? -1));

  const out = {
    generatedAt: new Date().toISOString(),
    snapshotDate: latest.date,
    snapshotsAvailable: snapshots.length,
    raidWeekendsAvailable: raidSeasons.length,
    warsArchived: totalWars,
    config: CONFIG,
    members: results,
  };

  fs.writeFileSync('scores.json', JSON.stringify(out, null, 2));
  console.log(
    `Wrote scores.json: ${results.length} members, ${snapshots.length} snapshots, ` +
      `${raidSeasons.length} raid weekends, ${totalWars} wars.`
  );
}

main();
