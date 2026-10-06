import { redirect } from "next/navigation";

// The side-track build has no landing page yet: the root opens the Integrations hub, which links the three pages.
export default function Home() {
  redirect("/integrations");
}
