# Sapwood

Version-controlled, validated game data, edited as a spreadsheet, a form, or JSON.

Status: early development. Nothing usable yet.

- [Design](docs/DESIGN.md)
- [Roadmap](docs/ROADMAP.md)
- [Hosting](docs/HOSTING.md): a server on Fly.io, or anywhere with Docker

## The command line

```bash
npx sapwood init --schema schema.yaml
npx sapwood create Weapon Blaster cooldown=0.5 projectiles=BlasterBolt
npx sapwood query Weapon --where "cooldown<1"
npx sapwood validate
npx sapwood export --out build/data
```

`npx sapwood help` lists the commands. Without a server, `sapwood init` keeps the project in a local `sapwood.json`. On Windows, if PowerShell says running scripts is disabled, type `npx.cmd` instead of `npx`: it is the same command, and needs no change to the policy.

## The server

```bash
npx sapwood-server init --admin <your GitHub login> --schema schema.yaml --from project.yaml
npx sapwood-server user add <a teammate's GitHub login> --role editor
npx sapwood-server serve
```

People sign in with GitHub. For that, [register a GitHub OAuth app](https://github.com/settings/applications/new) with **Enable Device Flow** ticked and the callback URL `<server url>/auth/github/callback`, then serve with its details in the environment:

```bash
export SAPWOOD_GITHUB_CLIENT_ID=Iv1.…          # enough for sapwood login
export SAPWOOD_GITHUB_CLIENT_SECRET=…          # for signing in on the web
export SAPWOOD_PUBLIC_URL=https://sapwood.example.com
npx sapwood-server serve
```

Without an OAuth app, `npx sapwood-server token <login> --name laptop` makes a token instead. Then, from anywhere:

```bash
npx sapwood login --server 127.0.0.1:8417  # shows a code to enter at github.com
npx sapwood set Blaster cooldown=0.25      # goes into your current task
npx sapwood task                           # its changes, conflicts and validation
npx sapwood task land -m "Faster Blaster"
```

The database is one SQLite file, `sapwood.sqlite` (or `--db`, or `$SAPWOOD_DB`). Edits go into tasks and land onto branches; [DESIGN §9.4](docs/DESIGN.md) lists the HTTP API.

`serve` also serves the web app, once it's built with `npm run build:web`, at the server's own address. Sign in there with GitHub, or with a Sapwood token on a server without GitHub sign-in. The web app is early: it has the home page (the packs and sheets with their validation, recent commits, other people's tasks), your task with undo, redo and Land, and the spreadsheet: typing, formulas, validation on the cells, formatting, copy and paste (with Sheets and Excel too), fill, and inserting, deleting and moving rows and columns.

## With an LLM

`sapwood-mcp` is an MCP server: an AI tool starts it, and it works where `sapwood` would, with your login. For Claude Code:

```bash
claude mcp add sapwood -- npx sapwood-mcp
```

(On Windows: `claude mcp add sapwood -- cmd /c npx sapwood-mcp`.) The LLM can read, query, validate and edit. On a server its edits go into your current task, next to yours; it can't land, so check its work with `sapwood task` and land it yourself.

## Development

Requires Node.js 24 or newer.

```bash
npm install
npm run typecheck
npm test
```

To work on the web app, run a server, then `npm run dev:web`: Vite serves the app on http://localhost:5173 and passes `/api` and `/auth` on to the server (`$SAPWOOD_SERVER`, default http://127.0.0.1:8417), so changes show at once.

## License

[MIT](LICENSE)
