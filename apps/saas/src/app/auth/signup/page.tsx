import { redirect } from "next/navigation";

export default function SignupPage() {
  // Account creation is only available through WooCommerce plugin
  // Dashboard is a management portal for existing merchants
  redirect("/auth/login");
}
