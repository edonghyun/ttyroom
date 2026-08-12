module.exports = {
  forbidden: [
    {
      name: "domain은 바깥을 모른다",
      severity: "error",
      from: { path: "^packages/server/src/domain" },
      to: { path: "^packages/server/src/(usecases|adapters|ports)" },
    },
    {
      name: "usecases는 어댑터를 모른다",
      severity: "error",
      from: { path: "^packages/server/src/usecases" },
      to: { path: "^packages/server/src/adapters" },
    },
    {
      name: "순환 금지",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.base.json" },
  },
};
