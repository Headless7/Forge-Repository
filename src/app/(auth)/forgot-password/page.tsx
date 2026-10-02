import { ForgotPasswordForm } from "@/components/auth/auth-forms";
import { env } from "@/server/env";

export const metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm devOutbox={env.NODE_ENV !== "production" && !env.SMTP_URL} />;
}
