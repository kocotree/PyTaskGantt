// AntD 企业风主题 token (覆盖到 NaiveUI ThemeOverrides)

export const antdLikeTheme = {
  common: {
    primaryColor: '#1677ff',
    primaryColorHover: '#4096ff',
    primaryColorPressed: '#0958d9',
    primaryColorSuppl: '#1677ff',
    successColor: '#52c41a',
    successColorHover: '#73d13d',
    successColorPressed: '#389e0d',
    successColorSuppl: '#52c41a',
    warningColor: '#faad14',
    warningColorHover: '#ffc53d',
    warningColorPressed: '#d48806',
    warningColorSuppl: '#faad14',
    errorColor: '#ff4d4f',
    errorColorHover: '#ff7875',
    errorColorPressed: '#d9363e',
    errorColorSuppl: '#ff4d4f',
    infoColor: '#1677ff',
    bodyColor: '#fafafa',
    cardColor: '#ffffff',
    modalColor: '#ffffff',
    popoverColor: '#ffffff',
    tableColor: '#ffffff',
    borderColor: '#e8e8e8',
    dividerColor: '#f0f0f0',
    textColorBase: 'rgba(0, 0, 0, 0.88)',
    textColor1: 'rgba(0, 0, 0, 0.88)',
    textColor2: 'rgba(0, 0, 0, 0.65)',
    textColor3: 'rgba(0, 0, 0, 0.45)',
    textColorDisabled: 'rgba(0, 0, 0, 0.25)',
    placeholderColor: 'rgba(0, 0, 0, 0.45)',
    iconColor: 'rgba(0, 0, 0, 0.45)',
    borderRadius: '8px',
    borderRadiusSmall: '6px',
    fontFamily:
      '"PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontFamilyMono:
      '"SF Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, monospace',
    fontSize: '14px',
    fontSizeSmall: '12px',
    fontSizeMedium: '14px',
    fontSizeLarge: '16px',
    heightSmall: '28px',
    heightMedium: '32px',
    heightLarge: '40px',
    boxShadow1: '0 1px 2px rgba(0, 0, 0, 0.04), 0 1px 6px -1px rgba(0, 0, 0, 0.02), 0 2px 4px rgba(0, 0, 0, 0.02)',
    boxShadow2: '0 6px 16px 0 rgba(0, 0, 0, 0.08), 0 3px 6px -4px rgba(0, 0, 0, 0.12), 0 9px 28px 8px rgba(0, 0, 0, 0.05)',
  },
  Button: {
    borderRadiusMedium: '6px',
    fontWeight: '400',
    fontWeightStrong: '500',
    heightSmall: '28px',
  },
  Card: {
    borderRadius: '8px',
    paddingMedium: '16px 20px',
    paddingSmall: '12px 16px',
    titleFontSizeMedium: '15px',
    titleFontWeight: '600',
    borderColor: '#f0f0f0',
  },
  Input: {
    borderRadius: '6px',
  },
  DataTable: {
    thColor: '#fafafa',
    thColorHover: '#f0f0f0',
    thTextColor: 'rgba(0, 0, 0, 0.88)',
    thFontWeight: '600',
    tdColorHover: '#f0f7ff',
    tdColorStriped: '#fafafa',
    borderColor: '#f0f0f0',
    thPaddingMedium: '8px 12px',
    tdPaddingMedium: '8px 12px',
    thPaddingSmall: '6px 10px',
    tdPaddingSmall: '6px 10px',
  },
  Tag: {
    borderRadius: '4px',
    fontWeightStrong: '500',
    heightSmall: '20px',
    fontSizeSmall: '12px',
  },
  Modal: {
    peers: {
      Card: {
        borderRadius: '8px',
      },
    },
  },
  Divider: {
    color: '#f0f0f0',
  },
  Statistic: {
    valueFontSize: '20px',
    labelFontSize: '12px',
    labelTextColor: 'rgba(0, 0, 0, 0.45)',
  },
  Alert: {
    borderRadius: '6px',
    padding: '10px 14px',
  },
  Popconfirm: {
    fontSize: '13px',
  },
  Layout: {
    headerColor: '#ffffff',
    footerColor: '#ffffff',
    color: '#fafafa',
  },
}

// AntD 12 色板，用于机器人着色（取前 8 色）
export const BOT_PALETTE = [
  '#1677ff', // 拂晓蓝
  '#13c2c2', // 明青
  '#52c41a', // 极光绿
  '#faad14', // 金盏花
  '#eb2f96', // 法式洋红
  '#722ed1', // 酱紫
  '#fa541c', // 火山
  '#2f54eb', // 极客蓝
]

// 浅色背景层级（用于精细化色卡）
export const SURFACE = {
  body: '#fafafa',
  card: '#ffffff',
  subtle: '#f5f5f5',
  hoverBlue: '#f0f7ff',
  chipBlue: '#e6f4ff',
  chipBlueText: '#0958d9',
  chipGray: '#f5f5f5',
  chipGrayText: 'rgba(0,0,0,0.65)',
  border: '#f0f0f0',
  borderStrong: '#e8e8e8',
}
