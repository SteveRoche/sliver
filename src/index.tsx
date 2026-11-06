/* @refresh reload */
// The compiler worker starts first: its WebAssembly (the slowest part of
// startup) compiles while the rest of the app loads, which is split off
// below (`import('./App')`).
import './typst/instance';
import { render } from 'solid-js/web';
import { installInputModality } from './inputModality';
import { installTheme } from './state/theme';

installTheme();
installInputModality();

void import('./App').then(({ default: App }) =>
  render(() => <App />, document.getElementById('root') as HTMLElement),
);
