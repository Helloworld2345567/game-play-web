import { render } from "preact";
import { App } from "./App";
import "./styles.css";
import { applyTheme, ThemeProvider, getInitialTheme } from "./theme";

const root = document.querySelector<HTMLDivElement>("#app");
if (root === null) throw new Error("Missing app root");
const initialTheme = getInitialTheme();
applyTheme(initialTheme);
render(
  <ThemeProvider>
    <App />
  </ThemeProvider>,
  root,
);
