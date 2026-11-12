// 014 the second row of navigation, inside the administration area (specs/014 contracts/portal-ui.md "Screens").
// The screen a person is on is marked as the current page and is not a link; from one payment's screen, "Waiting"
// is a link back to the list.
import { Link } from "../../components/Link.js";

const ITEMS: Array<{ to: string; label: string; screen: string }> = [
  { to: "/admin", label: "Waiting", screen: "admin-waiting" },
  { to: "/admin/activity", label: "Activity", screen: "admin-activity" },
  { to: "/admin/ledger", label: "Ledger check", screen: "admin-ledger" },
];

export function AdminNav({ current }: { current: string }) {
  return (
    <nav aria-label="Administration" className="subnav">
      {ITEMS.map((item) =>
        item.screen === current ? (
          <span key={item.to} aria-current="page">
            {item.label}
          </span>
        ) : (
          <Link key={item.to} to={item.to}>
            {item.label}
          </Link>
        ),
      )}
    </nav>
  );
}
