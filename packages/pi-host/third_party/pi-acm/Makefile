.PHONY: install test typecheck build publish patch minor major clean help

# ── Config ───────────────────────────────────────────────────────────────────

PACKAGE_NAME := $(shell node -p "require('./package.json').name" 2>/dev/null)
VERSION      := $(shell node -p "require('./package.json').version" 2>/dev/null)

# ── Default ──────────────────────────────────────────────────────────────────

help:
	@echo "pi-acm — $(PACKAGE_NAME) v$(VERSION)"
	@echo ""
	@echo "  make install     Install dependencies"
	@echo "  make test        Run tests"
	@echo "  make typecheck   Type-check TypeScript (no emit)"
	@echo "  make build       install + typecheck + test"
	@echo "  make patch       Bump patch version (0.1.0 → 0.1.1) and publish"
	@echo "  make minor       Bump minor version (0.1.0 → 0.2.0) and publish"
	@echo "  make major       Bump major version (0.1.0 → 1.0.0) and publish"
	@echo "  make publish     Publish current version to npm"
	@echo "  make clean       Remove node_modules"

# ── Core tasks ───────────────────────────────────────────────────────────────

install:
	bun install

test:
	bun test

typecheck:
	bunx tsc --noEmit --strict --skipLibCheck --moduleResolution bundler --module esnext \
		--target esnext --allowImportingTsExtensions \
		extensions/index.ts src/**/*.ts

build: install typecheck test
	@echo "✓ Build complete — $(PACKAGE_NAME) v$(VERSION)"

# ── Publishing ───────────────────────────────────────────────────────────────

publish: clean build
	bun publish --access public
	@echo "✓ Published $(PACKAGE_NAME) v$(VERSION)"

patch: clean build
	bun -e "const p=require('./package.json');const v=p.version.split('.');v[2]=+v[2]+1;p.version=v.join('.');require('fs').writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
	bun publish --access public
	@echo "✓ Published $(PACKAGE_NAME) v$(shell node -p "require('./package.json').version")"

minor: clean build
	bun -e "const p=require('./package.json');const v=p.version.split('.');v[1]=+v[1]+1;v[2]=0;p.version=v.join('.');require('fs').writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
	bun publish --access public
	@echo "✓ Published $(PACKAGE_NAME) v$(shell node -p "require('./package.json').version")"

major: clean build
	bun -e "const p=require('./package.json');const v=p.version.split('.');v[0]=+v[0]+1;v[1]=0;v[2]=0;p.version=v.join('.');require('fs').writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
	bun publish --access public
	@echo "✓ Published $(PACKAGE_NAME) v$(shell node -p "require('./package.json').version")"

# ── Cleanup ──────────────────────────────────────────────────────────────────

clean:
	rm -rf node_modules bun.lock
