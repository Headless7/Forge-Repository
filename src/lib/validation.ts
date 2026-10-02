/** Validation schemas shared by forms (client) and procedures (server). */
import { z } from "zod";
import { NOTIFICATION_TYPES } from "./notifications";
import { ROLES } from "./permissions";

export const idSchema = z.uuid("Invalid id.");
export const emailSchema = z.email("Enter a valid email address.").max(254);
export const passwordSchema = z
  .string()
  .min(8, "Use at least 8 characters.")
  .max(200, "That password is too long.");
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{2,24}$/, "2–24 characters: lowercase letters, numbers and underscores.");
export const displayNameSchema = z.string().trim().min(1, "Enter your name.").max(60, "Keep it under 60 characters.");
export const cardTitleSchema = z.string().trim().min(1, "Give the card a title.").max(200, "Titles are limited to 200 characters.");
export const columnNameSchema = z.string().trim().min(1, "Name the column.").max(60, "Column names are limited to 60 characters.");
export const projectNameSchema = z.string().trim().min(2, "Project names need at least 2 characters.").max(80);
export const studioNameSchema = z.string().trim().min(2, "Studio names need at least 2 characters.").max(60);
export const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Invalid colour.");
export const emojiSchema = z.string().trim().min(1).max(16);
export const isoDateSchema = z.iso.datetime({ offset: true });
export const roleSchema = z.enum(ROLES);
export const cardStateSchema = z.enum(["NOT_SUBMITTED", "IN_PROGRESS", "NEEDS_REVIEW", "CHANGES_REQUESTED", "APPROVED"]);
export const prioritySchema = z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]);
export const displayModeSchema = z.enum(["VISUAL", "COMPACT"]);
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);

export const signUpSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
  username: usernameSchema.optional(),
  inviteToken: z.string().max(200).optional(),
});

export const signInSchema = z.object({
  email: z.string().trim().min(1, "Enter your email.").max(254),
  password: z.string().min(1, "Enter your password.").max(200),
});

export const forgotPasswordSchema = z.object({ email: emailSchema });
export const resetPasswordSchema = z.object({ token: z.string().min(10).max(200), password: passwordSchema });

export const cardLinkSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().trim().max(80),
  url: z
    .url("Enter a valid link.")
    .max(2000)
    .refine((u) => /^https?:\/\//i.test(u), "Links must start with http:// or https://"),
});

export const annotationSchema = z.object({
  type: z.enum(["POINT", "REGION", "TIMESTAMP"]),
  x: z.number().min(0).max(1).nullable().optional(),
  y: z.number().min(0).max(1).nullable().optional(),
  width: z.number().min(0).max(1).nullable().optional(),
  height: z.number().min(0).max(1).nullable().optional(),
  timestampMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).nullable().optional(),
});
