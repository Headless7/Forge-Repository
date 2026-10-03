import { MyCalendarPage } from "@/components/schedule/my-calendar-page";

export const metadata = { title: "My calendar" };

/** The person's deadlines and milestones across the studio (the studio layout checks membership). */
export default function StudioCalendarPage() {
  return <MyCalendarPage />;
}
