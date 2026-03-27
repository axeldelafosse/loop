import {
  appendBridgeMessage,
  type BridgeMessage,
  markBridgeMessage,
  readBridgeInbox,
  readBridgeStatus,
  readPendingBridgeMessages,
} from "./bridge-store";
import type { Agent } from "./types";

export interface DeliveryResult {
  entry: BridgeMessage;
  status: "accepted" | "delivered" | "queued";
  target: Agent;
}

export type ImmediateBridgeDelivery = (
  entry: BridgeMessage
) => Promise<boolean>;
export type AcceptedBridgeDelivery = () => boolean;

export const bridgeChatId = (runDir: string): string => {
  const runId = readBridgeStatus(runDir).runId || "bridge";
  return `codex_${runId}`;
};

export const isActiveBridgeChatId = (runDir: string, chatId: string): boolean =>
  chatId === bridgeChatId(runDir);

export const acknowledgeBridgeDelivery = (
  runDir: string,
  message: BridgeMessage,
  reason?: string
): void => {
  markBridgeMessage(runDir, message, "delivered", reason);
};

export const consumeBridgeInbox = (
  runDir: string,
  target: Agent,
  reason: string
): BridgeMessage[] => {
  const messages = readBridgeInbox(runDir, target);
  for (const message of messages) {
    acknowledgeBridgeDelivery(runDir, message, reason);
  }
  return messages;
};

export const readNextPendingBridgeMessage = (
  runDir: string
): BridgeMessage | undefined => readPendingBridgeMessages(runDir)[0];

export const readNextPendingBridgeMessageForTarget = (
  runDir: string,
  target: Agent
): BridgeMessage | undefined =>
  readPendingBridgeMessages(runDir).find((entry) => entry.target === target);

export const dispatchBridgeMessage = async (
  runDir: string,
  source: Agent,
  target: Agent,
  message: string,
  deliver?: ImmediateBridgeDelivery,
  acceptsDelivery?: AcceptedBridgeDelivery
): Promise<DeliveryResult> => {
  const entry = appendBridgeMessage(runDir, source, target, message);
  const delivered = deliver ? await deliver(entry) : false;
  let status: DeliveryResult["status"] = "queued";
  if (delivered) {
    status = "delivered";
  } else if (acceptsDelivery?.()) {
    status = "accepted";
  }
  return { entry, status, target };
};

export const formatDispatchResult = ({
  entry,
  status,
  target,
}: DeliveryResult): string => {
  switch (status) {
    case "delivered":
      return `delivered ${entry.id} to ${target}`;
    case "accepted":
      return `accepted ${entry.id} for codex delivery`;
    default:
      return `queued ${entry.id} for ${target}`;
  }
};
