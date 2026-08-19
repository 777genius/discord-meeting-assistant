import type { ActiveMeetingRoomReader } from "@discord-meeting/meeting-routing-core";

import type { ActiveCraigRecordingChannelReader } from "./craig-inbound-routes.js";

/** Keeps Craig wire vocabulary at the provider boundary. */
export class CraigRecordingConfigurationAdapter implements
  ActiveCraigRecordingChannelReader
{
  public constructor(private readonly rooms: ActiveMeetingRoomReader) {}

  public async listActiveGuildVoiceChannels() {
    return (await this.rooms.listActiveMeetingRooms()).map((room) => ({
      guildId: room.sourceId,
      voiceChannelId: room.roomId,
    }));
  }
}
