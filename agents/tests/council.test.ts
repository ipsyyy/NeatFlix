import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { AGENT_ROLES } from "@/agents/config/roles";
import { AGENT_IDENTITIES, identitySpecSha256 } from "@/agents/masky/identities";
import { COUNCIL, FOUNDER } from "@/lib/demo/council";

describe("AI Executive Council presentation", () => {
  it("seats exactly the five agents, in workflow order, with their existing names", () => {
    assert.deepEqual(COUNCIL.map((s) => s.role), [...AGENT_ROLES]);
    for (const s of COUNCIL) assert.equal(s.name, AGENT_IDENTITIES[s.role].characterName);
  });

  it("gives every member a distinct archetype, palette, and signature line", () => {
    for (const key of ["archetype", "signatureLine"] as const) assert.equal(new Set(COUNCIL.map((s) => s[key])).size, 5, key);
    assert.equal(new Set(COUNCIL.map((s) => s.palette.accent)).size, 5);
    for (const s of COUNCIL) assert.match(s.palette.accent + s.palette.deep, /^#[0-9a-f]{6}#[0-9a-f]{6}$/i);
  });

  it("leaves Iris Vale's identity spec untouched, so her recorded Masky avatar still matches the ledger", () => {
    const ledger = readFileSync(resolve(process.cwd(), "agents/masky/avatar-ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const adopted = ledger.find((e) => e.event === "avatar-adopted" && e.role === "content-curator");
    assert.equal(identitySpecSha256(AGENT_IDENTITIES["content-curator"]), adopted.specSha256);
  });

  it("shows the founder only from the user's own public photo, never a generated image", () => {
    assert.equal(FOUNDER.photo, `/${FOUNDER.photoFile.slice(1).join("/")}`);
    assert.equal(FOUNDER.photoFile[0], "public");
  });
});
