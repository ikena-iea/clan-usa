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

  // Sanity check: if we have real snapshot history but the ledger is empty or
  // missing people, everyone would silently fall back to TODAY and restart
  // their grace period. Fail loudly instead of quietly producing wrong tiers.
  const missingFromLedger = latest.members.filter(m => !firstSeen[m.tag]);
  if (snapshots.length > 1 && missingFromLedger.length > 0) {
    console.warn(
      `WARNING: ${missingFromLedger.length} of ${latest.members.length} members are ` +
        `missing from history/first-seen.json despite ${snapshots.length} snapshots existing.\n` +
        `         They will be treated as brand new and put back into the grace period.\n` +
        `         Names: ${missingFromLedger.map(m => m.name).join(', ')}\n` +
        `         If this is not a batch of genuinely new members, the ledger was lost. ` +
        `Re-run collect.mjs, which will rebuild it from snapshot history.`
    );
  }

  const donated = donationDeltas(snapshots);

  // --- raids: last N completed weekends -------------------------------------
  // Both raid pillars (participation and loot efficiency) read from the same
  // archived raid seasons, so there is no window to reconcile against the
  // snapshot history the way the old capital-contributions ratio needed.
  //
  // IMPORTANT: the API only lists members who actually ATTACKED in a raid
  // weekend. Someone who was in the clan and raided zero times simply does
  // not appear. Left alone, that reads as "no data", both raid pillars drop
  // out, and the weights renormalize so a non-raider scores on donations
  // alone and can reach Legendary without ever touching the Capital.
  //
  // So for every weekend we cross-reference the daily snapshots: if a member
  // was in the clan when that weekend ended but is missing from its member
  // list, we synthesize a zero-attack record. Absent from raid data while
  // present in the clan is a real zero, not missing data.
  const raidFiles = listJson(path.join(H, 'raids')).slice(-CONFIG.RAID_WEEKEND_WINDOW);
  const raidSeasons = raidFiles.map(f => readJson(path.join(H, 'raids', f), null)).filter(Boolean);

  // tag -> Set of dates we saw them on the roster
  const rosterByDate = {};
  for (const snap of snapshots) {
    rosterByDate[snap.date] = new Set(snap.members.map(m => m.tag));
  }
  const snapshotDates = Object.keys(rosterByDate).sort();

  // Was this tag in the clan on (or nearest before) the given date?
  function inClanOn(tag, isoDate) {
    let best = null;
    for (const d of snapshotDates) {
      if (d <= isoDate) best = d;
      else break;
    }
    if (!best) return null; // no snapshot that early, cannot say
    return rosterByDate[best].has(tag);
  }

  function seasonEndDate(season) {
    const t = season.endTime || '';
    if (t.length < 8) return null;
    return t.slice(0, 4) + '-' + t.slice(4, 6) + '-' + t.slice(6, 8);
  }

  const raidsByTag = {};
  for (const season of raidSeasons) {
    const endDate = seasonEndDate(season);
    const listed = new Set();

    for (const m of season.members || []) {
      listed.add(m.tag);
      (raidsByTag[m.tag] ||= []).push({
        attacksUsed: m.attacksUsed,
        attackLimit: m.attackLimit,
        bonusAttackLimit: m.bonusAttackLimit,
        looted: m.looted,
        clanMedian: season.clanMedianLootPerAttack,
      });
    }

    // Anyone on the roster that weekend but absent from the raid list
    // participated zero times.
    if (endDate) {
      for (const m of latest.members) {
        if (listed.has(m.tag)) continue;
        if (inClanOn(m.tag, endDate) !== true) continue; // not in clan, or unknown
        (raidsByTag[m.tag] ||= []).push({
          attacksUsed: 0,
          attackLimit: 5,
          bonusAttackLimit: 0,
          looted: 0,
          clanMedian: season.clanMedianLootPerAttack,
        });
      }
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
