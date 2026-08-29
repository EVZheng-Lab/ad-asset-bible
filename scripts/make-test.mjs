#!/usr/bin/env node
/**
 * make-test.mjs — 闸门验收工具（不是运行时的一部分）
 *
 *   node scripts/make-test.mjs
 *
 * 改了 build.mjs 的预检逻辑之后跑一次。它从 tests/fixtures/ok.json 派生违规样本，
 * 断言该被拒的都被拒了、而且报的是对应那一条。抓不住的闸门等于没有。
 *
 * ★ 这里的用例刻意很少。这个 skill 曾经有 30 个用例，因为当时每个场景要写上千字规格，
 *   每个字段都得有闸门守着。后来发现写得越多出图越差（图像模型对"中式庭院"这类
 *   有极强先验，穷举清单反而把它压掉），于是回到「资产盘点」这个定位：
 *   剧本有几个场景/角色/道具、几个变体、每场戏用哪个，描述只几句话。
 *   闸门跟着瘦下来是对的 —— **字段闸门**多了会把重字段逼回来。**别再往回加。**
 *
 * ★ 加角色与道具之后用例回到了 29 条，这不是那条纪律失效了。分清两种闸门：
 *   - **字段闸门**（"这个字段必须写、必须写到多细"）—— 会把描述逼成规格书，禁止扩张
 *   - **类型分派与交叉引用完整性**（PEOPLE 只管场景、refs 指到服装级、
 *     角色场次必须在场景表里）—— 一类资产变三类，这类检查必然变三倍
 *   新增的 11 条全是后者。往下再加之前，先分清自己要加的是哪一种。
 *
 * ★ 又加了两条：`note-chat-ref`（note 里留了会话截图引用）和 `no-worldview`
 *   （没写 meta.worldview）。两条也不是字段闸门 —— 前者管的是"产出不能依赖
 *   当次对话才能读懂"，后者管的是"第 0 步的结论必须落进产出、不能只留在聊天记录里"，
 *   都是结构完整性，不是逼着把描述写细。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'tests', 'fixtures');
const BUILD = join(ROOT, 'scripts', 'build.mjs');
const OK = JSON.parse(readFileSync(join(FIX, 'ok.json'), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(OK));

const CASES = [
  { name: 'placeholder', expect: '残留占位符',
    note: '描述里留了未填的占位符',
    mut: d => { d.assets[0].brief = '一座 1970 年代的砖混仓库，[尺寸待补]，东端一台地秤是参照物'; } },

  { name: 'note-chat-ref', expect: '残留占位符',
    note: 'note 里留了会话截图引用（"[Image #9]"）—— 产出脱离当次对话必须还能读懂',
    mut: d => { d.assets[0].note += '，见 [Image #9] 那张截图确认过'; } },

  { name: 'no-worldview', expect: 'meta.worldview',
    note: '没写世界观小结 —— 第 0 步的产出必须体现在页面上，不能只留在聊天记录里',
    mut: d => { delete d.meta.worldview; } },

  { name: 'brief-empty', expect: '空',
    note: '需求描述空着 —— 盘点的第二列没内容',
    mut: d => { d.assets[0].brief = ''; } },

  { name: 'brief-too-long', expect: '超过',
    note: '描述写成了规格书 —— 写长了会压掉图像模型的先验，图反而更差',
    mut: d => { d.assets[0].brief = '仓库'.repeat(200); } },

  { name: 'brief-downstream-word', expect: '下游词',
    note: '描述里写了机位/光质/调色 —— 那是 Lira 与 color-script 的活，会跟它们打架',
    mut: d => { d.assets[0].brief += '。用中景平拍，光比 2:1，整体色调偏冷'; } },

  { name: 'no-scenes', expect: '没登记场次',
    note: '场景没登记覆盖哪几场 —— 盘点的意义就在这里',
    mut: d => { d.assets[0].scenes = []; } },

  { name: 'coverage-mismatch', expect: '实际覆盖',
    note: '声明的场次数与实际覆盖不符 —— 有场戏没人管，到时候没有场景可用',
    mut: d => { d.meta.sceneCount = 12; } },

  { name: 'count-mismatch', expect: 'meta.assetCount',
    note: 'meta 计数与实际不符',
    mut: d => { d.meta.assetCount = 99; } },

  { name: 'dup-tag', expect: '重复',
    note: '同一地点建了两份，而不是登记进同一份的 scenes',
    mut: d => { d.assets[1].tag = d.assets[0].tag; } },

  { name: 'bad-tag-format', expect: '不合规',
    note: '标签不符合 @loc_ 命名惯例',
    mut: d => { d.assets[0].tag = 'Warehouse-1'; } },

  { name: 'variant-tag-orphan', expect: '应以',
    note: '变体标签没挂在本场景之下',
    mut: d => { d.assets[0].variants[0].tag = '@loc_somewhere_else'; } },

  { name: 'variant-no-brief', expect: '空',
    note: '变体没说改什么',
    mut: d => { d.assets[0].variants[0].brief = ''; } },

  { name: 'variant-no-scenes', expect: '没登记场次',
    note: '变体没登记服务哪几场',
    mut: d => { d.assets[0].variants[0].scenes = []; } },

  { name: 'html-in-json', expect: 'HTML/CSS',
    note: 'JSON 里写了 HTML —— 样式由外壳承担',
    mut: d => { d.assets[0].name = '<div style="color:red">仓库</div>'; } },

  { name: 'variant-relocated', expect: '换了空间，不是衍生变体',
    note: '变体把视点搬进了另一个房间 —— 原空间一个像素都不剩，那是另一个场景，不是变体',
    mut: d => { d.assets[0].variants[0].brief = '视点移进值班室之内，仓库不入画'; } },

  /* 「只写需求，不写为什么有这个需求」三条 */
  { name: 'brief-scene-id', expect: '出现场次号',
    note: '描述里写了场次号 —— 账目在第一列已有，而且写场次号总会顺手带出剧情',
    mut: d => { d.assets[0].brief += '。S01 是白天验货，S03 转到夜里'; } },

  { name: 'variant-purpose', expect: '出现用途说明',
    note: '变体在解释"为什么要这一版" —— 用在哪几场由 scenes 字段回答',
    mut: d => { d.assets[0].variants[0].brief += '，地秤特写那几场用'; } },

  { name: 'brief-cross-ref', expect: '出现跨行指代',
    note: '描述指向了别的行 —— 每一格必须脱离别的格单独读懂',
    mut: d => { d.assets[1].brief = '同一处仓库的值班室，内景。' + d.assets[1].brief; } },

  { name: 'variant-people', expect: '出现人物',
    note: '场景资产图里不该有人 —— 人物是下游每个镜头各自的事',
    mut: d => { d.assets[0].variants[0].brief += '，过肩看向站在秤边的两拨人'; } },

  /* ===== 角色 =====
   * ★ 第一条要守住的不是新闸门，是**旧闸门不能乱管**：PEOPLE 只扫场景。
   *   角色资产图里当然要有人 —— 这一条靠 ok.json 能通过来验（角色 brief 里全是人）。 */
  { name: 'char-emotion', expect: '出现表情/姿态',
    note: '角色资产图是中性站姿的形象底板，表情/姿势属于下游每个镜头',
    mut: d => { d.characters[0].brief += '眼神很沉，嘴角总绷着'; } },

  { name: 'char-trait', expect: '出现性格评语',
    note: '性格渲不出来 —— 跟场景那边写"讲究/寒素"是同一类错误',
    mut: d => { d.characters[0].brief += '气质冷硬，不好接近'; } },

  { name: 'char-base-no-outfit', expect: '没有任何服装资产',
    note: '出图单元是「角色 + 一套服装」—— 光有一张脸出不了图，也没有场次可对账',
    mut: d => { d.outfits = d.outfits.filter(f => f.char !== '@char_xiaomei');
                d.meta.outfitCount = d.outfits.length; } },

  { name: 'char-base-has-scenes', expect: '底档不登记场次',
    note: '把底档当成了出图单元 —— 场次该登记在服装资产上',
    mut: d => { d.characters[0].scenes = ['S01', 'S03']; } },

  { name: 'outfit-char-missing', expect: '引用的角色底档',
    note: '服装指向了一个不存在的底档 —— 这套衣服的脸就没人管了',
    mut: d => { d.outfits[0].char = '@char_nobody'; } },

  { name: 'outfit-variant-swap', expect: '换了服装，不是状态变体',
    note: '状态变体换了整套衣服 —— 脸还在但衣服一个像素都不剩，图生图没有可改的基础',
    mut: d => { d.outfits[0].variants[0].brief = '改成换一身干净的深色便服，头发也梳过'; } },

  /* ===== 道具 ===== */
  { name: 'prop-single-scene', expect: '不是跨场景道具',
    note: '只出现一次的道具没有漂移风险，列出来反而是在压模型的先验',
    mut: d => { d.props[0].scenes = ['S02']; } },

  { name: 'prop-variant-swap', expect: '换成了另一件物',
    note: '状态变体换成了仿制品 —— 那是另一件东西，而真假调换恰恰是最常见的桥段',
    mut: d => { d.props[1].variants[0].brief = '改成换一件仿制的铜钥匙，齿口做工略糙'; } },

  { name: 'refs-dangling', expect: '不存在',
    note: 'refs 拼错一个字，下游就会凭文字另画一遍 —— 那正是"间接引用"最要避免的事',
    mut: d => { d.props[0].refs = ['@char_along_xifu']; } },

  { name: 'refs-to-char-base', expect: '粒度不够',
    note: 'refs 指到了角色底档 —— 底档只有脸，照片上这人穿的是哪套？下游不知道拿哪张参考图',
    mut: d => { d.props[0].refs = ['@char_along']; } },

  /* ===== 参照物 =====
   * ★ 这一条守的是全 skill 唯一一条**曾经被声明为必须、却完全没有闸门**的规则。
   *   锚点的错误无法由单张图发现（症状是"两张图对不齐"），所以最容易积累。
   *   服装那半的强制闸门后来撤掉了（见 build.mjs ANCHOR_RE 注释），故这里只剩场景一条 ——
   *   outfit 的 brief 里写不写"参照物"不再是 make-test 要断言的事。 */
  { name: 'loc-no-anchor', expect: '没写参照物',
    note: '场景没给锚点 —— 下游写"站在哪、朝哪"就无处附着，同一处每次生成也对不齐',
    mut: d => { d.assets[0].brief = d.assets[0].brief.replace(/。东端那台[^。]*。$/, '。'); } },

  /* ===== 交叉对账（只有三类同住一份数据时才做得到） ===== */
  { name: 'xcover-orphan', expect: '但场景表没有',
    note: '有一场戏有人却没有地方 —— 场景表漏了一场，或者场次号写错了',
    mut: d => { d.outfits[0].scenes = ['S01', 'S09']; } },

  /* ===== 连续场景 basedOn（同一物理空间内的衍生区域） ===== */
  { name: 'basedon-self', expect: '指向了自己',
    note: 'basedOn 指向了自己的 tag —— 这不是"衍生自谁"，是循环引用自己',
    mut: d => { d.assets[0].basedOn = d.assets[0].tag; } },

  { name: 'basedon-dangling', expect: '不是任何场景的主 tag',
    note: 'basedOn 拼错或指向不存在的场景 —— 跟 refs 拼错一个字是同一类问题',
    mut: d => { d.assets[2].basedOn = '@loc_nowhere'; } },

  { name: 'basedon-cycle', expect: '绕成了一个环',
    note: '两份场景互相 basedOn 对方 —— 链最终要走到一个不再 basedOn 别人的根',
    mut: d => { d.assets[0].basedOn = d.assets[1].tag; } },

  { name: 'basedon-noncontiguous', expect: '下标不连续',
    note: '同一组衍生场景中间被插了一份不相干的场景 —— 使用者会找不到"这几行是同一个家"',
    mut: d => { d.assets = [d.assets[0], d.assets[2], d.assets[1]]; } },
];

