import { z } from "zod";
import { notificationEventSchema } from "./finance";

/** Default and maximum page size of `GET /api/notifications`. */
export const NOTIFICATION_DEFAULT_LIMIT = 6;
export const NOTIFICATION_MAX_LIMIT = 50;

/**
 * Values the panel needs to build the notification text (bank name, number of days, ...).
 * They are shown in the panel only and never copied into an email.
 */
export const notificationParamsSchema = z.record(z.string(), z.union([z.string(), z.number()]));

export const notificationItemSchema = z.object({
  id: z.number().int().positive(),
  event: notificationEventSchema,
  params: notificationParamsSchema,
  /** A panel path such as `/accounts/12` or `/settings#backups`. */
  link: z.string().nullable(),
  createdAt: z.number().int(),
  readAt: z.number().int().nullable(),
});
export type NotificationItem = z.infer<typeof notificationItemSchema>;

export const notificationListQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^\d{1,3}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(NOTIFICATION_MAX_LIMIT))
    .optional(),
});
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

export const notificationListResponseSchema = z.object({
  items: z.array(notificationItemSchema),
  unread: z.number().int().nonnegative(),
});
export type NotificationListResponse = z.infer<typeof notificationListResponseSchema>;

export const testEmailResponseSchema = z.object({ sent: z.literal(true) });
export type TestEmailResponse = z.infer<typeof testEmailResponseSchema>;
