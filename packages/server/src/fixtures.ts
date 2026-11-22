// A small project for the server's tests.

export const SCHEMA = `
types:
  Weapon:
    fields:
      damage: float
      shots: "list<ref<Ammo>>"
  Ammo: { fields: { speed: float } }
  Config:
    singleton: true
    fields: { lives: int }
`;
export const PROJECT = `
sheets:
  - name: Weapons
    layouts: { Weapon: [damage, shots] }
    rows:
      - [Weapon, w1, 10, '["a1"]']
      - [Weapon, w2, "=C1*2"]
  - name: Ammo
    rows:
      - [Ammo, a1, 900]
      - [Ammo, a2, 600]
      - [Config]
      - [.lives, 3]
`;
