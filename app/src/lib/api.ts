import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

// In development the API runs on the same machine as Metro, so a phone can reach it on the LAN.
const devHost = Constants.expoConfig?.hostUri?.split(':')[0] ?? 'localhost';
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? `http://${devHost}:8000`;
export const WS_URL = API_URL.replace(/^http/, 'ws');

export type Profile = { id: string; token: string; name: string };
export type RecentTeam = { teamId: string; code: string };

export type Seat = {
  id: string;
  name: string;
  online: boolean;
  sittingOut: boolean;
  stack: number;
  inHand: boolean;
  folded: boolean;
  allin: boolean;
  bet: number;
  last: string;
  cards: string[] | null;
};

export type Winner = { id: string; won: number; net: number; name: string | null; cards: string[] };

export type HandView = {
  board: string[];
  pot: number;
  seq: number;
  toAct: string | null;
  turnMs: number;
  current: number;
  legal: { call: number; raiseMin: number | null; raiseMax: number | null } | null;
  handName: string | null;
  result: { winners: Winner[]; shown: string[]; names: Record<string, string>; pot: number } | null;
};

export type Settings = { bb: number; stack: number; timer: number };

export type TableView = {
  you: string;
  code: string;
  host: string;
  settings: Settings;
  running: boolean;
  paused: boolean;
  seats: Seat[];
  hand: HandView | null;
};

export class AuthError extends Error {}

async function request(path: string, method: string, token?: string, body?: object) {
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Can't reach the server. Check your connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new AuthError('Your profile was not found. Please set it up again.');
  if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'That did not work.');
  return data;
}

export const createGuest = (name: string) => request('/guests', 'POST', undefined, { name });
export const updateGuest = (token: string, name: string) => request('/me', 'PUT', token, { name });
export const deleteGuest = (token: string) => request('/me', 'DELETE', token);
export const createTeam = (token: string): Promise<RecentTeam> => request('/teams', 'POST', token);
export const joinTeam = (token: string, code: string): Promise<RecentTeam> =>
  request('/teams/join', 'POST', token, { code });

const PROFILE_KEY = 'profile';
const RECENT_KEY = 'recentTeams';

export async function loadProfile(): Promise<Profile | null> {
  const raw = await SecureStore.getItemAsync(PROFILE_KEY);
  return raw ? JSON.parse(raw) : null;
}
export const saveProfile = (p: Profile) => SecureStore.setItemAsync(PROFILE_KEY, JSON.stringify(p));
export async function clearLocalData() {
  await SecureStore.deleteItemAsync(PROFILE_KEY);
  await SecureStore.deleteItemAsync(RECENT_KEY);
}

export async function loadRecent(): Promise<RecentTeam[]> {
  const raw = await SecureStore.getItemAsync(RECENT_KEY);
  return raw ? JSON.parse(raw) : [];
}
export async function rememberTeam(team: RecentTeam) {
  const others = (await loadRecent()).filter((t) => t.teamId !== team.teamId);
  const recent = [team, ...others].slice(0, 5);
  await SecureStore.setItemAsync(RECENT_KEY, JSON.stringify(recent));
  return recent;
}
export async function forgetTeam(teamId: string) {
  const recent = (await loadRecent()).filter((t) => t.teamId !== teamId);
  await SecureStore.setItemAsync(RECENT_KEY, JSON.stringify(recent));
}
