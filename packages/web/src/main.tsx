import "@fontsource-variable/fira-code";
import "@fontsource-variable/inter";
import "@xterm/xterm/css/xterm.css";
import "./ui/theme.css";
import "./ui/app.css";

import { createWebApp } from "./app/create-web-app.js";

const root = document.querySelector<HTMLElement>("#root");

if (!root) {
  throw new Error("TTYRoom application root is missing");
}

createWebApp({ root, content: <main>TTYRoom</main> });
