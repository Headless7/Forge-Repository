/** Enum values shared by several tables. Kept free of imports so schema modules can't form init cycles. */
export const CARD_STATES = ["NOT_SUBMITTED", "IN_PROGRESS", "NEEDS_REVIEW", "CHANGES_REQUESTED", "APPROVED"] as const;
export const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export const PRODUCTION_STATUSES = ["TODO", "COMPLETED", "PUBLISHED"] as const;
export const DELIVERABLE_LINK_TYPES = ["DEPENDENCY", "ASSOCIATION"] as const;
