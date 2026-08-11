// ESLint 9 flat config.
// The boundary rules below are the mechanical enforcement of the module
// dependency direction in Technical Design Document §2.1. Without them the
// modular monolith erodes in about six weeks. See docs/tech/tooling.md.

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'src/generated/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Everything here runs on Node — process, console, Buffer and friends exist.
  {
    languageOptions: {
      globals: { ...globals.node },
      ecmaVersion: 2023,
      sourceType: 'module',
    },
  },

  {
    files: ['**/*.ts'],
    plugins: { boundaries },
    settings: {
      // Required: we use NodeNext, so imports are written with a `.js`
      // specifier that resolves to a `.ts` file. Without the TypeScript
      // resolver, eslint-plugin-boundaries cannot resolve those imports, treats
      // them as external, and silently enforces nothing.
      'import/resolver': {
        typescript: { alwaysTryTypes: true, project: './tsconfig.json' },
      },
      'boundaries/include': ['src/**/*.ts'],
      // Order matters — the first matching element wins.
      //
      // `platform` is split into pure and I/O halves so that "pricing is pure"
      // is actually enforceable. Without the split, pricing could import
      // platform/db.ts and the linter would happily allow it.
      'boundaries/elements': [
        {
          type: 'platform-pure',
          mode: 'file',
          pattern: 'src/platform/(money|errors).ts',
        },
        { type: 'platform-io', mode: 'file', pattern: 'src/platform/*.ts' },
        { type: 'identity', mode: 'folder', pattern: 'src/identity' },
        { type: 'tenancy', mode: 'folder', pattern: 'src/tenancy' },
        { type: 'catalog', mode: 'folder', pattern: 'src/catalog' },
        { type: 'cart', mode: 'folder', pattern: 'src/cart' },
        { type: 'pricing', mode: 'folder', pattern: 'src/pricing' },
        { type: 'ordering', mode: 'folder', pattern: 'src/ordering' },
        { type: 'payments', mode: 'folder', pattern: 'src/payments' },
        { type: 'ledger', mode: 'folder', pattern: 'src/ledger' },
        { type: 'dispatch', mode: 'folder', pattern: 'src/dispatch' },
        { type: 'notify', mode: 'folder', pattern: 'src/notify' },
        { type: 'realtime', mode: 'folder', pattern: 'src/realtime' },
        { type: 'console', mode: 'folder', pattern: 'src/console' },
        { type: 'pos', mode: 'folder', pattern: 'src/pos' },
        { type: 'analytics', mode: 'folder', pattern: 'src/analytics' },
        { type: 'health', mode: 'folder', pattern: 'src/health' },
        { type: 'root', mode: 'file', pattern: 'src/*.ts' },
      ],
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            // The two halves of platform are leaves. platform-io may use the
            // pure half; the pure half depends on nothing at all.
            { from: 'platform-pure', allow: [] },
            { from: 'platform-io', allow: ['platform-pure', 'platform-io'] },

            // pricing is PURE (TDD §2.1): the money type and errors, nothing
            // else. No database, no clock, no network, no logger.
            // This is exactly what makes the fee arithmetic property-testable,
            // and it is why platform is split above.
            { from: 'pricing', allow: ['platform-pure'] },

            { from: 'identity', allow: ['platform-pure', 'platform-io'] },
            { from: 'tenancy', allow: ['platform-pure', 'platform-io', 'identity'] },
            { from: 'catalog', allow: ['platform-pure', 'platform-io', 'tenancy'] },
            { from: 'cart', allow: ['platform-pure', 'platform-io', 'catalog', 'tenancy'] },
            {
              from: 'ordering',
              // `identity` is an amendment to TDD §2.1, made deliberately: an
              // order command must declare the permission it requires, and the
              // permission vocabulary lives in identity. The alternative was a
              // bare string, which would let a command name a permission that
              // does not exist. No cycle — identity depends only on platform.
              allow: [
                'platform-pure',
                'platform-io',
                'pricing',
                'cart',
                'catalog',
                'tenancy',
                'identity',
              ],
            },
            {
              from: 'payments',
              allow: ['platform-pure', 'platform-io', 'pricing', 'ordering', 'tenancy'],
            },
            {
              from: 'ledger',
              allow: ['platform-pure', 'platform-io', 'pricing', 'ordering', 'payments'],
            },
            { from: 'dispatch', allow: ['platform-pure', 'platform-io', 'ordering', 'tenancy'] },
            { from: 'notify', allow: ['platform-pure', 'platform-io', 'ordering', 'tenancy'] },

            // realtime BROADCASTS ONLY. It may read ordering and nothing else.
            // A socket handler that needs to change state calls an ordering
            // command like any other caller (PRD principle 9).
            { from: 'realtime', allow: ['platform-pure', 'platform-io', 'ordering'] },

            {
              from: 'pos',
              allow: ['platform-pure', 'platform-io', 'catalog', 'ordering', 'dispatch'],
            },
            { from: 'analytics', allow: ['platform-pure', 'platform-io'] },
            { from: 'health', allow: ['platform-pure', 'platform-io'] },
            { from: 'console', allow: ['*'] },
            { from: 'root', allow: ['*'] },
          ],
        },
      ],

      // PRD PAY-MODE-02: no domain module imports a provider SDK directly.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['razorpay', 'cashfree*', 'payu*'],
              message:
                'Payment providers go behind the PaymentProvider interface. See docs/tech/backend.md.',
            },
          ],
        },
      ],

      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'warn',
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: true,
        },
      ],
      // Leading underscore means "deliberately discarded" — used when
      // destructuring a key out of an object to prove its absence.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/no-floating-promises': 'off',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // Tests and scripts are exempt from a few rules that only make sense in src.
  {
    files: ['**/*.test.ts', 'tests/**/*.ts', 'scripts/**/*.ts', 'scripts/**/*.js'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'boundaries/element-types': 'off',
    },
  },
);
