import { permanentRedirect } from "next/navigation";

/** The bug tracker's first address; it now lives with the other forums at /f/bugs. */
export default async function LegacyBugsPage({ params, searchParams }: { params: Promise<{ studio: string; project: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { studio, project } = await params;
  const { bug } = await searchParams;
  const item = typeof bug === "string" && /^\d+$/.test(bug) ? `?item=${bug}` : "";
  permanentRedirect(`/${studio}/${project}/f/bugs${item}`);
}
