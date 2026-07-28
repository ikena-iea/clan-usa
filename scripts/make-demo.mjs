// Generates scores.demo.json so you can preview the page with realistic
// numbers instead of waiting out the 14 day grace period.
//
// Run: node scripts/make-demo.mjs
// View: open the site with ?demo=1 on the end of the URL.
//
// Profiles are run through the REAL scoring functions in lib/scoring.mjs,
// so the numbers here are guaranteed consistent with production behaviour.
// If you change a weight or a threshold, regenerate and the demo follows.

import fs from 'fs';
import { clanScore, warScore, tierFor, applyCap, CONFIG } from './lib/scoring.mjs';

const TODAY = new Date().toISOString().slice(0, 10);

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

function weekend(used, looted, avail = 5, median = 1400) {
  return { attacksUsed: used, attackLimit: avail, bonusAttackLimit: 0, looted, clanMedian: median };
}

// Builds a list of attack records. gap = defender TH minus attacker TH.
function attacks({ n, th, gap = 0, stars = 3, dest = 100, misses = 0 }) {
  const out = [];
  for (let i = 0; i < n - misses; i++) {
    out.push({
      attackerTH: th,
      defenderTH: th + gap,
      starsGained: stars,
      destGained: dest,
      missed: false,
    });
  }
  for (let i = 0; i < misses; i++) {
    out.push({ attackerTH: th, defenderTH: null, starsGained: 0, destGained: 0, missed: true });
  }
  return out;
}

// name, th, role, days in clan, donations/30d, raid weekends, capital given/looted, war profile
const PROFILES = [
  { name: 'Ikena',        th: 16, role: 'leader',   days: 210, don: 1450, wk: [weekend(5,7200), weekend(5,6800), weekend(5,7500), weekend(6,8100)], given: 92000, looted: 29600, war: { n: 10, th: 16, gap: 0, stars: 3, dest: 100 } },
  { name: 'DaHairyVeer2', th: 17, role: 'coLeader', days: 180, don: 980,  wk: [weekend(5,8400), weekend(5,7900), weekend(4,6200), weekend(5,8000)], given: 28000, looted: 30500, war: { n: 10, th: 17, gap: 1, stars: 3, dest: 100 } },
  { name: 'jadav m',      th: 16, role: 'coLeader', days: 156, don: 620,  wk: [weekend(5,6100), weekend(5,5800), weekend(5,6400), weekend(5,6000)], given: 21000, looted: 24300, war: { n: 10, th: 16, gap: 0, stars: 2, dest: 88 } },
  { name: 'thegodlynoob', th: 15, role: 'member',   days: 142, don: 540,  wk: [weekend(5,5200), weekend(4,4100), weekend(5,5400), weekend(5,5100)], given: 17800, looted: 19800, war: { n: 10, th: 15, gap: 0, stars: 2, dest: 76 } },
  { name: 'dark angel',   th: 16, role: 'member',   days: 128, don: 810,  wk: [weekend(5,6600), weekend(5,6200), weekend(5,6800), weekend(5,6500)], given: 24000, looted: 26100, war: { n: 10, th: 16, gap: 0, stars: 3, dest: 96 } },
  { name: 'LegitN00b98',  th: 14, role: 'member',   days: 119, don: 470,  wk: [weekend(4,3900), weekend(5,4600), weekend(5,4800), weekend(4,4000)], given: 15200, looted: 17300, war: { n: 10, th: 14, gap: 0, stars: 2, dest: 71 } },
  { name: 'Coleman7575',  th: 17, role: 'member',   days: 97,  don: 1120, wk: [weekend(5,8800), weekend(5,8200), weekend(5,8600), weekend(5,8400)], given: 12000, looted: 34000, war: { n: 10, th: 17, gap: -2, stars: 3, dest: 100 } },
  { name: 'FazeTibbles',  th: 15, role: 'member',   days: 88,  don: 690,  wk: [weekend(5,5600), weekend(5,5300), weekend(5,5900), weekend(5,5500)], given: 20800, looted: 22300, war: { n: 10, th: 15, gap: 0, stars: 3, dest: 100, misses: 2 } },
  { name: 'spy angel',    th: 13, role: 'member',   days: 76,  don: 380,  wk: [weekend(3,2400), weekend(4,3100), weekend(3,2200), weekend(4,3000)], given: 9800,  looted: 10700, war: { n: 8,  th: 13, gap: 0, stars: 2, dest: 68 } },
  { name: 'mustafa',      th: 12, role: 'member',   days: 71,  don: 290,  wk: [weekend(5,2900), weekend(5,3100), weekend(4,2400), weekend(5,3000)], given: 11000, looted: 11400, war: { n: 8,  th: 12, gap: 0, stars: 3, dest: 100 } },
  { name: 'Tres',         th: 16, role: 'member',   days: 64,  don: 720,  wk: [weekend(0,0),    weekend(0,0),    weekend(0,0),    weekend(0,0)],    given: 0,     looted: 0,     war: { n: 10, th: 16, gap: 0, stars: 3, dest: 94 } },
  { name: 'elf00',        th: 14, role: 'member',   days: 58,  don: 410,  wk: [weekend(5,4400), weekend(5,4700), weekend(2,1800), weekend(5,4500)], given: 13600, looted: 15400, war: { n: 10, th: 14, gap: 0, stars: 2, dest: 62, misses: 3 } },
  { name: 'Gray',         th: 13, role: 'member',   days: 44,  don: 150,  wk: [weekend(1,700),  weekend(0,0),    weekend(2,1300), weekend(0,0)],    given: 1200,  looted: 2000,  war: { n: 6,  th: 13, gap: 0, stars: 1, dest: 48 } },
  { name: 'Didetz',       th: 15, role: 'member',   days: 39,  don: 880,  wk: [weekend(5,5100), weekend(5,4900), weekend(5,5300), weekend(5,5000)], given: 19600, looted: 20300, war: { n: 10, th: 15, gap: 1, stars: 3, dest: 100 } },
  { name: 'RedDawn',      th: 12, role: 'member',   days: 31,  don: 340,  wk: [weekend(4,2200), weekend(5,2800), weekend(5,2700), weekend(3,1700)], given: 8100,  looted: 9400,  war: null },
  { name: 'Kaz',          th: 16, role: 'member',   days: 27,  don: 60,   wk: [weekend(0,0),    weekend(0,0),    weekend(1,900),  weekend(0,0)],    given: 400,   looted: 900,   war: { n: 10, th: 16, gap: 0, stars: 0, dest: 22, misses: 6 } },
  { name: 'Bennett',      th: 11, role: 'member',   days: 22,  don: 260,  wk: [weekend(5,1900), weekend(5,2000), weekend(4,1500)],                  given: 5000,  looted: 5400,  war: { n: 4,  th: 11, gap: 0, stars: 2, dest: 82 } },
  { name: 'Julio',        th: 13, role: 'member',   days: 18,  don: 190,  wk: [weekend(5,2600), weekend(4,2100)],                                   given: 4400,  looted: 4700,  war: { n: 4,  th: 13, gap: 0, stars: 3, dest: 100 } },
  { name: 'Mia',          th: 10, role: 'member',   days: 9,   don: 95,   wk: [weekend(5,1400)],                                                    given: 1300,  looted: 1400,  war: { n: 2,  th: 10, gap: 0, stars: 2, dest: 74 } },
  { name: 'Chris',        th: 12, role: 'member',   days: 3,   don: 40,   wk: [],                                                                   given: 0,     looted: 0,     war: null },
];

