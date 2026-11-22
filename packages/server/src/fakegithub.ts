// A stand-in for GitHub's sign-in endpoints, for tests: the device flow, the code
// exchange and /user, over a `fetch` that never leaves the process.

import { GitHub, type GitHubUser } from "./github.ts";

const WEB = "https://github.test";
const API = "https://api.github.test";

export class FakeGitHub {
  readonly github: GitHub;
  /** Device codes, by GitHub's secret device code. */
  private readonly devices = new Map<string, { userCode: string; user: GitHubUser | null; denied: boolean; polls: number }>();
  private readonly codes = new Map<string, GitHubUser>();
  private readonly tokens = new Map<string, GitHubUser>();
  private n = 0;
  /** What sign-in asked GitHub for, to check nothing more is asked. */
  readonly requests: { url: string; body: Record<string, string> }[] = [];
  /** Answer `slow_down` to the next poll. */
  slowDown = false;

  constructor(opts: { clientSecret?: string } = {}) {
    this.github = new GitHub({ clientId: "Iv1.test", ...(opts.clientSecret ? { clientSecret: opts.clientSecret } : {}), webBase: WEB, apiBase: API, fetch: this.fetch });
  }

  /** The person enters the code at GitHub and approves (or doesn't). */
  approve(userCode: string, user: GitHubUser): void {
    this.device(userCode).user = user;
  }
  deny(userCode: string): void {
    this.device(userCode).denied = true;
  }
  /** GitHub sends the browser back with this code, for `user`. */
  codeFor(user: GitHubUser): string {
    const code = `code${++this.n}`;
    this.codes.set(code, user);
    return code;
  }

  private device(userCode: string) {
    const d = [...this.devices.values()].find((x) => x.userCode === userCode);
    if (!d) throw new Error(`No device code ${userCode}`);
    return d;
  }

  private readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url === `${API}/user`) {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      const u = this.tokens.get(auth.replace(/^Bearer /, ""));
      return u ? json({ login: u.login, id: u.id, name: null }) : json({ message: "Bad credentials" }, 401);
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;
    this.requests.push({ url, body });
    if (body.client_id !== "Iv1.test") return json({ error: "incorrect_client_credentials" });
    const token = (u: GitHubUser) => {
      const t = `gho_${++this.n}`;
      this.tokens.set(t, u);
      return json({ access_token: t, token_type: "bearer", scope: "" });
    };
    if (url === `${WEB}/login/device/code`) {
      const device = `dc${++this.n}`;
      const userCode = `WXYZ-${String(this.n).padStart(4, "0")}`;
      this.devices.set(device, { userCode, user: null, denied: false, polls: 0 });
      return json({ device_code: device, user_code: userCode, verification_uri: `${WEB}/login/device`, expires_in: 900, interval: 5 });
    }
    if (url === `${WEB}/login/oauth/access_token`) {
      if (body.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
        const d = this.devices.get(body.device_code ?? "");
        if (!d) return json({ error: "expired_token" });
        d.polls++;
        if (this.slowDown) {
          this.slowDown = false;
          return json({ error: "slow_down", interval: 10 });
        }
        if (d.denied) return json({ error: "access_denied" });
        if (!d.user) return json({ error: "authorization_pending" });
        this.devices.delete(body.device_code!);
        return token(d.user);
      }
      if (body.client_secret !== "shh") return json({ error: "incorrect_client_credentials" });
      const u = this.codes.get(body.code ?? "");
      if (!u) return json({ error: "bad_verification_code" });
      this.codes.delete(body.code!);
      return token(u);
    }
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
}
