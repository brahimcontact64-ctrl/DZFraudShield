import { redirect } from "next/navigation";

export default function DeploymentChecklistPage() {
  redirect("/admin/health");
}
