// Signing in with GitHub (DESIGN §11.1): the device flow for the CLI and MCP, and the
// OAuth redirect for the web. GitHub only tells the server who someone is; no scope is
// asked for, since the public profile (login and numeric ID) is all that's needed, and
// GitHub's token is dropped as soon as it has said who it belongs to.

import { RepoError } from "./repo.ts";

export interface GitHubConfig {
  /** The OAuth app's client ID. The device flow needs nothing else. */
  clientId: string;
  /** For the web redirect flow only. Read from the environment, never the command line. */
  clientSecret?: string;
  /** github.com and api.github.com unless told otherwise (GitHub Enterprise; tests). */
  webBase?: string;
  apiBase?: string;
  fetch?: typeof fetch;
}

export interface GitHubUser {
  login: string;
  id: number;
}

export interface DeviceStart {
  /** Pass back when polling. */
  device: string;
  userCode: string;
  verificationUri: string;
  /** Seconds between polls, and until the code expires. */
  interval: number;
  expiresIn: number;
}

/** A device-flow poll: a token at last, or wait (longer, if GitHub says to slow down). */
export type DevicePoll = { token: string } | { pending: true; interval?: number };

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export class GitHub {
  readonly clientId: string;
  readonly clientSecret: string | undefined;
  private readonly web: string;
  private readonly api: string;
  private readonly http: typeof fetch;

  constructor(config: GitHubConfig) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.web = (config.webBase ?? "https://github.com").replace(/\/+$/, "");
    this.api = (config.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
    this.http = config.fetch ?? fetch;
  }

  async startDevice(): Promise<DeviceStart> {
    const r = await this.post("/login/device/code", { client_id: this.clientId });
    if (typeof r.device_code !== "string" || typeof r.user_code !== "string") throw unavailable(r);
    return {
      device: r.device_code,
      userCode: r.user_code,
      verificationUri: typeof r.verification_uri === "string" ? r.verification_uri : `${this.web}/login/device`,
      interval: typeof r.interval === "number" ? r.interval : 5,
      expiresIn: typeof r.expires_in === "number" ? r.expires_in : 900,
    };
  }

  async pollDevice(device: string): Promise<DevicePoll> {
    const r = await this.post("/login/oauth/access_token", { client_id: this.clientId, device_code: device, grant_type: DEVICE_GRANT });
    if (typeof r.access_token === "string") return { token: r.access_token };
    switch (r.error) {
      case "authorization_pending":
        return { pending: true };
      case "slow_down":
        return typeof r.interval === "number" ? { pending: true, interval: r.interval } : { pending: true };
      case "expired_token":
        throw new RepoError("state", "The code expired before it was entered: run sapwood login again");
      case "access_denied":
        throw new RepoError("forbidden", "Sign-in was cancelled at GitHub");
      default:
        throw unavailable(r);
    }
  }

  /** Where to send a browser to sign in. */
  authorizeUrl(state: string, redirectUri: string): string {
    const q = new URLSearchParams({ client_id: this.clientId, redirect_uri: redirectUri, state, allow_signup: "false" });
    return `${this.web}/login/oauth/authorize?${q}`;
  }

  /** The code GitHub sent the browser back with, for a token. */
  async exchangeCode(code: string, redirectUri: string): Promise<string> {
    if (!this.clientSecret) throw new RepoError("state", "Web sign-in needs the OAuth app's client secret ($SAPWOOD_GITHUB_CLIENT_SECRET)");
    const r = await this.post("/login/oauth/access_token", { client_id: this.clientId, client_secret: this.clientSecret, code, redirect_uri: redirectUri });
    if (typeof r.access_token === "string") return r.access_token;
    if (r.error === "bad_verification_code") throw new RepoError("forbidden", "GitHub didn't accept the sign-in: try again");
    throw unavailable(r);
  }

  /** Who a GitHub token belongs to. */
  async user(token: string): Promise<GitHubUser> {
    const res = await this.http(`${this.api}/user`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "sapwood-server" } });
    const r = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof r.login !== "string" || typeof r.id !== "number") throw unavailable(r);
    return { login: r.login, id: r.id };
  }

  private async post(path: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.http(`${this.web}${path}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": "sapwood-server" },
      body: JSON.stringify(body),
    });
    return (await res.json().catch(() => ({}))) as Record<string, unknown>;
  }
}

function unavailable(r: Record<string, unknown>): RepoError {
  const why = typeof r.error_description === "string" ? r.error_description : typeof r.error === "string" ? r.error : typeof r.message === "string" ? r.message : "no answer";
  return new RepoError("upstream", `GitHub sign-in failed: ${why}`);
}
