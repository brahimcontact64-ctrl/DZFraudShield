import { redirect } from "next/navigation";

export default function NetworkMonitoringPage() {
  redirect("/admin/health");
}
