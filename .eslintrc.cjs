module.exports = {
  root: true,
  env: {
    browser: true,
    es2021: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:import/recommended',
    'prettier',
  ],
  rules: {
    '@typescript-eslint/ban-ts-comment': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    'import/no-unresolved': 'off',
    'import/namespace': 'off',
    'import/default': 'off',
  },
  overrides: [
    {
      files: ['src/app.ts'],
      rules: {
        '@typescript-eslint/no-unused-vars': 'off',
        'prefer-const': 'off',
        'no-empty': 'off',
        'no-case-declarations': 'off',
        'no-inner-declarations': 'off',
        'no-useless-escape': 'off',
      },
    },
    {
      files: ['src/features/voice/**/*.ts'],
      rules: {
        'no-empty': 'off',
        'prefer-const': 'off',
        'no-useless-escape': 'off',
      },
    },
  ],
  settings: {
    'import/resolver': {
      node: {
        extensions: ['.js', '.ts', '.tsx'],
      },
    },
  },
};
