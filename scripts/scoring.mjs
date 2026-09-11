// Pure scoring logic. No network, no filesystem, no side effects.
// Everything here can be unit tested with synthetic fixtures.

export const CONFIG = {
  // Clan score
  DONATION_TARGET_30D: 400,
  RAID_WEEKEND_WINDOW: 4,
  CLAN_WEIGHTS: { donations: 0.40, raids: 0.35, loot: 0.25 },
  // Hitting the clan's median loot per attack scores this. Set to the Epic
  // threshold so an average raider reads as solid rather than mediocre.
  LOOT_MEDIAN_SCORE: 70,

  // War score
  WAR_ATTACK_WINDOW: 10,
  WAR_WEIGHTS: { reliability: 0.60, performance: 0.40 },
  CONFIDENCE_ATTACKS: 8,
  NEUTRAL_SCORE: 50,
  PERFECT_ATTACK_POINTS: 4.0,
  TH_MULT_PER_LEVEL: 0.3,
  TH_MULT_MIN: 0.4,
  TH_MULT_MAX: 1.8,
  MISS_PENALTY: -3,

  // Gates
  GRACE_DAYS: 14,
  MIN_WAR_ATTACKS: 4,
};

export const TIERS = [
  { name: 'Legendary', min: 85, color: '#EF9F27' },
  { name: 'Epic', min: 70, color: '#8981E0' },
  { name: 'Rare', min: 55, color: '#4A93DE' },
  { name: 'Uncommon', min: 40, color: '#7FB03A' },
  { name: 'Common', min: 0, color: '#888780' },
];

export function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

export function tierFor(score) {
  if (score === null || score === undefined) return null;
  return TIERS.find(t => score >= t.min) || TIERS[TIERS.length - 1];
}

// Caps a tier: returns the lower of the earned tier and the cap.
export function applyCap(score, capName) {
  if (!capName) return tierFor(score);
  const earned = tierFor(score);
  const cap = TIERS.find(t => t.name === capName);
  if (!earned || !cap) return earned;
  const earnedIdx = TIERS.indexOf(earned);
  const capIdx = TIERS.indexOf(cap);
  return earnedIdx < capIdx ? cap : earned;
}

// ---------------------------------------------------------------------------
// CLAN SCORE
// ---------------------------------------------------------------------------

// donationsLast30d: integer, troops donated in the trailing 30 days
export function donationScore(donationsLast30d, daysPresent = 30) {
  const scale = Math.min(1, Math.max(daysPresent, 1) / 30);
  const target = CONFIG.DONATION_TARGET_30D * scale;
  if (target <= 0) return null;
  return clamp((donationsLast30d / target) * 100, 0, 100);
}

// weekends: [{ attacksUsed, attackLimit, bonusAttackLimit, looted, clanMedian }]
//
// Participation only: did you use the attacks you were given. Loot is scored
// separately by lootScore, so the two pillars measure different things and a
// heavy raider is not rewarded twice for the same behaviour.
//
// A weekend the member was present for but skipped counts as a real zero.
export function raidScore(weekends) {
  if (!weekends || weekends.length === 0) return null;

  let usedTotal = 0;
  let availTotal = 0;

  for (const w of weekends) {
    const avail = (w.attackLimit || 0) + (w.bonusAttackLimit || 0);
    usedTotal += w.attacksUsed || 0;
    availTotal += avail > 0 ? avail : 5;
  }

  if (availTotal === 0) return null;
  return clamp((usedTotal / availTotal) * 100, 0, 100);
}

// Loot efficiency: gold looted per attack, measured against the clan's own
// median that weekend rather than an absolute target, because loot depends
// heavily on how far the raid got and which districts were reached.
//
// Scored so that hitting the clan median lands at LOOT_MEDIAN_SCORE (70,
// the Epic threshold) and roughly 1.4x median reaches 100. A plain ratio
// would pin half the clan at the ceiling by definition, since half of any
// group is at or above its own median.
//
// Present for weekends but never attacked is a real zero, not missing data:
// they chose not to raid, and returning null would renormalize the other
// pillars upward so that doing nothing outscored doing something.
export function lootScore(weekends) {
  if (!weekends || weekends.length === 0) return null;

  let sum = 0;
  let count = 0;
  let anyAttacks = false;

  for (const w of weekends) {
    if ((w.attacksUsed || 0) > 0) {
      anyAttacks = true;
      if (w.clanMedian > 0) {
        const perAttack = (w.looted || 0) / w.attacksUsed;
        sum += clamp((perAttack / w.clanMedian) * CONFIG.LOOT_MEDIAN_SCORE, 0, 100);
        count++;
      }
    }
  }

  if (count === 0) return anyAttacks ? null : 0;
  return clamp(sum / count, 0, 100);
}

