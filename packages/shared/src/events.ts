import { z } from "zod";
import {
  connectionStatusSchema,
  notificationEventSchema,
  skipReasonSchema,
  syncTriggerSchema,
} from "./finance";

const id = z.number().int().positive();
const count = z.number().int().nonnegative();

/** Payloads pushed to the panel over GET /api/events (one SSE event per member, named after `type`). */
export const serverEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("sync.started"),
    accountId: id,
    connectionId: id,
    trigger: syncTriggerSchema,
  }),
  z.object({ type: z.literal("sync.progress"), accountId: id, fetched: count }),
  z.object({
    type: z.literal("sync.finished"),
    accountId: id,
    connectionId: id,
    // Carried so a panel that connects mid-sync (and missed `sync.started`) still knows it.
    trigger: syncTriggerSchema,
    status: z.enum(["succeeded", "failed", "skipped"]),
    inserted: count,
    updated: count,
    removed: count,
    errorCode: z.string().nullable(),
    skipReason: skipReasonSchema.nullable(),
    retryAt: z.number().int().nullable(),
  }),
  z.object({
    type: z.literal("connection.updated"),
    connectionId: id,
    status: connectionStatusSchema,
  }),
  z.object({
    type: z.literal("notification.created"),
    id,
    event: notificationEventSchema,
  }),
  z.object({ type: z.literal("backup.finished"), status: z.enum(["succeeded", "failed"]) }),
  z.object({ type: z.literal("settings.updated") }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;
export type ServerEventType = ServerEvent["type"];

/** Every `type` literal of {@link ServerEvent}; the panel registers one listener per entry. */
export const SERVER_EVENT_TYPES = [
  "sync.started",
  "sync.progress",
  "sync.finished",
  "connection.updated",
  "notification.created",
  "backup.finished",
  "settings.updated",
] as const satisfies readonly ServerEventType[];
