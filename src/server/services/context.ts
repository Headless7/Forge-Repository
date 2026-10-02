/** Who is performing a service call, plus request metadata for auditing. */
export interface Actor {
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
  /** Browser tab id, echoed on realtime events so the tab can ignore its own changes. */
  clientId?: string | null;
  sessionId?: string | null;
}
