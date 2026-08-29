#!/usr/bin/env node
/**
 * build.mjs — 资产盘点 JSON → 自包含 HTML
 *
 *   node scripts/build.mjs <数据JSON路径> "<片名>"
 *   → Output/资产盘点-<片名>.html
 *
 * 从哪个 cwd 调都行：脚本用 import.meta.url 定位自身。
 *
 * ★ 校验常量与 templates/report-shell.html 里的同名常量必须逐字一致。
 *   自包含 HTML 无法 import，只能各存一份；改完跑 node scripts/check-sync.mjs。
 *
 * ★ 这个 skill 曾经走偏过一次，值得记下来：为了让出图"更真实"，
 *   我给每个场景写了上千字的规格（尺度到厘米、材分制、11 件带位置的道具表、
 *   前中后景清单、185 字的整体状况），并为每一项加了闸门。结果图越来越差 ——
 *   而 EV 用「一个中式庭院」五个字出的图比它们都好。
 *   原因：图像模型对"中式庭院"有极强先验（成千上万张园林照片，隐含几百样细节），
 *   穷举清单等于说"就这些，别的没有"，把先验压掉了；而尺寸材分制这类字
 *   图像模型根本渲不出来，纯占注意力预算。Lira anti-fail #2 早就写着：
 *   `past a point every extra clause dilutes attention and details drop out.
 *    Cut filler; keep anchors.`
 *   所以现在的定位是**资产盘点**：这个剧本有几个场景/角色/道具、几个变体、每场戏用哪个，
 *   描述只几句话。别再往回加字段。**这条对角色和道具一样成立** ——
 *   图像模型对"18 岁少年"和"一枚玉佩"的先验同样强，穷举五官比例只会更差。
 *
 * ★ 三类资产同住一份 JSON、同出一个页面，不是图省事，是因为
 *   `props[].refs` 要能被校验"你引用的那个 tag 确实存在" ——
 *   拆成三份数据源就没法拦「@char_xiaoming_xuesheng 写错一个字」。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = join(ROOT, 'templates', 'report-shell.html');
const OUTDIR = join(ROOT, 'Output');

/* ===== 校验常量（与 report-shell.html 同步） ===== */
/* ★ 这一条现在不只扫 brief：note 与 meta.worldview 也会被 checkPlaceholder() 扫到 ——
   起因是真实事故：写盘点时顺手把对话里截图的编号（"[Image #9]"）留进了 note，
   使用者拿到的产出脱离了那次对话，那句话谁也读不懂。 */
const PLACEHOLDER_RE = /\[(?![0-9]+\])[^\]]{0,80}\]|___|TODO|待填|占位/;
/* 下游词：机位/景别/光质/调色是 Lira 与 color-script 的活，写进需求描述会跟它们打架。
   三类资产通用 —— 角色的"肤色偏冷"、道具的"整体色调"一样越界。 */
const DOWNSTREAM = ['机位','景别','构图','焦段','景深','虚化','运镜','特写','远景','近景','中景','俯拍','仰拍',
  '光比','柔光','硬光','主光','补光','布光','光晕','颗粒','暗角','过曝',
  '饱和度','色相','色调','偏暖','偏冷','对比度','调色','影调'];
