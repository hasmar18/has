import { $, initPage } from './common.js';
const boot = await initPage('/cenik');
const c = boot?.content || {};
if (c.pricelist_title) $('#t').textContent = c.pricelist_title;
const id = /^[0-9a-f-]{36}$/.test(c.pricelist_image || '') ? c.pricelist_image : '';
$('#pl').src = id ? `/media/${id}` : '/img/cenik.jpg';
