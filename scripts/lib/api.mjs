// Shared Clash of Clans API helper.
//
// BASE is chosen automatically:
//   - Inside GitHub Actions (GITHUB_ACTIONS=true) -> RoyaleAPI proxy, since
//     Actions runners get a different IP every run.
//   - Anywhere else (your machine) -> direct API, since your token is
//     whitelisted to your own fixed IP.
// Override either by setting COC_API_BASE.

export const BASE =
  process.env.COC_API_BASE ||
  (process.env.GITHUB_ACTIONS === 'true'
    ? 'https://cocproxy.royaleapi.dev/v1'
    : 'https://api.clashofclans.com/v1');

export const TOKEN = process.env.COC_API_TOKEN;
export const CLAN_TAG = process.env.CLAN_TAG;

export function requireEnv() {
  if (!TOKEN || !CLAN_TAG) {
    console.error('Missing COC_API_TOKEN or CLAN_TAG environment variable.');
    process.exit(1);
  }
}

export function encTag(tag) {
  return encodeURIComponent(tag.startsWith('#') ? tag : '#' + tag);
}

export function normTag(tag) {
  if (!tag) return '';
  const t = tag.toUpperCase().trim();
  return t.startsWith('#') ? t : '#' + t;
}

export async function apiGet(path) {
  const res = await fetch(BASE + path, {
    headers: { Authorization: 'Bearer ' + TOKEN },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status} on ${path}: ${body}`);
  }
  return res.json();
}

// Returns { notFound: true } on 404 / 403 instead of throwing.
// 404 = no active CWL or no current war (normal between events).
// 403 = clan war log is set to private in-game (a config problem, but we
//       don't want it to kill the whole collector run).
export async function apiGetSoft(path) {
  const res = await fetch(BASE + path, {
    headers: { Authorization: 'Bearer ' + TOKEN },
  });
  if (res.status === 404) return { notFound: true, reason: 'notFound' };
  if (res.status === 403) return { notFound: true, reason: 'private' };
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status} on ${path}: ${body}`);
  }
  return res.json();
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}