const BRIEF_MAX = 300;   // 需求描述字数上限。超了就是又在写规格书了
const HTML_RE = /<\/?(div|span|style|p|br|table|tr|td|b|i|em|strong)\b|style\s*=\s*["']|background\s*:|<script/i;

/* ===== 衍生变体的定义（三类通用） =====
 * 衍生变体 = **同一份资产**变化之后。判据永远是同一句：
 *   **主资产那个东西，在这个变体里还在画面里吗？**
 *
 * 场景：变机位（切到反打）· 变氛围（变成雨天）· 变状态（变成废墟）——
 *   主场景的墙、地、参照物还在那儿
 * 角色：只变状态（受伤破损、湿透、蒙尘）——
 *   **同一套衣服**还穿在身上，只是脏了破了
 * 道具：只变状态（碎裂、烧焦、褪色）——
 *   **同一件东西**还在画面里，只是坏了
 *
 * 之所以这么定，不是分类学，是**图生图有没有共同像素**：
 *   换机位 → 有（同一个空间）           ✓ 变体
 *   搬进另一个房间 → 没有               ✗ 另一份资产
 *   同一套衣服被撕破 → 有               ✓ 变体
 *   换一整套衣服 → 没有（脸在、衣服全变）✗ 另一份资产
 *   同一枚玉佩碎了 → 有                 ✓ 变体
 *   换成一枚仿制的玉佩 → 没有（是另一件物）✗ 另一份资产
 *
 * ★ 场景那条反面例子（踩过）：「慕容府·前庭」（露天庭院）挂了个变体
 *   「改成夜里，**视点移进正厅明间之内，庭院不入画**」——
 *   镜头进到另一个房间里去了，原来那个庭院一个像素都不剩。
 *   混进来的代价是双份的：使用者拿主视角图去做图生图编辑，两张图毫无共同像素，
 *   编辑必然失败；盘点上也会漏掉"正厅内"这个真实存在的场景。
 *   **盘点漏资产是这份表最严重的失败。**
 *
 * 下面三条只抓最露骨的写法。词表穷举不了 ——
 * 定义写在 references/ 下三份 how-to-write，动笔前自己过一遍。
 */
const RELOCATE_RE = /(视点|视角|镜头|机位)\s*(移进|移到|移入|挪进|挪到|换到|转到|进到)/;
/* 角色状态变体不许整套换装 —— 换衣服要另建一份服装资产（脸还在，但衣服一个像素都不剩） */
const OUTFIT_SWAP = ['另一套','另一身','换一套','换一身','整套换','换成另','改成另一'];
/* 道具状态变体不许换成另一件物 —— 仿制品/赝品是另一件东西，另建资产。
   注意只对**变体** brief 生效：主资产本身就是赝品是完全合法的。 */
const PROP_SWAP = ['另一件','另一枚','另一把','另一张','换一件','仿制','赝品','复制品','替代品'];

/* ===== 只写需求，不写"为什么有这个需求" =====
 * 描述是给图像模型画这个东西用的。剧情、场次统计、跨场景比较全都属于"为什么"：
 *   ✗「只用一场夜戏。全片最讲究那处民宅的正堂，勋戚人家该有的规格都在」
 *     —— 哪处民宅？什么规格？**离开上下文根本读不懂**，而且一句能画的都没有
 *   ✓「府第正厅之内，室内，夜里。梁栿粗壮、其上施着彩绘。板门闭合，只点厅内的烛」
 *
 * ★ 场次账目在表格第一列已经有了（场次号 + "15 场 · 2 变体"）。
 *   写进描述是重复，而且它总是牵出"这场戏演什么、谁在干什么"。
 */
/* ★ 场次号有两种写法，只认一种等于漏一半：`11-1`（剧本自带编号）与 `S01`（自己切的）。
   第一版只写了前者，而 fixture 恰好用后者 —— 用例没触发才发现。 */
const SCENE_ID_RE = /\d{1,3}\s*-\s*\d{1,2}|[Ss]\d{2,3}(?![0-9])/;
/* 场次统计（"两场戏"、"只用一场"、"十五场"）—— 账目在第一列，不进描述。
   (?!院) 放过「夯土场院」「备办空场」这类合法建筑词。 */
const SCENE_COUNT_RE = /第?[一二三四五六七八九十两百\d]{1,4}\s*场(?!院)/;
const PURPOSE_RE = /时用|那几场用|场用|时候用|都需要这个|才用/;
/* ★ 只管**场景**：场景资产图里不该出现人物，人物是下游每个镜头各自的事。
 *   角色资产图里当然要有人，道具（照片、油画）也可能正当地引用人 ——
 *   所以这一条按资产类型分派，绝不能一套扫全部。这是加角色/道具时最先撞上的冲突。 */
const PEOPLE = ['人物', '角色', '众人', '一群人', '两拨人', '过肩'];
/* ★ 每一格必须**脱离别的格单独读懂**。指向别处的说法一律不许：
 *   ✗「**同一处**府第正厅之内」—— 哪一处？那行的内容这格里没有
 *   ✗「**全片**最讲究的一处」—— 图像模型没看过全片
 *   ✓「皇室远亲府第的正厅之内」
 * 判据：把这一格单独拿出来给一个没看过这张表的人，他知道这是什么吗？
 * 注意"旁边一片备办空场"「比院内其他地方齐整」指的是**本资产内部**，合法。
 * 角色的服装格同理："比常服素净"是跨行比较（不许），"左袖比右袖磨得重"合法。 */
const CROSS_REF = ['同一处', '同一座', '同一个', '同上', '上述', '前述', '那处', '该处', '同前', '全片', '剧本'];
/* ===== 角色专有的两条 =====
 * ★ 角色资产图是**中性站姿的形象底板**，不是一个镜头。
 *   表情、情绪、姿势、动作是下游每个镜头各自的事（Lira 与 CINEDANCE 的活）——
 *   写进资产里，等于把一张只能用在一个瞬间的图当成全片的形象基准。 */
const EMOTION = ['表情','情绪','微笑','笑容','皱眉','愤怒','怒目','哭','泪','眼神','神情',
  '姿势','站姿','坐姿','手势','动作','面无表情'];
/* ★ 性格是评语，扩散模型渲不出来 —— 跟场景那边的"讲究/寒素"是同一类错误。
 *   要表达"这人不好惹"，写看得见的东西（下颌绷着、衣领扣到最上一颗），不写"高冷"。 */
const TRAIT = ['性格','温柔','善良','内向','开朗','精明','狡猾','正直','气质','高冷','傲气','看起来很'];
/* ===== 参照物：场景必须写，服装/道具不强制 =====
 * ★ 这条闸门原本同时管场景与服装，起因值钱：SKILL 里一直写着"参照物那一句别省"，
 *   却是全 skill **唯一一条被声明为必须、而完全没有闸门**的规则 —— 于是既没有强制、
 *   也没有检查。锚点的错误又是全表**唯一无法由单张图发现**的（症状是"两张图对不齐"，
 *   要出两张并排比才看得出来），所以最容易积累，当时给场景和服装都补了闸门。
 * ★ 后来把服装那一半撤掉了：服装 brief 本来就必写"一两处使用痕迹"，那处痕迹已经够
 *   跨镜头识别，再强制一句"哪一件配饰是参照物"是重复要求，容易逼出"那圈洗得发白
 *   的袖口是认得出的参照物"这类为了凑闸门而复述一遍的废句。三步推导方法仍留在
 *   references/how-to-write-character.md 里当最佳实践参考，只是不再是必须项。
 * 只查**场景**：它的锚点是**位置参照**，是跨镜头对齐的唯一依据，闸门缺口的代价最大。
 *   底档的锚点是脸上那处辨识点、道具的锚点是物件自身的特征，都不是位置参照，
 *   措辞也不该被强行统一，故不查（见 references/how-to-write-prop.md）。
 * ★ 闸门只能查"有没有写"。**位置对不对查不了** —— 那靠三步推导和汇报里点出存疑。 */
const ANCHOR_RE = /参照物/;

const errs = [];
const E = (path, msg, fix) => errs.push({ path, msg, fix });
const hit = (t, words) => { for (const w of words) if (String(t ?? '').includes(w)) return w; return null; };

/** 三类资产 + 全部变体共用的四条：场次号 / 场次统计 / 用途说明 / 跨行指代 */
function checkNoBackstory(text, path) {
  const t = String(text ?? '');
  const s = t.match(SCENE_ID_RE);
  if (s) E(path, `出现场次号「${s[0]}」`,
    '场次账目在 scenes 字段里，表格第一列会列出来 —— 描述里再写一遍是重复。' +
    '而且写场次号总会顺手带出"这场戏演什么、谁在干什么"，那些是**为什么有这个需求**，不是需求。');
  const n = t.match(SCENE_COUNT_RE);
  if (n) E(path, `出现场次统计「${n[0]}」`,
    '"两场戏"、"只用一场"、"全片戏最重的场景，十五场" —— 这些是账目不是画面，' +
    '第一列的场次列表与"N 场 · M 变体"已经说过了。写它总会顺手带出这几场戏演什么。');
  const p = t.match(PURPOSE_RE);
  if (p) E(path, `出现用途说明「${p[0]}」`,
    '「……时用」是在解释为什么要这一版。只写这一版长什么样，用在哪几场由 scenes 字段回答。');
  const x = hit(t, CROSS_REF);
  if (x) E(path, `出现跨行指代「${x}」`,
    '每一格必须脱离别的格单独读懂 —— "同一处府第"里的"同一处"指向另一行，' +
    '那行的内容这格里没有；"全片最讲究的一处"更是图像模型根本没有的上下文。' +
    '直接把这个东西是什么写出来（"皇室远亲府第的正厅之内"）。' +
    '指本资产内部的（"旁边一片空场"、"左袖比右袖磨得重"）不算。');
}

/** 占位符/会话引用 —— 单独拆出来，因为它不仅管 brief，note 与 meta.worldview 也要扫。
 *  note 会正当地出现场次号、跨行指代这些 checkNoBackstory 会拦的东西（去重依据本来就要
 *  讲"S03 说了同一句话"），所以不能对 note 套完整的 checkBriefBasics —— 只查这一条。 */
function checkPlaceholder(text, path) {
  const t = String(text ?? '');
  const m = t.match(PLACEHOLDER_RE);
  if (m) E(path, `残留占位符「${m[0]}」`,
    '补实值 —— 包括顺手留下的会话引用（"[Image #9]"这类插图编号、"如图所示"）。' +
    '产出要脱离当次对话也能读懂，使用者手上没有那张截图。');
}

/** 三类资产 + 全部变体共用的字数/占位符/下游词三条 */
function checkBriefBasics(text, path, { what = '需求描述' } = {}) {
  const t = String(text ?? '');
  checkPlaceholder(t, path);
  if (t.length > BRIEF_MAX)
    E(path, `${t.length} 字，超过 ${BRIEF_MAX}`,
      `${what}只要几句话。写长了会压掉图像模型自己的先验，图反而更差 —— ` +
      '实测「一个中式庭院」五个字比上千字的规格出图更好。' +
      '尺寸、材料清单、机位、光线一律不写，那些是 Lira 和图像模型的活。');
  const d = hit(t, DOWNSTREAM);
  if (d) E(path, `出现下游词「${d}」`,
    '机位/景别/光质/调色是 Lira 与 color-script 的活，写进来会跟它们的措辞打架。');
  checkNoBackstory(t, path);
}

/** 场景：参照物那一句不许省（它的锚点是位置参照，是跨镜头对齐的唯一依据） */
function checkAnchor(text, path, kind) {
  if (ANCHOR_RE.test(String(text ?? ''))) return;
  E(path, '没写参照物',
    `${kind}的锚点是**位置参照** —— 下游靠它写"站在哪、朝哪"（tie the staging to it），` +
    '没有它，位置类指令无处附着，同一处每次生成也对不齐（官方把环境漂移列为头号漂移源）。\n' +
    '    推导顺序不能反：① 读剧本的 Δ 动作行，看这场戏在哪一点上演 ② 那一点上本来会有' +
    '什么不可移动的东西（优先用已经写进 brief 的环境要素，别另外发明一件）' +
    '③ 过五条：不可移动 / 唯一 / 好认 / 画面里看得见 / 位置是这类东西本来就在的位置。\n' +
    '    写成"……是认得出的参照物"这种句式 —— 闸门认这三个字，人和下游也好一眼定位那一句。');
}

/** 角色专有：表情情绪动作 + 性格评语 */
function checkCharLane(text, path) {
  const t = String(text ?? '');
  const e = hit(t, EMOTION);
  if (e) E(path, `出现表情/姿态「${e}」`,
    '角色资产图是**中性站姿的形象底板**，不是一个镜头。表情、情绪、姿势、动作是' +
    '下游每个镜头各自的事 —— 写进资产等于把只能用在一个瞬间的图当成全片的形象基准。');
  const p = hit(t, TRAIT);
  if (p) E(path, `出现性格评语「${p}」`,
    '性格渲不出来，跟场景那边的"讲究/寒素"是同一类错误。' +
    '要表达"这人不好惹"，写看得见的东西（下颌绷着、衣领扣到最上一颗），不写"高冷"。');
}

/** 变体共用：tag 前缀 / name / scenes / brief 非空 */
function checkVariant(v, VP, parentTag, hint) {
  if (!v.tag || !String(v.tag).startsWith(parentTag + '_'))
    E(`${VP}.tag`, `变体标签「${v.tag ?? ''}」应以「${parentTag}_」开头`, '变体挂在本资产之下。');
  if (!v.name) E(`${VP}.name`, '缺变体名', hint);
  if (!Array.isArray(v.scenes) || !v.scenes.length)
    E(`${VP}.scenes`, '没登记场次', '这个变体服务剧本哪几场。');
  if (!v.brief || !String(v.brief).trim())
    E(`${VP}.brief`, '空', '一句话说清改什么。');
  else checkBriefBasics(v.brief, `${VP}.brief`, { what: '变体描述' });
  checkNoBackstory(v.name, `${VP}.name`);
}

/* ===== 参数 ===== */
const [jsonPath, titleArg] = process.argv.slice(2);
if (!jsonPath) { console.error('用法: node scripts/build.mjs <数据JSON路径> "<片名>"'); process.exit(2); }
if (!existsSync(jsonPath)) { console.error(`找不到数据文件: ${jsonPath}`); process.exit(2); }

let D;
try { D = JSON.parse(readFileSync(jsonPath, 'utf8')); }
catch (e) { console.error(`JSON 解析失败: ${e.message}`); process.exit(2); }

/* ===== JSON 里不许有 HTML / CSS ===== */
{
  const m = readFileSync(jsonPath, 'utf8').match(HTML_RE);
  if (m) E('(整份JSON)', `出现 HTML/CSS 片段「${m[0]}」`, '样式由外壳承担，JSON 只放数据。');
}

const LOCS  = Array.isArray(D.assets) ? D.assets : [];
const CHARS = Array.isArray(D.characters) ? D.characters : [];
const FITS  = Array.isArray(D.outfits) ? D.outfits : [];
const PROPS = Array.isArray(D.props) ? D.props : [];

/* ===== meta ===== */
const meta = D.meta ?? {};
for (const k of ['title', 'sceneCount', 'assetCount', 'variantCount', 'worldview'])
  if (meta[k] === undefined || meta[k] === '') E(`meta.${k}`, '缺失', '见 report-shell.html 顶部数据契约。');
if (meta.worldview !== undefined && meta.worldview !== '')
  checkPlaceholder(meta.worldview, 'meta.worldview');
if (!LOCS.length)
  E('assets', '没有任何场景', '空表说明剧本没读或场景没切。');
/* 角色/道具是可选的（纯场景盘点仍然合法）；但数组非空就必须报计数，好跟实际对账。
   ★ 变体计数只对**场景**做双记账（那是最容易写错的地方 —— 换空间那个坑）；
     角色/道具的状态变体默认没有、数量个位数，双记账的麻烦不抵收益，由 badge 直接算。 */
for (const [arr, key, label] of [[CHARS, 'charCount', '角色底档'], [FITS, 'outfitCount', '服装资产'], [PROPS, 'propCount', '关键道具']])
  if (arr.length && (meta[key] === undefined || meta[key] === ''))
    E(`meta.${key}`, `缺失 —— 有 ${arr.length} 份${label}却没报数`, '写成实际数，好跟表格对账。');

/* ===== tag 全局唯一 =====
 * ★ 一个 Map 管三类 + 全部变体。跨类重名也要拦：`@char_x` 与 `@prop_x` 各自合法，
 *   但 props[].refs 是按 tag 字符串解析的，重名会指到不确定的东西上。
 * tag 格式正则刻意**内联**、不提成 ALL_CAPS_RE 常量 —— check-sync 会要求外壳有一份
 * 同名常量，而标签格式属于"账目结构类"，按分工只该在 build.mjs 拦（外壳的 badge
 * 管"这份产出缺不缺东西"，不合格的账目结构根本生不出页面）。别好心把它提出去。 */
const tags = new Map();
const claim = (tag, path, re, shape) => {
  if (!tag || !re.test(String(tag)))
    E(`${path}.tag`, `标签「${tag ?? ''}」不合规`, `格式 ${shape}，全项目一套命名。`);
  else if (tags.has(tag)) E(`${path}.tag`, `标签与 ${tags.get(tag)} 重复`, '同一份资产只建一次，把场次登记到它的 scenes 里。');
  else tags.set(tag, path);
};

const locCovered = new Set();   // 场景覆盖的场次
const charCovered = new Set();  // 角色覆盖的场次
const propCovered = new Set();  // 道具覆盖的场次
let locVarN = 0, fitVarN = 0, propVarN = 0;

/* ===== 一、场景 ===== */
const basedOnRaw = [];   // {tag, basedOn, path} —— 全部场景 tag 收齐后再解析（跟 refUses 一个套路）
for (const [i, a] of LOCS.entries()) {
  const P = `assets[${i}]`;
  claim(a.tag, P, /^@loc_[a-z0-9_]+$/, '@loc_<小写英数下划线>');
  if (!a.name) E(`${P}.name`, '缺场景名', '');
  if (a.note !== undefined && a.note !== '') checkPlaceholder(a.note, `${P}.note`);
  if (a.basedOn !== undefined && a.basedOn !== '') {
    if (a.basedOn === a.tag)
      E(`${P}.basedOn`, '指向了自己', 'basedOn 是"这份场景衍生自哪个主区域"，不能指自己。');
    else
      basedOnRaw.push({ tag: a.tag, basedOn: a.basedOn, path: `${P}.basedOn` });
  }

  if (!Array.isArray(a.scenes) || !a.scenes.length)
    E(`${P}.scenes`, '没登记场次', '这份资产覆盖剧本哪几场 —— 盘点的意义就在这里。');
  else a.scenes.forEach(s => locCovered.add(s));

  if (!a.brief || !String(a.brief).trim())
    E(`${P}.brief`, '空', '几句话说清这个场景是什么、什么调性、哪件东西是认得出的参照物。');
  else {
    checkBriefBasics(a.brief, `${P}.brief`);
    checkAnchor(a.brief, `${P}.brief`, '场景');
    const h = hit(a.brief, PEOPLE);
    if (h) E(`${P}.brief`, `出现人物「${h}」`,
      '场景资产图里不该有人 —— 我们做的是空间，人物在 characters/outfits 那两张表里，' +
      '而某个镜头里谁在场是下游的事。' +
      '把人物动作换成它在空间上留下的东西（"被踩出一条发白的光带"而不是"日日有人出入"）。');
  }

  for (const [j, v] of (a.variants ?? []).entries()) {
    locVarN++;
    const VP = `${P}.variants[${j}]`;
    checkVariant(v, VP, a.tag, '例：夜景 / 雨天 / 反打视角。');
    (v.scenes ?? []).forEach(s => locCovered.add(s));
    const h = hit(v.brief, PEOPLE);
    if (h) E(`${VP}.brief`, `出现人物「${h}」`, '场景变体一样不该有人，只写这一版的空间长什么样。');
    // 衍生变体必须还是同一个空间。视点搬到别的房间里去了就不是变体，是另一个场景
    const m = String(v.brief ?? '').match(RELOCATE_RE);
    if (m) E(`${VP}.brief`, `出现「${m[0]}」—— 这是换了空间，不是衍生变体`,
      `衍生变体是**同一个场景**变化之后：换机位（切到反打）、换氛围（变成雨天）、` +
      `或被破坏（变成废墟）。主场景那个空间必须还在画面里。\n` +
      `    视点搬进另一个房间，原空间一个像素都不剩 —— 那是另一个场景，` +
      `该另建一份资产（新 tag、自己的 brief、把这个场次登记到它名下）。\n` +
      `    混着放的代价：使用者拿主视角图去做图生图编辑，两张图毫无共同像素，编辑必然失败；` +
      `盘点上也会漏掉这个真实存在的场景。\n` +
      `    如果只是同一空间里镜头往前挪了一点、主场景仍在画面里，换个说法（「切到…的视角」）。`);
  }
}

/* ===== assets[].basedOn —— 同一物理空间内的衍生区域 =====
 * ★ 跟 props[].refs 不是一回事：refs 是"身份引用"（画面上画着谁/哪儿，必须走参考生图
 *   保证是同一个人/同一处）；basedOn 是"风格引用"（同一栋房子里不同的房间/区域），
 *   参考生图只为保证风格/色调一致，不要求内容一致。
 * 只允许指到另一份场景的**主 tag**，不指变体 —— 变体是"这份资产变化之后"，
 * 要用哪个状态当风格参考该写进 note，不该靠 tag 精确到变体。 */
const locTagSet = new Set(LOCS.map(a => a.tag).filter(Boolean));
const basedOnOf = new Map();   // 子 tag -> 父（主区域）tag，只收合法的
for (const { tag, basedOn, path } of basedOnRaw) {
  if (!tag) continue;   // tag 本身不合规，claim() 已经报过，这里不重复报
  if (!locTagSet.has(basedOn)) {
    E(path, `引用的「${basedOn}」不是任何场景的主 tag`,
      'basedOn 只能指向 assets[] 里另一份场景的 tag（不是变体 tag，也不是角色/道具的 tag）。');
    continue;
  }
  basedOnOf.set(tag, basedOn);
}
/* 环检测：basedOn 链最终要走到一个不再 basedOn 别人的根，走不到（绕回自己）就是环。
 * 每个节点至多一条出边（functional graph），标准三色 DFS：GRAY = 在当前链路上，
 * 碰到 GRAY 就是环；BLACK = 已确认安全，不用重查。 */
{
  const GRAY = 1, BLACK = 2;
  const color = new Map();
  const visit = (tag, path) => {
    color.set(tag, GRAY);
    const parent = basedOnOf.get(tag);
    if (parent !== undefined) {
      const c = color.get(parent);
      if (c === GRAY) E('assets[].basedOn', `「${[...path, tag, parent].join(' → ')}」绕成了一个环`,
        'basedOn 链最终要落到一个不再 basedOn 别人的主区域 —— 不能几份场景互相指来指去绕成环。');
      else if (c === undefined) visit(parent, [...path, tag]);
    }
    color.set(tag, BLACK);
  };
  for (const tag of basedOnOf.keys()) if (!color.has(tag)) visit(tag, []);
}
/* 排序聚拢：同一条 basedOn 链（含它牵出的所有衍生场景）在 assets[] 里的下标必须连续，
 * 不能被别的场景插进来 —— 使用者要在表格里一眼看出"这几行是同一个家"。 */
{
  const tagIndex = new Map(); LOCS.forEach((a, i) => { if (a.tag) tagIndex.set(a.tag, i); });
  const findRoot = (tag) => {
    let t = tag; const seen = new Set();
    while (basedOnOf.has(t) && !seen.has(t)) { seen.add(t); t = basedOnOf.get(t); }
    return t;
  };
  const inFamily = new Set();
  basedOnOf.forEach((parent, child) => { inFamily.add(child); inFamily.add(parent); });
  const groups = new Map();   // 根 tag -> [下标...]
  for (const tag of inFamily) {
    const idx = tagIndex.get(tag);
    if (idx === undefined) continue;   // 拼错的 tag 前面已经报过 dangling，这里跳过
    const root = findRoot(tag);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(idx);
  }
  for (const [root, idxs] of groups) {
    if (idxs.length < 2) continue;
    const sorted = [...idxs].sort((x, y) => x - y);
    const min = sorted[0], max = sorted[sorted.length - 1];
    if (max - min + 1 !== idxs.length)
      E('assets[].basedOn', `「${root}」这一组衍生场景在 assets[] 里下标不连续（${sorted.join(',')}）`,
        '有 basedOn 关系的场景要在数组里排在一起，中间别插别的场景 —— ' +
        '使用者靠这个顺序在表格里找"这几行是同一个家"。调整这几份资产的先后顺序，把它们挪到相邻。');
  }
}

/* ===== 二、角色底档 =====
 * 底档只写**跨服装不变的那部分**：脸、年龄、身形、发型（不含发饰）。
 * 写一遍，所有服装资产引用它 —— 官方把 character drift 列在 environment invention
 * 之后的第二位，而每份服装各写一遍脸就是最直接的漂移来源。 */
const charTags = new Set();
for (const [i, c] of CHARS.entries()) {
  const P = `characters[${i}]`;
  claim(c.tag, P, /^@char_[a-z0-9_]+$/, '@char_<小写英数下划线>');
  if (c.tag) charTags.add(c.tag);
  if (!c.name) E(`${P}.name`, '缺角色名', '');
  if (c.note !== undefined && c.note !== '') checkPlaceholder(c.note, `${P}.note`);
  if (!c.brief || !String(c.brief).trim())
    E(`${P}.brief`, '空', '几句话写清脸、年龄、身形、发型 —— 只写跨服装不变的那部分。');
  else {
    checkBriefBasics(c.brief, `${P}.brief`, { what: '角色底档' });
    checkCharLane(c.brief, `${P}.brief`);
  }
  /* 底档不该有 scenes：它不是出图单元，出图单元是「角色 + 一套服装」。
     场次登记在服装资产上。 */
  if (Array.isArray(c.scenes) && c.scenes.length)
    E(`${P}.scenes`, '底档不登记场次', '底档不是出图单元 —— 光有一张脸出不了图，' +
      '出图单元是「角色 + 一套服装」。场次登记到 outfits[] 上。');
}

/* ===== 三、服装资产（出图单元） ===== */
const fitTags = new Set();
const fitsByChar = new Map();
for (const [i, f] of FITS.entries()) {
  const P = `outfits[${i}]`;
  claim(f.tag, P, /^@char_[a-z0-9_]+$/, '@char_<角色slug>_<服装slug>');
  if (f.tag) fitTags.add(f.tag);
  if (!f.name) E(`${P}.name`, '缺服装名', '例：小明 · 学生装。');
  if (f.note !== undefined && f.note !== '') checkPlaceholder(f.note, `${P}.note`);

  if (!f.char) {
    E(`${P}.char`, '没说这套服装属于哪个角色', 'char 填角色底档的 tag，例 "@char_xiaoming"。');
  } else if (!charTags.has(f.char)) {
    E(`${P}.char`, `引用的角色底档「${f.char}」不存在`,
      'characters[] 里没有这个 tag —— 要么拼错了，要么底档没建。' +
      '底档是脸的唯一权威版本，缺了它这套服装的脸就没人管。');
  } else {
    if (!fitsByChar.has(f.char)) fitsByChar.set(f.char, []);
    fitsByChar.get(f.char).push(f.tag);
    if (f.tag && !String(f.tag).startsWith(f.char + '_'))
      E(`${P}.tag`, `服装标签「${f.tag}」应以「${f.char}_」开头`,
        '服装挂在角色之下，标签体现从属关系（@char_xiaoming_xuesheng）。');
  }

  if (!Array.isArray(f.scenes) || !f.scenes.length)
    E(`${P}.scenes`, '没登记场次', '这套服装穿在剧本哪几场 —— 盘点的意义就在这里。');
  else f.scenes.forEach(s => charCovered.add(s));

  if (!f.brief || !String(f.brief).trim())
    E(`${P}.brief`, '空', '只写这一套衣服：形制、料子、几处使用痕迹。脸在底档里，别重复。');
  else {
    checkBriefBasics(f.brief, `${P}.brief`, { what: '服装描述' });
    checkCharLane(f.brief, `${P}.brief`);
  }

  for (const [j, v] of (f.variants ?? []).entries()) {
    fitVarN++;
    const VP = `${P}.variants[${j}]`;
    checkVariant(v, VP, f.tag, '例：受伤破损 / 湿透 / 蒙尘。');
    (v.scenes ?? []).forEach(s => charCovered.add(s));
    checkCharLane(v.brief, `${VP}.brief`);
    checkCharLane(v.name, `${VP}.name`);
    const s = hit(v.brief, OUTFIT_SWAP);
    if (s) E(`${VP}.brief`, `出现「${s}」—— 这是换了服装，不是状态变体`,
      `状态变体是**同一套衣服**变化之后：撕破、湿透、蒙尘、染血 —— 那套衣服还穿在身上。\n` +
      `    换一整套衣服，脸还在但衣服一个像素都不剩 —— 图生图没有可改的基础，必然失败。\n` +
      `    那是**另一份服装资产**：新 tag（@char_<角色>_<新服装>）、自己的 brief、` +
      `char 指向同一个底档、把这个场次登记到它名下。`);
  }
}
/* 底档必须至少挂一套服装 —— 光有一张脸出不了图，也没有场次可对账 */
for (const [i, c] of CHARS.entries())
  if (c.tag && charTags.has(c.tag) && !fitsByChar.has(c.tag))
    E(`characters[${i}]`, `底档「${c.tag}」没有任何服装资产`,
      '出图单元是「角色 + 一套服装」，光有底档出不了图，也没有场次可对账。' +
      '要么给它建至少一套服装（outfits[] 里 char 指向它），要么删掉这份底档。');

/* ===== 四、关键道具 =====
 * 只收**跨场景**的关键道具（定情信物、随身兵器、贯穿全片的信件）。
 * 理由与「一个中式庭院」同源：只有跨场景复用的东西才有漂移风险、才值得建资产锁。
 * 只用一次的道具交给图像模型的先验就行，列出来反而是在压先验。 */
const propTags = new Set();
const refUses = [];   // {ref, path} —— 全部 tag 收齐后再解析
for (const [i, p] of PROPS.entries()) {
  const P = `props[${i}]`;
  claim(p.tag, P, /^@prop_[a-z0-9_]+$/, '@prop_<小写英数下划线>');
  if (p.tag) propTags.add(p.tag);
  if (!p.name) E(`${P}.name`, '缺道具名', '');
  if (p.note !== undefined && p.note !== '') checkPlaceholder(p.note, `${P}.note`);

  if (!Array.isArray(p.scenes) || !p.scenes.length)
    E(`${P}.scenes`, '没登记场次', '这件道具出现在剧本哪几场。');
  else {
    p.scenes.forEach(s => propCovered.add(s));
    /* 只收跨场景的 —— 单场次的道具没有漂移风险，不值得建资产。
       变体的场次也算进来（主资产一场 + 变体一场 = 跨场景，合法）。 */
    const own = new Set(p.scenes);
    (p.variants ?? []).forEach(v => (v.scenes ?? []).forEach(s => own.add(s)));
    if (own.size < 2)
      E(`${P}.scenes`, `只覆盖 1 个场次 —— 不是跨场景道具`,
        '关键道具的判据是**跨场景**：只有跨场景复用的东西才有漂移风险、才值得建资产锁。' +
        '只出现一次的道具交给图像模型的先验就行 —— 列出来反而是在压先验' +
        '（跟给场景写上千字规格是同一个错）。删掉它，或者补上它真正出现的其他场次。');
  }

  if (!p.brief || !String(p.brief).trim())
    E(`${P}.brief`, '空', '几句话写清这是什么东西、什么料子什么工、哪一处细节最好认。');
  else checkBriefBasics(p.brief, `${P}.brief`, { what: '道具描述' });

  /* refs —— 道具上间接引用了别的资产的形象（照片、油画、绣像、建筑画）。
     有 refs 的道具必须走**参考生图**，而不是凭文字另画一遍。 */
  if (p.refs !== undefined) {
    if (!Array.isArray(p.refs))
      E(`${P}.refs`, 'refs 必须是数组', '例 ["@char_xiaoming_xuesheng"]。没有间接引用就整个省掉这个字段。');
    else p.refs.forEach((r, k) => refUses.push({ ref: r, path: `${P}.refs[${k}]` }));
  }

  for (const [j, v] of (p.variants ?? []).entries()) {
    propVarN++;
    const VP = `${P}.variants[${j}]`;
    checkVariant(v, VP, p.tag, '例：碎裂 / 烧焦 / 褪色。');
    (v.scenes ?? []).forEach(s => propCovered.add(s));
    const s = hit(v.brief, PROP_SWAP);
    if (s) E(`${VP}.brief`, `出现「${s}」—— 这是换成了另一件物，不是状态变体`,
      `状态变体是**同一件东西**变化之后：碎裂、烧焦、褪色、沾血 —— 那件东西还在画面里。\n` +
      `    仿制品、赝品、替代品是**另一件物**，跟原件毫无共同像素，图生图必然失败 ——` +
      `而剧情里真品赝品调换恰恰是最常见的桥段，混在一起就等于盘点漏了一件道具。\n` +
      `    另建一份资产（新 tag，比如 @prop_yupei_fake），把这个场次登记到它名下。`);
  }
}

/* ===== 五、refs 解析 =====
 * ★ refs 必须指到**服装级或场景级**，不能指到角色底档 ——
 *   照片上的小明穿的是哪套？指 @char_xiaoming，下游不知道拿哪张参考图。 */
for (const { ref, path } of refUses) {
  if (!ref || typeof ref !== 'string') { E(path, '空引用', '填一个已存在的 tag。'); continue; }
  if (charTags.has(ref) && !fitTags.has(ref)) {
    E(path, `引用指到了角色底档「${ref}」—— 粒度不够`,
      '底档只有脸，没有衣服 —— 照片上的这个人穿的是哪套？下游不知道该拿哪张参考图。' +
      `改成指向具体的服装资产（${(fitsByChar.get(ref) ?? []).join(' / ') || '先给这个角色建一套服装'}）。`);
    continue;
  }
  if (!tags.has(ref))
    E(path, `引用的「${ref}」不存在`,
      '这份 JSON 里没有这个 tag。refs 只能指向已建的服装资产、场景资产，或它们的变体 —— ' +
      '三类资产同住一份数据就是为了让这条能被校验到。拼错一个字，下游就会凭文字另画一遍，' +
      '而那正是"间接引用"最要避免的事。');
  else if (propTags.has(ref))
    E(path, `引用的「${ref}」是另一件道具`,
      'refs 是给"这件道具上画着某个角色/某个场景"用的。道具引道具没有参考生图的意义 —— ' +
      '如果确实是一件道具装在另一件里，那是两份独立资产，不用 refs。');
}

/* ===== 计数与覆盖自洽 —— 盘点的正确性全在这里 ===== */
if (meta.assetCount !== undefined && Number(meta.assetCount) !== LOCS.length)
  E('meta.assetCount', `写的是 ${meta.assetCount}，实际 ${LOCS.length}`, '改成实际数。');
if (meta.variantCount !== undefined && Number(meta.variantCount) !== locVarN)
  E('meta.variantCount', `写的是 ${meta.variantCount}，实际 ${locVarN}`, '改成实际数。');
if (meta.charCount !== undefined && Number(meta.charCount) !== CHARS.length)
  E('meta.charCount', `写的是 ${meta.charCount}，实际 ${CHARS.length}`, '改成实际数（角色底档数）。');
if (meta.outfitCount !== undefined && Number(meta.outfitCount) !== FITS.length)
  E('meta.outfitCount', `写的是 ${meta.outfitCount}，实际 ${FITS.length}`, '改成实际数（服装资产数）。');
if (meta.propCount !== undefined && Number(meta.propCount) !== PROPS.length)
  E('meta.propCount', `写的是 ${meta.propCount}，实际 ${PROPS.length}`, '改成实际数（关键道具数）。');

if (meta.sceneCount !== undefined && locCovered.size !== Number(meta.sceneCount))
  E('meta.sceneCount', `声明 ${meta.sceneCount} 场，实际覆盖 ${locCovered.size} 个场次号（场景表）`,
    '有场次没人管，或场次号写重了。漏掉的那场到时候没有场景可用 —— 这是盘点最要紧的一条。');

/* ★ 交叉对账：角色/道具登记的场次必须都在场景表里出现过。
 *   有一场戏有人有道具却没有地方，只有两种可能 —— 场景表漏了一场，或者场次号写错了。
 *   这一条只有在三类同住一份数据时才做得到。 */
{
  const orphan = [...new Set([...charCovered, ...propCovered])].filter(s => !locCovered.has(s));
  if (orphan.length)
    E('(交叉对账)', `场次 ${orphan.join(' ')} 在角色/道具表里出现，但场景表没有`,
      '有人有道具却没有地方 —— 要么场景表漏了这几场（那场到时候没有场景可用，' +
      '这是盘点最严重的失败），要么场次号写错了。两边核一遍。');
}

/* ===== 外壳完整 ===== */
if (!existsSync(SHELL)) { console.error(`外壳不见了: ${SHELL}`); process.exit(2); }
const shell = readFileSync(SHELL, 'utf8');
for (const need of ['{{DATA_JSON}}', '{{TITLE}}', 'id="badge"', 'id="tabs"', 'role="tablist"',
                    'id="tb"', 'id="tbc"', 'id="tbp"', 'SELFTEST'])
  if (!shell.includes(need)) E('templates/report-shell.html', `外壳缺少 ${need}`, '恢复它，不要手补。');

/* ===== 出结果 ===== */
if (errs.length) {
  console.error(`\n✗ 结构预检未通过（${errs.length} 项），已拒绝生成：\n`);
  for (const { path, msg, fix } of errs) {
    console.error(`  ${path}\n    问题：${msg}`);
    if (fix) console.error(`    改法：${fix}`);
    console.error('');
  }
  process.exit(1);
}

const title = titleArg || meta.title || '未命名';
mkdirSync(OUTDIR, { recursive: true });
const outFile = join(OUTDIR, `资产盘点-${title}.html`);
// 只需转义 </，避免 JSON 字符串提前闭合 <script>
const payload = JSON.stringify(D).replace(/<\//g, '<\\/');
const html = shell.replace('{{DATA_JSON}}', payload).replaceAll('{{TITLE}}', title);
for (const ph of ['{{DATA_JSON}}', '{{TITLE}}'])
  if (html.includes(ph)) {
    console.error(`✗ 注入后仍残留占位符 ${ph} —— 外壳里它出现了多次（replace 只换第一处）。`);
    process.exit(1);
  }
writeFileSync(outFile, html, 'utf8');

console.log(`✓ 已生成：${outFile}`);
console.log(`  场景 ${LOCS.length} + ${locVarN} 变体 · 角色 ${CHARS.length} 底档 / ${FITS.length} 套服装 + ${fitVarN} 状态 · 道具 ${PROPS.length} + ${propVarN} 状态`);
console.log(`  场景表覆盖场次 ${locCovered.size} · 角色表 ${charCovered.size} · 道具表 ${propCovered.size}`);
if (refUses.length) console.log(`  ⚑ ${refUses.length} 处间接引用 —— 这些道具必须走参考生图，被引用的图要先出`);
console.log(`\n自检截图用（直接 copy 这行）：`);
console.log(`P="file:///${outFile.replace(/\\/g, '/')}"`);
