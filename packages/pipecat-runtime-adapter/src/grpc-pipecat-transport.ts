import { fileURLToPath } from "node:url";

import {
  Client,
  credentials,
  loadPackageDefinition,
  Metadata,
  type ServiceClientConstructor,
  type ServiceError,
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";

import type {
  ConversationDuplexCall,
  ConversationDuplexCallFactory,
  GrpcPipecatConversationRuntimeOptions,
  RawMessage,
} from "./grpc-pipecat-types.js";

interface ConversationRuntimeClient extends Client {
  checkHealth(
    request: RawMessage,
    metadata: Metadata,
    callback: (error: ServiceError | null, response: RawMessage) => void,
  ): unknown;
  converse(metadata: Metadata): ConversationDuplexCall;
}

export function createAuthorizationMetadata(serviceToken: string): Metadata {
  const metadata = new Metadata();
  metadata.set("authorization", `Bearer ${serviceToken}`);
  return metadata;
}

export function createGrpcConversationDuplexCallFactory(
  options: GrpcPipecatConversationRuntimeOptions,
): ConversationDuplexCallFactory {
  const protoPath = options.protoPath ?? fileURLToPath(
    import.meta.resolve(
      "@discord-meeting/conversation-runtime-contracts/proto/conversation_runtime.proto",
    ),
  );
  const definition = loadSync(protoPath, {
    defaults: true,
    enums: String,
    keepCase: false,
    longs: String,
    oneofs: true,
  });
  const service = readConversationRuntimeService(loadPackageDefinition(definition));
  const client = createConversationRuntimeClient(service, options.address);

  return {
    checkHealth(metadata): Promise<RawMessage> {
      return new Promise((resolve, reject) => {
        client.checkHealth(
          { service: "discord-meeting-conversation-runtime-v1" },
          metadata,
          (error, response) => {
            if (error === null) {
              resolve(response);
            } else {
              reject(error);
            }
          },
        );
      });
    },
    create(metadata): ConversationDuplexCall {
      return client.converse(metadata);
    },
    close(): void {
      client.close();
    },
  };
}

function readConversationRuntimeService(root: unknown): ServiceClientConstructor {
  const rootRecord = recordValue(root, "protobuf root");
  const discordMeeting = recordValue(rootRecord.discord_meeting, "discord_meeting");
  const runtime = recordValue(discordMeeting.conversation_runtime, "conversation_runtime");
  const version = recordValue(runtime.v1, "conversation_runtime.v1");
  const service = version.ConversationRuntimeService;
  if (!isServiceClientConstructor(service)) {
    throw new Error("ConversationRuntimeService is missing from protobuf definition");
  }
  return service;
}

function createConversationRuntimeClient(
  service: ServiceClientConstructor,
  address: string,
): ConversationRuntimeClient {
  const candidate: unknown = new service(address, credentials.createInsecure());
  if (!isConversationRuntimeClient(candidate)) {
    throw new Error("ConversationRuntimeService does not expose the expected gRPC methods");
  }
  return candidate;
}

function isServiceClientConstructor(value: unknown): value is ServiceClientConstructor {
  return typeof value === "function";
}

function isConversationRuntimeClient(value: unknown): value is ConversationRuntimeClient {
  return (
    value instanceof Client &&
    typeof Reflect.get(value, "checkHealth") === "function" &&
    typeof Reflect.get(value, "converse") === "function"
  );
}

function recordValue(value: unknown, field: string): RawMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const record: RawMessage = {};
  for (const [key, entry] of Object.entries(value)) {
    record[key] = entry;
  }
  return record;
}