const WARS_TOTAL = 7;

const members = PROFILES.map((p, i) => {
  const inGrace = p.days < CONFIG.GRACE_DAYS;
  const daysPresent = Math.min(p.days, 30);

  const clan = clanScore({
    donationsLast30d: p.don,
    daysPresent,
    weekends: p.wk.length ? p.wk : null,
    goldContributed: p.given,
    goldLooted: p.looted,
  });

  const warAttacks = p.war ? attacks(p.war) : [];
  const war = warScore(warAttacks);

  // wars joined, roughly derived from how many rostered attacks they have
  const warsJoined = p.war ? Math.min(WARS_TOTAL, Math.ceil(p.war.n / 2)) : 0;

  return {
    tag: '#DEMO' + String(i + 1).padStart(3, '0'),
    name: p.name,
    role: p.role,
    th: p.th,
    firstSeen: daysAgo(p.days),
    daysPresent: p.days,
    inGrace,
    gracePeriodEndsIn: inGrace ? CONFIG.GRACE_DAYS - p.days : 0,
    warsJoined,
    warsTotal: WARS_TOTAL,
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
});

members.sort((a, b) => (b.clan.total ?? -1) - (a.clan.total ?? -1));

const out = {
  demo: true,
  generatedAt: new Date().toISOString(),
  snapshotDate: TODAY,
  snapshotsAvailable: 30,
  raidWeekendsAvailable: 4,
  warsArchived: WARS_TOTAL,
  config: CONFIG,
  members,
};

fs.writeFileSync('scores.demo.json', JSON.stringify(out, null, 2));

console.log(`Wrote scores.demo.json with ${members.length} members.\n`);
console.log('name           clan  tier        war   tier        attacks');
console.log('-'.repeat(64));
for (const m of members) {
  console.log(
    m.name.padEnd(14),
    String(m.clan.total ?? '—').padStart(5),
    (m.clan.tier ?? (m.inGrace ? 'New' : '—')).padEnd(11),
    String(m.war.total ?? '—').padStart(5),
    (m.war.tier ?? (m.inGrace ? 'New' : m.war.status ?? '—')).padEnd(11),
    m.war.available ? `${m.war.used}/${m.war.available}` : 'not warring'
  );
}
