import tseslint from 'typescript-eslint'

export default tseslint.config(
  // `.probe` 是一次性产物目录（`.gitignore` 已忽略）：验证脚本把临时库、备份与探针放在那里。
  // 它不在版本控制里，也就不该参与门禁 —— 否则往 `.probe` 放一份带类型的备份，
  // 就会悄悄改变 lint 的检查范围与结果。
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.probe/**', '.worktrees/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
)
