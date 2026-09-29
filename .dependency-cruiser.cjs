module.exports = {
  forbidden: [
    {
      name: "E2E는 서버와 Connector 내부 구현을 import하지 않는다",
      severity: "error",
      from: { path: "^e2e/src" },
      to: { path: "^(legacy/node-server|connector)/(src|dist)" },
    },
    {
      name: "domain은 바깥을 모른다",
      severity: "error",
      from: { path: "^legacy/node-server/src/domain" },
      to: { path: "^legacy/node-server/src/(usecases|adapters|ports)" },
    },
    {
      name: "usecases는 어댑터를 모른다",
      severity: "error",
      from: { path: "^legacy/node-server/src/usecases" },
      to: { path: "^legacy/node-server/src/adapters" },
    },
    {
      name: "web은 다른 런타임 패키지를 import하지 않는다",
      severity: "error",
      from: { path: "^web/src" },
      to: { path: "^(connector|e2e|legacy/node-server)/src" },
    },
    {
      name: "web core는 UI 프레임워크와 renderer를 모른다",
      severity: "error",
      from: { path: "^web/src/(layout|projection|session|transport|windows)" },
      to: { path: "(^|node_modules/)(react|react-dom|@xterm)(/|$)" },
    },
    {
      name: "Dock과 Overview는 terminal renderer를 모른다",
      severity: "error",
      from: { path: "^web/src/ui/chrome/(Dock|Overview)" },
      to: { path: "(^web/src/terminal|(^|node_modules/)@xterm(/|$))" },
    },
    {
      name: "server source는 web source를 import하지 않는다",
      severity: "error",
      from: { path: "^legacy/node-server/src" },
      to: { path: "^web/src" },
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
