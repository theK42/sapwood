# Hosting Sapwood

The server is one Node process and one SQLite file. It needs a machine (or container) that
keeps running, and a disk that survives restarts. It serves the web app and the API from one
address, and people sign in with GitHub.

This guide sets up a small demo on [Fly.io](https://fly.io), from the Docker image this repo
publishes. The same image runs on any host with Docker and a volume.

## The image

Each push to `main` builds the image and publishes it to GitHub's container registry as
`ghcr.io/thek42/sapwood:latest` (and `:<commit sha>`), with `.github/workflows/image.yml`.
You can also run that workflow by hand from the repo's Actions tab.

If the repo is private, its image package starts private too, and Fly can't pull it. Once,
after the first build: on GitHub, open your profile's **Packages**, then **sapwood**, then
**Package settings**, and set its visibility to **Public**. That publishes the built image,
not the repo's source.

The image runs `sapwood-server serve` and is configured by environment variables:

| Variable | What it's for |
|---|---|
| `SAPWOOD_DB` | The SQLite file. In the image, `/data/sapwood.sqlite`: put a volume at `/data`. |
| `PORT`, `SAPWOOD_HOST` | Where it listens. In the image, `8080` on `0.0.0.0`. |
| `SAPWOOD_PUBLIC_URL` | The address people use, such as `https://sapwood-demo.fly.dev`. |
| `SAPWOOD_GITHUB_CLIENT_ID` | The GitHub OAuth app's client ID: turns GitHub sign-in on. |
| `SAPWOOD_GITHUB_CLIENT_SECRET` | Its secret, for signing in on the web. A secret: don't put it in a file in the repo. |
| `SAPWOOD_SIGNUP_ROLE` | Open sign-up: `viewer`, `editor` or `developer`. Anyone signing in with GitHub becomes a user with that role. Unset, people not yet added are refused, and their request for access waits on the Admin page. |
| `SAPWOOD_INIT_ADMIN` | First start only: the GitHub login of the first Admin. |
| `SAPWOOD_INIT_PROJECT` | First start only: `krbsg` for the sample project, or `empty` (the default). |

On its first start, with no project in the database and `SAPWOOD_INIT_ADMIN` set, the server
starts the project itself. After that the two `INIT` variables do nothing, so they can stay.

## 1. A GitHub OAuth app

On GitHub: **Settings**, **Developer settings**, **OAuth Apps**, **New OAuth App**.

- **Homepage URL:** your server's address, such as `https://sapwood-demo.fly.dev`.
- **Authorization callback URL:** that address plus `/auth/github/callback`.
- After making it, tick **Enable Device Flow** (for `sapwood login` from the command line).
- Note the **Client ID**, and generate a **client secret**.

## 2. Fly.io, once

Install `flyctl` ([fly.io/docs/flyctl/install](https://fly.io/docs/flyctl/install/)), then
`fly auth login`. Fly needs a card on file for the free allowance; a demo this size stays
inside it.

In `fly.toml`, change `app` to a name of your own (it becomes `<name>.fly.dev`), set
`SAPWOOD_PUBLIC_URL` to match, and set `SAPWOOD_INIT_ADMIN` to your GitHub login. Pick
`primary_region` near you (`fly platform regions` lists them). Then, from the repo:

```powershell
fly apps create sapwood-demo
```

```powershell
fly volumes create sapwood_data --size 1 --region iad --app sapwood-demo
```

```powershell
fly secrets set SAPWOOD_GITHUB_CLIENT_ID=<client id> SAPWOOD_GITHUB_CLIENT_SECRET=<client secret> --app sapwood-demo
```

```powershell
fly deploy
```

Open `https://sapwood-demo.fly.dev` and sign in with GitHub as the Admin you named.

## 3. Inviting people

Roles: Viewers read, Editors edit data and land, Developers also change the schema and packs,
Admins also manage people and tokens.

- **Ask for access** (always): send people the address. Signing in with GitHub, someone who
  isn't a user yet is told their request has gone to the Admins. It shows on the **Admin**
  tab (with a count on the tab), under **People**, **Asking for access**: pick a role and
  **Add**, or **Dismiss**. Once added, they sign in again.
- **Add them first:** on the same page, **Add someone** by GitHub login, with a role.
- **Open sign-up:** with `SAPWOOD_SIGNUP_ROLE` set (`fly.toml` sets `editor` for the demo),
  anyone signing in with GitHub gets that role at once. Anyone who has the address can get
  in, so use it for demos. You can change a role, or remove someone, on the Admin tab.

## Connecting Claude

The server hosts the MCP server at `/mcp`: nothing to install. Each person connects their
own Claude, as themselves.

- **Claude Desktop or claude.ai:** **Settings**, **Connectors**, **Add custom connector**,
  with the address `https://sapwood-demo.fly.dev/mcp`. **Connect** opens this server: sign in
  with GitHub, and **Allow**. (Claude reaches the server from Anthropic's side, so it must be
  on the internet, as a Fly server is.)
- **Claude Code:** `claude mcp add --transport http sapwood https://sapwood-demo.fly.dev/mcp`,
  then connect from `/mcp` in Claude Code, which signs in the same way.

Claude then works in the person's current task, with their role; it can't land, so they review
and land what it did. Its token shows under **Your tokens** as "Claude (connector)": revoking it
disconnects Claude. The same page (click your name in the top bar) shows the address to copy.

## Updating

Push to `main`, wait for the **Image** workflow to finish, then:

```powershell
fly deploy
```

A deploy restarts the server: a few seconds where it isn't there. The project, on the
volume, stays.

## What it costs, and what it does when idle

`fly.toml` asks for a shared CPU with 512 MB and a 1 GB volume. With `auto_stop_machines`,
the server stops when nobody's used it for a while and starts on the next visit, in a few
seconds, so a demo costs little; Fly's free allowance ($5 of usage a month) covers it.

There are no backups in this setup: the project lives on one volume. Fly takes daily
snapshots of volumes (`fly volumes snapshots list`), which is enough for a demo.

## Running it elsewhere

Anywhere with Docker:

```powershell
docker run -p 8080:8080 -v sapwood-data:/data -e SAPWOOD_INIT_ADMIN=<your login> -e SAPWOOD_INIT_PROJECT=krbsg ghcr.io/thek42/sapwood:latest
```

Without GitHub sign-in (no `SAPWOOD_GITHUB_CLIENT_ID`), people sign in with tokens made on the
server: `docker exec <container> node packages/server/src/main.ts token <login> --name <name>`.
