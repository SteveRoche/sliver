/* @refresh reload */
import { render } from 'solid-js/web';
import { installInputModality } from './inputModality';
import { installTheme } from './state/theme';

installTheme();
installInputModality();

void import('./App').then(({ default: App }) =>
  render(() => <App />, document.getElementById('root') as HTMLElement),
);
