import { BandClient } from "@band-ai/rest-client";
import { BandLink } from "@band-ai/sdk";
import type { BandUrls, RoleCredentials } from "@/agents/config/env";

export type RoomParticipant = { id: string; name: string; handle: string | null; type: string };

export type CaseRoom = {
  roomId: string;
  title: string;
  created: boolean;
  added: string[];
  participants: RoomParticipant[];
};

const PAGE_SIZE = 50;
const MAX_PAGES = 20;

/** Official BAND REST client for one agent, using the same base URL rules as the SDK. */
export function bandClientFor(credentials: RoleCredentials, urls: BandUrls): BandClient {
  const { restUrl } = new BandLink({ agentId: credentials.agentId, apiKey: credentials.apiKey, ...urls });
  return new BandClient({ apiKey: credentials.apiKey, baseUrl: restUrl });
}

async function findRoomByTitle(client: BandClient, title: string) {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await client.agentApiChats.listAgentChats({ page, page_size: PAGE_SIZE });
    const match = res.data.find((room) => room.title === title);
    if (match) return match;
    const totalPages = res.metadata.total_pages ?? page;
    if (page >= totalPages || res.data.length < PAGE_SIZE) return null;
  }
  return null;
}

async function listParticipants(client: BandClient, roomId: string): Promise<RoomParticipant[]> {
  const res = await client.agentApiParticipants.listAgentChatParticipants(roomId);
  return res.data.map((p) => ({ id: p.id, name: p.name ?? "unknown", handle: p.handle ?? null, type: p.type }));
}

/**
 * Creates (or reuses) the BAND room for a case, owned by `owner`, and makes
 * sure each listed participant ID is a member. Uses only Agent API calls the
 * owner agent is authorized for: its sibling agents and its human owner.
 */
export async function ensureCaseRoom(options: {
  caseId: string;
  /** Room title; defaults to the case ID. */
  title?: string;
  owner: RoleCredentials;
  urls: BandUrls;
  memberIds: (ownerUserId: string) => string[];
}): Promise<CaseRoom> {
  const client = bandClientFor(options.owner, options.urls);
  const me = await client.agentApiIdentity.getAgentMe();
  const ownerUserId = me.data.owner_uuid;
  if (!ownerUserId) throw new Error("BAND did not report a human owner for the room-owning agent.");

  const title = options.title ?? options.caseId;
  let room = await findRoomByTitle(client, title);
  let created = false;
  if (!room) {
    room = (await client.agentApiChats.createAgentChat({ chat: { title } })).data;
    created = true;
  }

  const present = new Set((await listParticipants(client, room.id)).map((p) => p.id));
  const added: string[] = [];
  for (const id of options.memberIds(ownerUserId)) {
    if (present.has(id)) continue;
    await client.agentApiParticipants.addAgentChatParticipant(room.id, {
      participant: { participant_id: id, role: "member" },
    });
    added.push(id);
  }

  return {
    roomId: room.id,
    title: room.title ?? title,
    created,
    added,
    participants: await listParticipants(client, room.id),
  };
}
