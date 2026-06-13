import { useEffect, useState } from "react";

export type Route =
  | { name: "inbox" }
  | { name: "board" }
  | { name: "task"; id: string };

function parse(hash: string): Route {
  const h = hash.replace(/^#/, "");
  if (h.startsWith("/task/")) return { name: "task", id: h.slice("/task/".length) };
  if (h === "/board") return { name: "board" };
  return { name: "inbox" };
}

/** Tiny hash router — avoids a routing dependency for three views. */
export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function navigate(to: string): void {
  window.location.hash = to;
}
