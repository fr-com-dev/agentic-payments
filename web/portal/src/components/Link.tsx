// A link inside the app: a real anchor (so it can be opened in a new tab and read by assistive technology) that
// navigates without a page load on a plain click.
import type { MouseEvent, ReactNode } from "react";
import { useApp } from "../context.js";

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  const { navigate } = useApp();
  const onClick = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} className={className} onClick={onClick}>
      {children}
    </a>
  );
}
