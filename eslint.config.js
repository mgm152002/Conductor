import eslint from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'coverage/**',
      '.conductor/**',
      '.superpowers/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-control-regex': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
        varsIgnorePattern: '^_',
      }],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'src/preload/**/*.ts', 'test/ui/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/rules-of-hooks': 'error',
    },
  },
  {
    files: ['test/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // React Markdown invokes these lowercase renderer callbacks as components;
    // the Hooks rule cannot infer that contract from the object property names.
    files: ['src/renderer/components/chat/Markdown.tsx'],
    rules: {
      'react-hooks/rules-of-hooks': 'off',
    },
  },
);
