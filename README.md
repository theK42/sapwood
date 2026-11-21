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

`npx sapwood help` lists the commands. Until the server exists, the project lives in a local `sapwood.json`.

## Development

Requires Node.js 24 or newer.

```bash
npm install
npm run typecheck
npm test
```

## License

[MIT](LICENSE)
