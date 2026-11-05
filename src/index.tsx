/* @refresh reload */
import { render } from 'solid-js/web';
import App from './App';
import { installInputModality } from './inputModality';
import { installTheme } from './state/theme';

installTheme();
installInputModality();

render(() => <App />, document.getElementById('root') as HTMLElement);
