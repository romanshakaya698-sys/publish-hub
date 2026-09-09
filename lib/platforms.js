/**
 * 平台定义
 * publishUrl / 各类选择器均为「可覆盖配置」：
 * 实际运行时优先读取 data/settings.json 中的用户覆盖值，
 * 平台改版导致选择器失效时，改 settings.json 即可，无需改代码。
 */

const DEFAULTS = [
  {
    id: 'qq',
    name: '企鹅号',
    site: '腾讯内容开放平台',
    loginUrl: 'https://om.qq.com/userAuth/index',
    // 发文页地址（如失效，请在界面「平台设置」里更新为实际发文页 URL）
    publishUrl: 'https://om.qq.com/main/creation/article',
    // 内容管理列表页（用于跟进已发布稿件的审核状态）
    statusUrl: 'https://om.qq.com/main/management/articleManage',
    loginCheck: {
      loginUrlFragments: ['userAuth', 'login'],
      // 命中这些关键词视为「中间页/未通过审核」，脚本会停下来让你处理
      verifyKeywords: ['实名认证', '资质审核', '账号审核', '信用分', 'verify', 'certif', 'authStatus'],
    },
    selectors: {
      // 企鹅号实际：标题是一个 contenteditable span（.omui-inputautogrowing__inner）
      // 必须排在「正文 ProseMirror」之前，否则会先命中正文
      title: [
        '.omui-inputautogrowing__inner',
        '.omui-inputautogrowing__inner[contenteditable="true"]',
        'textarea[placeholder*="标题"]',
        'input[placeholder*="标题"]',
        'input[placeholder*="title"]',
        '.title-input textarea',
        '.article-title input',
        'input[name="title"]',
        '#title',
      ],
      content: [
        '.ProseMirror[contenteditable="true"]',
        '.ProseMirror.ExEditor-basic',
        '[contenteditable="true"]',
        'iframe#ueditor_0',
        'iframe',
      ],
      coverFileInput: ['input[type="file"]'],
      coverTrigger: ['button[class*="addCoverBtn"]', '.omui-button--add', '.cover-upload', '.add-cover', 'text=上传封面', 'text=选择封面'],
      publishBtn: [
        'button.omui-button--primary:has-text("发布")',
        '.publish-btn',
        'button:has-text("发布")',
        'a:has-text("发布")',
        '.btn-publish',
      ],
    },
    // 选该平台时需要额外补充的信息（会在发稿弹窗中动态展示，脚本尽量自动填）
    extraFields: [
      {
        key: 'category',
        label: '分类',
        type: 'select',
        placeholder: '请选择分类',
        options: [
          '科技', '互联网', '数码', '财经', '股票', '基金', '金融', '教育', '健康', '医疗',
          '养生', '时尚', '美食', '旅游', '汽车', '体育', '军事', '历史', '文化', '读书',
          '育儿', '母婴', '家居', '职场', '动漫', '游戏', '娱乐', '明星', '情感', '星座',
          '三农', '宠物', '摄影', '设计', '电影', '电视剧', '房产', '装修', '婚嫁', '心理',
          '法律', '其他',
        ],
        index: 0, // 第一个 .omui-suggestion__value
        selectors: ['input.omui-suggestion__value'],
        // 企鹅号下拉项是虚拟列表（.omui-suggestion__option），需滚动定位
        optionSelector: '.omui-suggestion__option',
        dropdownWrap: '.omui-suggestion__dropdown-wrap',
      },
      {
        key: 'tags',
        label: '标签',
        type: 'tags',
        placeholder: '最多9个标签，每个最多8个字，用空格或Enter键隔开',
        index: 1, // 第二个 .omui-suggestion__value
        selectors: ['input.omui-suggestion__value'],
      },
      {
        key: 'declaration',
        label: '自主声明',
        type: 'radio',
        placeholder: '请选择声明',
        options: [
          '无需标注',
          '该文章由AI生成',
          '该文章由AI辅助创作',
          '个人观点，仅供参考',
          '虚构演绎，仅供娱乐',
          '内容为转载',
          '内容包含营销广告信息',
          '健康医疗分享，仅供参考',
          '危险行为，请勿模仿',
          '事件时间地点可考证',
        ],
        triggerSelectors: [
          'button:has-text("添加内容自主声明")',
          'text=添加内容自主声明',
          'button:has-text("添加自主声明")',
          'a:has-text("添加自主声明")',
          '.add-declaration',
        ],
        // 企鹅号弹窗内单选项（omui-radio 或 label）
        radioSelector: '.omui-radio, .omui-radio-wrapper, .omui-radio-button-wrapper, .ant-radio-wrapper, .modal label, label',
        // 确认按钮
        confirmSelectors: [
          'button.omui-button--primary:has-text("确认")',
          'button:has-text("确认")',
          'button:has-text("确定")',
          '.modal .btn-primary',
        ],
      },
    ],
  },
  {
    id: 'zhihu',
    name: '知乎',
    site: '知乎创作者中心',
    loginUrl: 'https://www.zhihu.com/signin',
    publishUrl: 'https://zhuanlan.zhihu.com/write',
    loginCheck: {
      loginUrlFragments: ['signin', 'login'],
    },
    selectors: {
      // 标题：知乎是 textarea.Input（placeholder「请输入标题」）
      title: [
        'textarea.Input[placeholder*="标题"]',
        'textarea[placeholder*="标题"]',
        '.ArticleTitle textarea',
      ],
      // 正文：知乎是 Draft.js（public-DraftEditor-content），跟企鹅号 ProseMirror 同机制
      content: [
        '.public-DraftEditor-content[contenteditable="true"]',
        '.public-DraftEditor-content',
        '.DraftEditor-root [contenteditable="true"]',
        '[contenteditable="true"]',
      ],
      coverFileInput: ['input.UploadPicture-input', 'input[type="file"]'],
      coverTrigger: ['text=添加封面', 'text=上传封面', '.cover-upload'],
      publishBtn: [
        'button.Button--primary:has-text("发布")',
        'button:has-text("发布")',
        '.PublishButton',
        'button[type="submit"]',
      ],
      publishBtnText: ['发布'],
    },
  },
  {
    id: 'csdn',
    name: 'CSDN',
    site: 'CSDN 创作中心',
    loginUrl: 'https://passport.csdn.net/login',
    publishUrl: 'https://editor.csdn.net/md/',
    // CSDN 编辑器在 headless/隐私模式下会直接拒绝加载（提示「不支持浏览器隐私模式」），
    // 因此该平台只能走 confirm（有头）模式，不能走 auto（无头）模式。
    headlessUnsupported: true,
    // 内容模式：markdown 源码（CSDN 默认编辑器只接受 Markdown）。
    // 正文由 publisher.csdnFillContent 处理（HTML→Markdown 后填入源码 textarea）。
    contentMode: 'markdown',
    loginCheck: {
      loginUrlFragments: ['login', 'passport'],
    },
    selectors: {
      // 标题：CSDN 是 React 受控 input（aria-hidden 初始隐藏），
      // 用 locator.fill 不触发 onChange；由 publisher.fillCsdnTitle 用 native setter + input 事件写入。
      title: [
        'input.article-bar__title--input',
        'input.article-bar__title',
        'input[placeholder*="标题"]',
        '.article-bar__title input',
      ],
      // 正文：仅作辅助选择器，真正填充由 publisher.csdnFillContent 处理。
      // 注意不能写 iframe / 兜底 [contenteditable]，否则会误中右侧内置 AI 助手聊天 iframe。
      content: [
        'textarea.editor__inner',
        'pre.editor__inner[contenteditable="true"]',
      ],
      coverFileInput: ['input.cfw-file-input', 'input[type="file"]'],
      coverTrigger: ['text=上传图片', 'text=添加封面', '.cover-upload'],
      publishBtn: [
        'button.btn-publish:has-text("发布文章")',
        'button:has-text("发布文章")',
        'button:has-text("发布")',
        'button.btn-publish',
      ],
      publishBtnText: ['发布文章', '发布'],
    },
  },
  {
    id: 'dayu',
    name: '大鱼号',
    site: '大鱼号创作平台（UC/优酷）',
    loginUrl: 'https://mp.dayu.com/dashboard/contents',
    // 发文页（如失效可在界面「账号管理」里更新）
    publishUrl: 'https://mp.dayu.com/dashboard/article/write',
    // 内容管理列表页（跟进审核状态）
    statusUrl: 'https://mp.dayu.com/dashboard/contents',
    loginCheck: {
      // 大鱼号未登录会跳到 mp.dayu.com/?redirect_url=... 登录页（URL 无 login 字样），
      // 所以把 redirect_url 也算作「未登录」特征
      loginUrlFragments: ['login', 'passport', 'oauth', 'redirect_url'],
    },
    selectors: {
      // 大鱼号标题是普通 input#title（非 contenteditable）
      title: [
        'input#title',
        'input.article-write_box-title-input',
        'input[placeholder*="标题"]',
        'textarea[placeholder*="标题"]',
        '.title-input textarea',
      ],
      content: [
        // 大鱼号正文是 UEditor（iframe#ueditor_0）
        'iframe#ueditor_0',
        'iframe',
        '.ProseMirror[contenteditable="true"]',
        '[contenteditable="true"]',
      ],
      coverFileInput: ['input[type="file"]'],
      coverTrigger: [
        'div.article-write-article-cover-cover-item_set',
        'text=设置封面',
        'text=上传封面',
        'text=选择封面',
        '.cover-upload',
      ],
      // 大鱼号发布按钮文案是「发表」，主按钮 class 为 w-btn_primary
      publishBtn: [
        'button.w-btn_primary:has-text("发表")',
        'button:has-text("发表")',
        'button:has-text("发布")',
        '.btn-publish',
      ],
      publishBtnText: ['发表', '发布'],
    },
    // 大鱼号封面逻辑特殊：封面必须从「正文」里选图，且要选单封面/三封面模式。
    // 由 publisher.dayuCoverFlow 独立处理（不走企鹅号的上传封面通道）。
    coverMode: {
      type: 'inline-radio',
      label: '封面形式',
      options: ['单封面'],
      defaultValue: '单封面',
      // 「三封面」暂锁死不做，后续再设计开放
    },
    // 内容管理列表页的稿件卡片结构（状态抓取用）
    statusSelectors: {
      card: '.contents-publish-content_list_item',
      title: '.contents-publish-content_list_item_content_header h3',
      status: '.contents-publish-content_list_item_content_info_tag_status_box',
    },
    extraFields: [
      {
        // 大鱼号「信息来源」为页面上内联的 ant-design 单选组（非弹窗）
        key: 'source',
        label: '信息来源',
        type: 'inline-radio',
        defaultValue: '无需标注', // 不传时默认勾选「无需标注」，避免空着无法发表
        options: [
          '无需标注',
          'AI生成',
          '虚构演绎',
          '营销信息',
          '转载',
          '个人观点',
          '不适宜未成年人',
        ],
      },
    ],
  },
];

module.exports = { DEFAULT_PLATFORMS: DEFAULTS };
