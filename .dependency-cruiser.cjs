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
      name: "web은 다른 런타임 패키지를 import하지 않는다",
      severity: "error",
      from: { path: "^packages/web/src" },
      to: { path: "^packages/(agent|e2e|server)/src" },
    },
    {
      name: "web core는 UI 프레임워크와 renderer를 모른다",
      severity: "error",
      from: { path: "^packages/web/src/(layout|projection|session|transport|windows)" },
      to: { path: "(^|node_modules/)(react|react-dom|@xterm)(/|$)" },
    },
    {
      name: "Dock과 Overview는 terminal renderer를 모른다",
      severity: "error",
      from: { path: "^packages/web/src/ui/chrome/(Dock|Overview)" },
      to: { path: "(^packages/web/src/terminal|(^|node_modules/)@xterm(/|$))" },
    },
    {
      name: "server source는 web source를 import하지 않는다",
      severity: "error",
      from: { path: "^packages/server/src" },
      to: { path: "^packages/web/src" },
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
