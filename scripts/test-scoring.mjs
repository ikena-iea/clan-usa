// Verifies the scoring math against synthetic profiles.
// Run: node scripts/test-scoring.mjs
// No API token or history needed.

import {
  clanScore,
  warScore,
  attackPoints,
  tierFor,
  applyCap,
  CONFIG,
} from './lib/scoring.mjs';

let failures = 0;

function check(label, actual, expected, tolerance = 0.5) {
  const ok =
    expected === null
      ? actual === null
      : Math.abs(actual - expected) <= tolerance;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${actual}, expected ${expected}`);
  if (!ok) failures++;
}

function weekend(used, avail = 5, looted = 5000, median = 1000) {
  return {
    attacksUsed: used,
    attackLimit: avail,
    bonusAttackLimit: 0,
    looted,
    clanMedian: median,
  };
}

function atk({ ath = 16, dth = 16, stars = 3, dest = 100, missed = false }) {
  return {
    attackerTH: ath,
    defenderTH: dth,
    starsGained: stars,
    destGained: dest,
    missed,
  };
}

console.log('\n=== Attack point multipliers ===');
check('3-star 100% equal TH', attackPoints(atk({})), 4.0);
check('3-star 100% one TH up', attackPoints(atk({ dth: 17 })), 5.2);
check('3-star 100% one TH down', attackPoints(atk({ dth: 15 })), 2.8);
check('3-star 100% two TH down', attackPoints(atk({ dth: 14 })), 1.6);
check('3-star 100% five TH down (floor)', attackPoints(atk({ dth: 11 })), 1.6);
check('2-star 85% equal TH', attackPoints(atk({ stars: 2, dest: 85 })), 2.85);
check('cleanup, 0 stars gained 8% dest', attackPoints(atk({ stars: 0, dest: 8 })), 0.08);
check('wasted attack on dead base', attackPoints(atk({ stars: 0, dest: 0 })), 0);
check('missed attack', attackPoints(atk({ missed: true })), -3);

console.log('\n=== War score: perfect attacker, equal TH ===');
{
  const r = warScore(Array.from({ length: 10 }, () => atk({})));
  check('reliability', r.pillars.reliability, 100);
  check('performance', r.pillars.performance, 100);
  check('total', r.total, 100);
  check('tier', applyCap(r.total, r.cap)?.name === 'Legendary' ? 1 : 0, 1);
}

console.log('\n=== War score: reliable but farms two TH down ===');
{
  const r = warScore(Array.from({ length: 10 }, () => atk({ dth: 14 })));
  check('reliability', r.pillars.reliability, 100);
  check('performance', r.pillars.performance, 40);
  check('raw total', r.total, 76);
  const t = applyCap(r.total, r.cap);
  console.log(`  cap applied: ${r.cap} -> final tier ${t?.name}`);
  check('capped to Rare', t?.name === 'Rare' ? 1 : 0, 1);
}

console.log('\n=== War score: strong attacker, 2 misses in 10 ===');
{
  const attacks = [
    ...Array.from({ length: 8 }, () => atk({})),
    atk({ missed: true }),
    atk({ missed: true }),
  ];
  const r = warScore(attacks);
  check('reliability', r.pillars.reliability, 80);
  check('performance', r.pillars.performance, 100);
  check('raw total', r.total, 88);
  const t = applyCap(r.total, r.cap);
  console.log(`  cap applied: ${r.cap} -> final tier ${t?.name}`);
  check('capped to Rare', t?.name === 'Rare' ? 1 : 0, 1);
}

console.log('\n=== War score: small sample confidence blending ===');
{
  const r = warScore([atk({}), atk({}), atk({}), atk({})]);
  // confidence = 4/8 = 0.5 -> 0.5*100 + 0.5*50 = 75
  check('reliability blended', r.pillars.reliability, 75);
  check('has enough attacks to score', r.total === null ? 0 : 1, 1);
}

console.log('\n=== War score: below minimum attacks ===');
{
  const r = warScore([atk({}), atk({}), atk({})]);
  check('total is null', r.total, null);
  check('status is New', r.status === 'New' ? 1 : 0, 1);
}

console.log('\n=== War score: window only keeps last 10 ===');
{
  const attacks = [
    ...Array.from({ length: 5 }, () => atk({ missed: true })),
    ...Array.from({ length: 10 }, () => atk({})),
  ];
  const r = warScore(attacks);
  check('old misses dropped, reliability', r.pillars.reliability, 100);
  check('available capped at 10', r.available, 10);
}

console.log('\n=== Clan score: full contributor ===');
{
  const r = clanScore({
    donationsLast30d: 800,
    daysPresent: 30,
    weekends: [weekend(5), weekend(5), weekend(5), weekend(5)],
    goldContributed: 50000,
    goldLooted: 50000,
  });
  check('donations', r.pillars.donations, 100);
  check('raids', r.pillars.raids, 100);
  check('contributions', r.pillars.contributions, 100);
  check('total', r.total, 100);
}

console.log('\n=== Clan score: raids fully, hoards capital gold ===');
{
  const r = clanScore({
    donationsLast30d: 800,
    daysPresent: 30,
    weekends: [weekend(5), weekend(5), weekend(5), weekend(5)],
    goldContributed: 10000,
    goldLooted: 50000,
  });
  check('contributions', r.pillars.contributions, 20);
  check('total', r.total, 80);
}

console.log('\n=== Clan score: present but skips raids (real zero) ===');
{
  const r = clanScore({
    donationsLast30d: 800,
    daysPresent: 30,
    weekends: [weekend(0), weekend(0), weekend(0), weekend(0)],
    goldContributed: 0,
    goldLooted: 0,
  });
  check('raids', r.pillars.raids, 0);
  check('contributions null (no loot)', r.pillars.contributions, null);
  // renormalized across donations(0.40) + raids(0.35)
  check('total', r.total, 53.3);
}

console.log('\n=== Clan score: light donator, raids hard, gives all gold ===');
{
  const r = clanScore({
    donationsLast30d: 160,
    daysPresent: 30,
    weekends: [weekend(5), weekend(5), weekend(5), weekend(5)],
    goldContributed: 40000,
    goldLooted: 40000,
  });
  check('donations', r.pillars.donations, 40);
  check('total', r.total, 76);
}

console.log('\n=== Clan score: new member, donations only ===');
{
  const r = clanScore({
    donationsLast30d: 100,
    daysPresent: 7,
    weekends: null,
    goldContributed: 0,
    goldLooted: 0,
  });
  // target scales to 400 * 7/30 = 93.3, so 100 donated clears it
  check('donations scaled', r.pillars.donations, 100);
  check('total is donations alone', r.total, 100);
}

console.log('\n=== Tier boundaries ===');
check('85 -> Legendary', tierFor(85).name === 'Legendary' ? 1 : 0, 1);
check('84.9 -> Epic', tierFor(84.9).name === 'Epic' ? 1 : 0, 1);
check('70 -> Epic', tierFor(70).name === 'Epic' ? 1 : 0, 1);
check('55 -> Rare', tierFor(55).name === 'Rare' ? 1 : 0, 1);
check('40 -> Uncommon', tierFor(40).name === 'Uncommon' ? 1 : 0, 1);
check('39 -> Common', tierFor(39).name === 'Common' ? 1 : 0, 1);

console.log('\n=== Cap never promotes ===');
check('score 30 with Rare cap stays Common', applyCap(30, 'Rare').name === 'Common' ? 1 : 0, 1);

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}\n`);
process.exit(failures === 0 ? 0 : 1);
