#!/usr/bin/env node
/**
 * check-sync.mjs — 比对 templates/report-shell.html 与 scripts/build.mjs 里
 * 那几份「各存一份」的校验常量是否逐项一致。
 *
 * 为什么需要它：自包含 HTML 没法 import，校验常量只能在两边各写一遍。
 * 维护备注要求「改一处必须同步另一处」，但那条纪律靠人记是记不住的 ——
 * 这个脚本把它变成可执行的检查。改完常量跑一次。
 *
 * ★ 常量名是从 build.mjs **自动发现**的，不是硬编码列表。
 *   起因：加 USE_TRACE 时它只进了 build.mjs，而当时的硬编码列表里没有它，
 *   检查器自己也就瞎了——外壳 badge 少了一项检查却没人报警。
 *   自动发现之后，往 build.mjs 加任何 ALL_CAPS 常量数组，
 *   若外壳没有同名同内容的一份，这里立刻报错。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'templates', 'report-shell.html'), 'utf8');
const mjs  = readFileSync(join(ROOT, 'scripts', 'build.mjs'), 'utf8');

/* 从 build.mjs 自动发现所有 ALL_CAPS 常量数组。
   派生量（由其他常量 concat/spread 出来的，如 BASE_BAN / GEO_BAN）跳过 ——
   它们没有字面成员，比对源头即可。 */
const DERIVED = new Set(['BASE_BAN', 'GEO_BAN']);
function discover(src) {
  const out = [];
  const re = /const\s+([A-Z][A-Z0-9_]*)\s*=\s*\[/g;
  let m;
  while ((m = re.exec(src))) if (!DERIVED.has(m[1])) out.push(m[1]);
  return out;
}
const ARRAYS = discover(mjs);

/* 正则常量同样自动发现：build.mjs 里凡是 ALL_CAPS_RE = /…/ 的都要比对。
   ★ BUILD_ONLY 是有理由的例外，不是"懒得同步"的白名单 ——
     HTML_RE 扫的是**原始 JSON 文本**（防止 JSON 里混进 HTML/CSS），
     而外壳拿到的是 JSON.parse 之后的对象，根本没有原文可扫。
   往这里加东西之前先问：外壳**能不能**做这项检查？能就去外壳补，别加豁免。 */
const BUILD_ONLY = new Set(['HTML_RE']);
function discoverRe(src) {
  const out = [];
  const re = /const\s+([A-Z][A-Z0-9_]*_RE)\s*=\s*\//g;
  let m;
  while ((m = re.exec(src))) if (!BUILD_ONLY.has(m[1])) out.push(m[1]);
  return out;
}
const REGEXES = discoverRe(mjs);

function grabArray(src, name) {
  const re = new RegExp('(?:const|var)\\s+' + name + '\\s*=\\s*\\[([\\s\\S]*?)\\]');
  const m = src.match(re);
  if (!m) return null;
  return m[1].split(',')
    .map(s => s.trim().replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean);
}
function grabRegex(src, name) {
  const m = src.match(new RegExp(name + '\\s*=\\s*(\\/[\\s\\S]*?\\/[a-z]*)\\s*;'));
  return m ? m[1] : null;
}

let bad = 0;
console.log(`自动发现 build.mjs 里的常量数组 ${ARRAYS.length} 个：${ARRAYS.join(' ')}\n`);
for (const n of ARRAYS) {
  const a = grabArray(html, n), b = grabArray(mjs, n);
  if (!a) {
    console.log(`✗ ${n.padEnd(16)} build.mjs 有，**外壳没有** —— 外壳的 badge 会少一项检查`);
    bad++; continue;
  }
  const same = a.length === b.length && a.every((x, i) => x === b[i]);
  console.log(`${same ? '✓' : '✗'} ${n.padEnd(16)} html ${String(a.length).padStart(2)} 项 / mjs ${String(b.length).padStart(2)} 项${same ? ' 逐项一致' : ' 不一致'}`);
  if (!same) {
    bad++;
    const onlyA = a.filter(x => !b.includes(x)), onlyB = b.filter(x => !a.includes(x));
    if (onlyA.length) console.log(`   仅 html 有：${onlyA.join(' ')}`);
    if (onlyB.length) console.log(`   仅 mjs  有：${onlyB.join(' ')}`);
    if (!onlyA.length && !onlyB.length) {
      const pos = a.map((x, i) => x === b[i] ? null : i).filter(x => x !== null);
      console.log(`   成员相同但顺序不同，差异位：${pos.join(' ')}`);
    }
  }
}

/* 正则常量也逐条比对。★ 起因与数组那次一模一样：加 SCENE_ID_RE / PURPOSE_RE 时，
   这里只比对数组、外加一个**硬编码的 PLACEHOLDER_RE**，新加的两条正则又一次没人管。
   现在从 build.mjs 自动发现所有 ALL_CAPS_RE，外壳必须有同名同内容的一份。 */
console.log('');
for (const n of REGEXES) {
  const a = grabRegex(html, n), b = grabRegex(mjs, n);
  if (!a) {
    console.log(`✗ ${n.padEnd(16)} build.mjs 有，**外壳没有** —— 外壳的 badge 会少一项检查`);
    bad++; continue;
  }
  const same = a === b;
  console.log(`${same ? '✓' : '✗'} ${n.padEnd(16)}${same ? ' 一致' : ' 不一致'}`);
  if (!same) { bad++; console.log(`   html: ${a}\n   mjs : ${b}`); }
}

// 数据契约注释里是否列了所有必填字段。
// ★ 这些字段名是硬编码的，因为契约是给人读的注释、不是代码里的常量，抓不到。
//   加删必填字段时要同步改这里 —— 否则这条检查会变成空转的假绿（踩过：
//   BASE_FIELDS 被删之后 grabArray 返回 null，missing 恒为空，检查一直报绿）。
// ★ 带引号写（`"char"` 而不是 `char`），因为契约里每个字段都是 `"字段名":` 的形式，
//   而裸写的短名会被别的字段名**包含**掉：`char` 是 `charCount` 和 `characters`
//   的子串，裸写等于永真 —— 又一种空转的假绿。加新字段照这个格式写。
const REQUIRED = ['"assets"', '"tag"', '"name"', '"scenes"', '"brief"', '"variants"',
  '"characters"', '"outfits"', '"char"', '"props"', '"refs"', '"basedOn"',
  '"sceneCount"', '"assetCount"', '"variantCount"', '"charCount"', '"outfitCount"', '"propCount"',
  '"worldview"'];
const contract = html.slice(0, html.indexOf('<style>'));
if (!contract.includes('数据契约')) {
  console.log(`✗ ${'数据契约注释'.padEnd(14)} 外壳顶部找不到数据契约段 —— 恢复它`);
  bad++;
} else {
  const missing = REQUIRED.filter(f => !contract.includes(f));
  console.log(`${missing.length ? '✗' : '✓'} ${'数据契约注释'.padEnd(14)}${missing.length ? ` 缺字段：${missing.join(' ')}` : ` 已列出全部 ${REQUIRED.length} 个必填字段`}`);
  if (missing.length) bad++;
}

console.log(`\n${bad ? `✗ ${bad} 项不同步 —— 改一处必须同步另一处` : '✓ 两份常量与数据契约完全同步'}`);
process.exit(bad ? 1 : 0);
