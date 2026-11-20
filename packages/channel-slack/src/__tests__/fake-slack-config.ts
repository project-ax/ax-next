import { fakeBotToken, fakeConfigAccessToken, fakeConfigRefreshToken } from './fake-slack-tokens.js';
import {
  SlackApiError,
  type CreatedApp,
  type OAuthInstall,
  type RotatedConfigToken,
  type SlackApi,
} from '../slack-api.js';

// What the fake Slack hands back, and the secrets it mints. Distinctive, so a
// leak is easy to spot; shaped like Slack's, but short enough that a secret
// scanner won't take them for real ones.
export const NOW_MS = Date.parse('2026-11-13T12:00:00.000Z');
export const MINTED_ACCESS = fakeConfigAccessToken('MINTEDACCESSSECRET');
/** The refresh token the fake Slack mints with its nth rotate, counting from 1. */
export const mintedRefresh = (n: number): string => fakeConfigRefreshToken(`MINTEDREFRESH${n}SECRET`);
export const CLIENT_SECRET = 'CLIENTSECRET0123456789abcdef';
export const SIGNING_SECRET = 'SIGNINGSECRET3f1c2b9a8e7d6c5b';
export const BOT_TOKEN = fakeBotToken();
export const APP: CreatedApp = {
  appId: 'A07QF9ZK2MN',
  clientId: '7512345678901.7598765432109',
  clientSecret: CLIENT_SECRET,
  signingSecret: SIGNING_SECRET,
};
export const GRANT: OAuthInstall = {
  botToken: BOT_TOKEN,
  botUserId: 'U07BOTUSER1',
  appId: APP.appId,
  teamId: 'T07ABCDEF12',
  teamName: 'Canopy Works',
  enterpriseInstall: false,
};

// ── A fake Slack: the six calls the admin routes make ───────────────────────

export interface SlackBehaviour {
  rotateConfigToken(refreshToken: string): Promise<RotatedConfigToken>;
  createApp(token: string, manifest: Record<string, unknown>): Promise<CreatedApp>;
  updateApp(token: string, appId: string, manifest: Record<string, unknown>): Promise<void>;
  deleteApp(token: string, appId: string): Promise<void>;
  setAppIcon(token: string, appId: string, png: Uint8Array): Promise<void>;
  oauthAccess(i: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<OAuthInstall>;
}

export function fakeSlack(trail: string[]) {
  const calls: Array<{ method: keyof SlackBehaviour; args: unknown[] }> = [];
  /** Every refresh token a rotate was sent, and how many refresh tokens the rotates minted. */
  const rotated = new Set<string>();
  let mints = 0;
  /** The apps that exist on this Slack: each create that succeeded, less each delete that did. */
  const live = new Set<string>();
  /** What each call does; a test swaps one out. */
  const on: SlackBehaviour = {
    /**
     * Slack retires a rotated refresh token within minutes to hours (MEASURED,
     * TASK-1097 walk; slack-api.ts). This fake retires it at once, so any path
     * that rotates one token twice fails. `rotatedStillWork` stands in for the
     * time before Slack retires it.
     */
    rotateConfigToken: async (refreshToken) => {
      if (rotated.has(refreshToken) && !slack.rotatedStillWork) {
        throw new SlackApiError('tooling.tokens.rotate', 'invalid_refresh_token');
      }
      rotated.add(refreshToken);
      mints += 1;
      return { accessToken: MINTED_ACCESS, refreshToken: mintedRefresh(mints), expiresAt: NOW_MS + 43_200_000 };
    },
    createApp: async () => ({ ...APP }),
    updateApp: async () => {},
    deleteApp: async () => {},
    setAppIcon: async () => {},
    oauthAccess: async () => ({ ...GRANT }),
  };
  const record = (method: keyof SlackBehaviour, args: unknown[]): void => {
    calls.push({ method, args });
    trail.push(`slack:${method}`);
  };
  const notHere = async (): Promise<never> => {
    throw new Error('the admin routes never make this call');
  };
  const api: SlackApi = {
    rotateConfigToken: async (refreshToken) => {
      record('rotateConfigToken', [refreshToken]);
      return on.rotateConfigToken(refreshToken);
    },
    createApp: async (token, manifest) => {
      record('createApp', [token, manifest]);
      const app = await on.createApp(token, manifest);
      live.add(app.appId);
      return app;
    },
    updateApp: async (token, appId, manifest) => {
      record('updateApp', [token, appId, manifest]);
      return on.updateApp(token, appId, manifest);
    },
    deleteApp: async (token, appId) => {
      record('deleteApp', [token, appId]);
      await on.deleteApp(token, appId);
      live.delete(appId);
    },
    setAppIcon: async (token, appId, png) => {
      record('setAppIcon', [token, appId, png]);
      return on.setAppIcon(token, appId, png);
    },
    oauthAccess: async (i) => {
      record('oauthAccess', [i]);
      return on.oauthAccess(i);
    },
    usersInfo: notHere,
    postMessage: notHere,
    postBlocks: notHere,
    updateMessage: notHere,
    postEphemeral: notHere,
    startStream: notHere,
    appendStream: notHere,
    stopStream: notHere,
  };
  const slack = {
    api,
    calls,
    on,
    live,
    /** A rotated refresh token still works, as it does on Slack for a while after its rotate. */
    rotatedStillWork: false,
  };
  return slack;
}
