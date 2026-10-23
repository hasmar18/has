import { $, initPage } from './common.js';
const key = document.querySelector('script[data-key]').dataset.key;
const boot = await initPage('');
if (boot && $('#text')) $('#text').textContent = boot.content[key] || '';
