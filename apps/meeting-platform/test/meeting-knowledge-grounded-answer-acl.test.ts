import { describe, expect, it, vi } from "vitest";

import {
  MeetingKnowledgeGroundedAnswerAcl,
  type PublishedMeetingKnowledgeAnswerUseCase,
} from "../src/adapters/outbound/meeting-knowledge-grounded-answer-acl.js";

const request = {
  locale: "ru-RU",
  meetingId: "meeting-1",
  participantId: "participant-1",
  question: "Что решили?",
  roomId: "private-room-1",
} as const;

describe("MeetingKnowledgeGroundedAnswerAcl", () => {
  it("maps primitives and forwards the exact active-turn signal", async () => {
    const signal = new AbortController().signal;
    const execute = vi.fn<PublishedMeetingKnowledgeAnswerUseCase["execute"]>(async () => ({
      answer: {
        citations: [{ turnId: "turn-1" }],
        evidenceEpoch: "evidence-7",
        knowledgeEpoch: "knowledge-9",
        plainText: "Решили выпустить в пятницу.",
      },
      schemaVersion: 1,
      status: "answered",
    }));
    const recheckPlaybackAuthority = vi.fn<
      PublishedMeetingKnowledgeAnswerUseCase["recheckPlaybackAuthority"]
    >(async () => ({ schemaVersion: 1, status: "current" }));

    const acl = new MeetingKnowledgeGroundedAnswerAcl({
      execute,
      recheckPlaybackAuthority,
    });
    await expect(acl.answer(
      request,
      { signal },
    )).resolves.toEqual({
      ok: true,
      value: {
        citations: [{ turnId: "turn-1" }],
        evidenceEpoch: "evidence-7",
        knowledgeEpoch: "knowledge-9",
        plainText: "Решили выпустить в пятницу.",
        schemaVersion: 1,
        status: "answered",
      },
    });
    expect(execute).toHaveBeenCalledWith({
      activeParticipantId: "participant-1",
      locale: "ru-RU",
      meetingId: "meeting-1",
      question: "Что решили?",
      roomId: "private-room-1",
    }, { signal });
    await expect(acl.recheckPlaybackAuthority({
      citationTurnIds: ["turn-1"],
      evidenceEpoch: "evidence-7",
      knowledgeEpoch: "knowledge-9",
      request,
    }, { signal })).resolves.toEqual({ ok: true, value: "current" });
    expect(recheckPlaybackAuthority).toHaveBeenCalledWith({
      activeParticipantId: "participant-1",
      citationTurnIds: ["turn-1"],
      evidenceEpoch: "evidence-7",
      knowledgeEpoch: "knowledge-9",
      locale: "ru-RU",
      meetingId: "meeting-1",
      question: "Что решили?",
      roomId: "private-room-1",
    }, { signal });
  });

  it("fails closed for provider-shaped extras or cancellation", async () => {
    const execute = vi.fn<PublishedMeetingKnowledgeAnswerUseCase["execute"]>(async () => ({
      answer: {
        citations: [{ turnId: "turn-1", vectorScore: 0.99 }],
        evidenceEpoch: "evidence-7",
        knowledgeEpoch: "knowledge-9",
        plainText: "unsafe",
      },
      schemaVersion: 1,
      status: "answered",
    }));
    const acl = new MeetingKnowledgeGroundedAnswerAcl({
      execute,
      recheckPlaybackAuthority: async () => ({ schemaVersion: 1, status: "stale" }),
    });
    await expect(acl.answer(request, { signal: new AbortController().signal }))
      .resolves.toMatchObject({ failure: { code: "GROUNDED_ANSWER_REJECTED" }, ok: false });

    const controller = new AbortController();
    controller.abort();
    await expect(acl.answer(request, { signal: controller.signal }))
      .resolves.toMatchObject({ failure: { code: "GROUNDED_ANSWER_CANCELLED" }, ok: false });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
