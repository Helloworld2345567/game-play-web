import { render } from "preact";
import { App } from "./App";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#app");
if (root === null) throw new Error("Missing app root");
render(<App />, root);