mkdirSync(FIX, { recursive: true });
let fail = 0;
const run = (f, t) => spawnSync(process.execPath, [BUILD, f, t], { encoding: 'utf8' });

console.log('\n=== 应当被拒绝的样本 ===\n');
for (const c of CASES) {
  const d = clone(); c.mut(d);
  const f = join(FIX, `bad-${c.name}.json`);
  writeFileSync(f, JSON.stringify(d, null, 2), 'utf8');
  const r = run(f, `_selftest-bad-${c.name}`);
  const out = (r.stderr || '') + (r.stdout || '');
  if (r.status === 1 && out.includes(c.expect)) console.log(`  ✓ ${c.name.padEnd(22)} 被拦下，命中「${c.expect}」`);
  else {
    fail++;
    console.log(`  ✗ ${c.name.padEnd(22)} 期望被拦下并命中「${c.expect}」，实际 exit=${r.status}`);
    console.log(`      用例含义：${c.note}`);
    if (out.trim()) console.log(`      实际输出：${out.trim().split('\n').slice(0, 5).join(' / ')}`);
  }
}

console.log('\n=== 应当通过的样本 ===\n');
{
  const r = run(join(FIX, 'ok.json'), '_selftest-ok');
  if (r.status === 0) console.log('  ✓ ok                     通过（合规样本）');
  else {
    fail++;
    console.log('  ✗ ok                     本该通过却被拒了 —— 闸门误伤');
    console.log('      ' + (r.stderr || '').trim().split('\n').slice(0, 8).join('\n      '));
  }
}

const total = CASES.length + 1;
console.log(`\n${fail === 0 ? '✓ 全部通过' : `✗ ${fail} 项不符合预期`}（共 ${total} 项）`);
if (fail) console.log('\n抓不住的闸门等于没有 —— 修好 build.mjs 的对应预检再交付。');
process.exit(fail ? 1 : 0);
