import 'bootstrap-icons/font/bootstrap-icons.css';
import '@vscode/codicons/dist/codicon.css';
import './styles/theme.scss';

import { mount } from 'svelte';
import App from './App.svelte';
import { readBoot } from './rpc/bridge';
import { startThemeSync } from './theme-sync';

startThemeSync();

const target = document.getElementById('app');
if (target) mount(App, { target, props: { boot: readBoot() } });
