// The web's API types now come from the shared @tq/contract package — the
// single source of truth across daemon, web, CLI, and the extension SDK.
// (Previously hand-written here; consolidated in the event-driven refactor.)
// @tq/contract is browser-pure (TypeBox only), so this pulls in no node/native
// deps.
export * from "@tq/contract";
