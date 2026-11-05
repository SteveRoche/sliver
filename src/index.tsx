/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import { installTheme } from "./state/theme";

installTheme();

render(() => <App />, document.getElementById("root") as HTMLElement);
