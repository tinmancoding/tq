.PHONY: install update uninstall

install:
	pnpm install
	pnpm build:web
	node scripts/setup.mjs

update:
	pnpm install
	pnpm build:web
	node scripts/restart.mjs

uninstall:
	node scripts/uninstall.mjs
