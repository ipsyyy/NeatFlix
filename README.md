# NativeFrame

NativeFrame is an internal AI platform that helps an ad-supported streaming team identify, prototype, evaluate, and safely test contextual product-placement opportunities inside rights-cleared shows.

## Product source of truth

[`PRODUCT_SOURCE_OF_TRUTH.md`](./PRODUCT_SOURCE_OF_TRUTH.md) is the controlling specification for NativeFrame. It governs all product, scope, architecture, and implementation decisions. Any change that would conflict with it must be proposed and agreed by updating that document first, before implementation.

## Reference material

The `ad-responder` repository is reference material only. It may inform presentation and media patterns, but its source code must not be copied into NativeFrame, and neither may its styling, brand assets, or other protected material.

## Local development

Requirements: Node.js 20.9 or later, and npm.

```bash
# Install dependencies
npm install

# Start the development server at http://localhost:3000
npm run dev

# Lint
npm run lint

# Type-check
npm run typecheck

# Production build and serve
npm run build
npm run start
```

Secrets belong in local `.env*` files, which are git-ignored. Never commit them.
