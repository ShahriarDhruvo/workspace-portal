import { redirect } from "next/navigation";

/** The Agents page became part of Updates; old links and bookmarks land there. */
export default function AgentsPage(): never {
  redirect("/admin/updates");
}
