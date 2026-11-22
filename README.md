# Sapwood

Version-controlled, validated game data, edited as a spreadsheet, a form, or JSON.

Status: early development. Nothing usable yet.

- [Design](docs/DESIGN.md)
- [Roadmap](docs/ROADMAP.md)

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

## Development

Requires Node.js 24 or newer.

```bash
npm install
npm run typecheck
npm test
```

## License

[MIT](LICENSE)
