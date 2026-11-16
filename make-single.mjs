// Builds giwajang.html: dist/index.html with JS+CSS inlined.
// Replacer functions are used so $-patterns in the bundle are not expanded.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
let html = readFileSync('dist/index.html', 'utf8');
const assets = readdirSync('dist/assets');
const jsFile = assets.find((f) => f.endsWith('.js') && f.startsWith('index'));
const cssFile = assets.find((f) => f.endsWith('.css'));
const js = readFileSync('dist/assets/' + jsFile, 'utf8').replace(/<\/script/g, '<\\/script');
const css = readFileSync('dist/assets/' + cssFile, 'utf8').replace(/<\/style/g, '<\\/style');
html = html.replace(/<link rel="stylesheet"[^>]*>/, () => '<style>' + css + '</style>');
html = html.replace(/<script type="module"[^>]*src="[^"]*"[^>]*><\/script>/, () => '<script type="module">' + js + '</script>');
if (html.includes('src="/assets/') || html.includes('href="/assets/')) throw new Error('external asset reference remains');
writeFileSync('giwajang.html', html);
console.log('single-file OK:', (html.length / 1024).toFixed(0), 'kB');