// Renormalizes weights across whichever pillars have data.
export function weightedComposite(parts) {
  let sum = 0;
  let weight = 0;
  for (const [score, w] of parts) {
    if (score === null || score === undefined) continue;
    sum += score * w;
    weight += w;
  }
  if (weight === 0) return null;
  return sum / weight;
}

export function clanScore({ donationsLast30d, daysPresent, weekends }) {
  const d = donationScore(donationsLast30d, daysPresent);
  const r = raidScore(weekends);
  const l = lootScore(weekends);

  const total = weightedComposite([
    [d, CONFIG.CLAN_WEIGHTS.donations],
    [r, CONFIG.CLAN_WEIGHTS.raids],
    [l, CONFIG.CLAN_WEIGHTS.loot],
  ]);

  return {
    total: total === null ? null : Math.round(total * 10) / 10,
    pillars: {
      donations: d === null ? null : Math.round(d),
      raids: r === null ? null : Math.round(r),
      loot: l === null ? null : Math.round(l),
    },
  };
}

// ---------------------------------------------------------------------------
// WAR SCORE
// ---------------------------------------------------------------------------

// One attack record. `missed: true` means rostered but never attacked.
// starsGained / destGained are INCREMENTAL (what this attack added to the
// base's running best), not the raw attack result.
export function attackPoints(a) {
  if (a.missed) return CONFIG.MISS_PENALTY;
  const mult =
    a.defenderTH && a.attackerTH
      ? clamp(
          1 + CONFIG.TH_MULT_PER_LEVEL * (a.defenderTH - a.attackerTH),
          CONFIG.TH_MULT_MIN,
          CONFIG.TH_MULT_MAX
        )
      : 1;
  return ((a.starsGained || 0) + (a.destGained || 0) / 100) * mult;
}

export function warScore(attacks) {
  const window = (attacks || []).slice(-CONFIG.WAR_ATTACK_WINDOW);

  const available = window.length;
  const completed = window.filter(a => !a.missed);
  const misses = available - completed.length;

  if (available < CONFIG.MIN_WAR_ATTACKS) {
    return {
      total: null,
      status: 'New',
      pillars: { reliability: null, performance: null },
      available,
      used: completed.length,
      misses,
    };
  }

  const rawReliability = (completed.length / available) * 100;
  const confidence = Math.min(1, available / CONFIG.CONFIDENCE_ATTACKS);
  const reliability =
    confidence * rawReliability + (1 - confidence) * CONFIG.NEUTRAL_SCORE;

  let performance = null;
  if (completed.length > 0) {
    const avg =
      completed.reduce((s, a) => s + attackPoints(a), 0) / completed.length;
    performance = clamp((avg / CONFIG.PERFECT_ATTACK_POINTS) * 100, 0, 100);
  }

  const total = weightedComposite([
    [reliability, CONFIG.WAR_WEIGHTS.reliability],
    [performance, CONFIG.WAR_WEIGHTS.performance],
  ]);

  let cap = null;
  if (misses >= 3) cap = 'Uncommon';
  else if (misses >= 2) cap = 'Rare';
  if (performance !== null && performance < 50) {
    cap = cap === 'Uncommon' ? 'Uncommon' : 'Rare';
  }

  return {
    total: total === null ? null : Math.round(total * 10) / 10,
    status: null,
    cap,
    pillars: {
      reliability: Math.round(reliability),
      performance: performance === null ? null : Math.round(performance),
    },
    available,
    used: completed.length,
    misses,
  };
}

// ---------------------------------------------------------------------------
// GRACE PERIOD
// ---------------------------------------------------------------------------

export function daysBetween(isoA, isoB) {
  const a = new Date(isoA + 'T00:00:00Z').getTime();
  const b = new Date(isoB + 'T00:00:00Z').getTime();
  return Math.floor((b - a) / 86400000);
}

export function isInGracePeriod(firstSeen, todayIso) {
  return daysBetween(firstSeen, todayIso) < CONFIG.GRACE_DAYS;
}
