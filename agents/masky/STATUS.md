# Masky integration status

Masky is complete at the affordable integration-demonstration level. No further
Masky call, avatar creation or deletion, speech request, change to the existing
avatar, or paid plan is part of this project.

## Verified evidence

| Item | Value |
| --- | --- |
| Avatar | `VDzafw3fD73I9SNZC6SY`, "Iris Vale, NativeFrame Content Curator", not publicly renderable; adopted by one read-only `GET /avatars` exact-name match and recorded in `avatar-ledger.jsonl` |
| Voice | Warm Female Assistant Voice (`voice_33bd713fff1160b2f59404f07829d699f59d623e8965440b766a17ff3c3e9e75`) |
| Speech job | `hH2XH0aWlhCLj0T74Epe`, the committed Content Curator line, recovered by one identical (deduplicated, `reused: true`) request and recorded in `avatar-ledger.jsonl` |
| Audio | downloaded through the hardened media path (every redirect hop https to a public host, size-capped), validated (MP3, mono, 24 kHz, 8.92 s), stored privately at `storage://nf-media/agents/spoken/content-curator-v1.mp3`, `sha256:43b58203d6434039c1564b7a2541401bd63e341062d497cc0281688d8b3cd53c` |
| Portrait | `storage://nf-media/agents/portraits/content-curator-v1.png`, `sha256:9afb67f4179e162fc0f3600b71ea1cd5ce1878870d60acb6e919e8a7f07069c0` (rendered locally from the committed spec) |

## Limitation

The full five-avatar batch is blocked only by the Masky account's two-avatar
limit (HTTP 403 `avatar_limit_reached` when creating the Scene Scout avatar).
The five-avatar Creator plan costs $50/month and is intentionally out of scope.

## Demo behaviour

The limitation never makes the application or demo fail. No live identity
manifest (`generated-identities.json`) exists, so every agent is presented by
`presentIdentity` with its deterministic local portrait, its spoken line as a
caption, and the fallback disclosure. The Scene Scout, Campaign Matcher,
Placement Director, and Release Governor identities exist only as these local
fallbacks. The private Content Curator audio and the ledger remain the record
of the working end-to-end Masky path.
