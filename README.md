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

`npx sapwood help` lists the commands. For now the CLI works on a local `sapwood.json`.

## The server

```bash
npx sapwood-server init --admin <your GitHub login> --schema schema.yaml --from project.yaml
npx sapwood-server token <your GitHub login> --name laptop
npx sapwood-server serve
curl -H "Authorization: Bearer swd_…" http://127.0.0.1:8417/api/branches/main/entities/Blaster
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
